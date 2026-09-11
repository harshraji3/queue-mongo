const conversationsPostsModel = require("../models/conversationsPosts");
const conversationsPostLikesModel = require("../models/conversationsPostLikes");

// The "found interesting" reaction on a Conversations (Explore) post - what
// reaction.js does for community likes, minus the cache array, since the post
// caches only users_interested_count. Nothing reads before it writes: `status`
// in each filter is what makes a redelivered message a no-op.

// One divergence to know about: this soft-deletes, while the API hard-deletes
// and re-likes with $setOnInsert, so a row deactivated here cannot be re-liked
// through ConversationsController until that upsert flips status back. Reads
// are fine - getPosts already resolves is_liked with `status: 1`.

// Message: { event, post_id, user_id }, event being explore.interest.create or
// .delete. A bare "explore.interest" works too, direction read off the payload.
const INTEREST_EVENTS = {
  "explore.interest.create": true,
  "explore.interest.delete": false,
};

const TRUTHY = new Set(["create", "add", "interested", "true", "1"]);
const FALSY = new Set(["delete", "remove", "uninterested", "false", "0"]);

// true to record the reaction, false to remove it, null when the message says
// neither - the caller drops those, since no retry can make them decidable.
function readInterestAction(payload) {
  if (!payload) return null;

  const byEvent = INTEREST_EVENTS[payload.event];
  if (byEvent !== undefined) return byEvent;

  // `status` is last: it is the like row's own field, so a message carrying the
  // row verbatim still resolves (1 = interested, 0 = not).
  const raw =
    payload.action ?? payload.is_interested ?? payload.is_liked ?? payload.status;
  if (typeof raw === "boolean") return raw;
  if (raw === undefined || raw === null) return null;

  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return null;
}

// Records the reaction. Returns null when the post is gone, so the caller can
// drop the message instead of retrying.
async function addInterest(payload, context) {
  const postId = String(payload.post_id);
  const userId = String(payload.user_id);

  let previous;
  try {
    // $set, not $setOnInsert: the row may already exist at status 0, and
    // $setOnInsert would match it and leave it there. The pre-image is the
    // answer - null means inserted, status 1 means it was already active.
    previous = await conversationsPostLikesModel
      .findOneAndUpdate(
        { user_id: userId, post_id: postId },
        { $set: { status: 1 } },
        { upsert: true, new: false, projection: { status: 1 } },
      )
      .lean();
  } catch (error) {
    // Two upserts raced and the unique index rejected this one. The row now
    // exists, so the same write without the upsert settles the message.
    if (error?.code !== 11000) throw error;
    previous = await conversationsPostLikesModel
      .findOneAndUpdate(
        { user_id: userId, post_id: postId },
        { $set: { status: 1 } },
        { new: false, projection: { status: 1 } },
      )
      .lean();
  }

  if (previous && previous.status === 1) {
    context.log(
      `User ${userId} already found conversations post ${postId} interesting - counter left alone.`,
    );
    return { active: true, changed: false, count: null };
  }

  // The row goes first: incrementing first would count again on every
  // redelivery, since nothing in that update can see the row. `status: 1` is a
  // filter rather than a lookup, so the count comes back from the write that
  // moved it rather than from a secondary read.
  const post = await conversationsPostsModel
    .findOneAndUpdate(
      { _id: postId, status: 1 },
      { $inc: { users_interested_count: 1 } },
      { new: true, projection: { users_interested_count: 1 } },
    )
    .lean();

  if (!post) {
    // No post to count against, so `status` goes back to what the pre-image
    // says - 0 either way, since an uncounted reaction must not read as active.
    // Nothing in this collection is ever hard-deleted.
    await conversationsPostLikesModel.updateOne(
      { user_id: userId, post_id: postId },
      { $set: { status: previous ? previous.status : 0 } },
    );
    context.warn(
      `Conversations post ${postId} not found or removed - dropping ${payload.event} and deactivating its row.`,
    );
    return null;
  }

  return { active: true, changed: true, count: post.users_interested_count || 0 };
}

// Withdraws the reaction. Soft delete: the row stays and `status` goes to 0, so
// anything that counts interested users has to filter `status: 1`.
async function removeInterest(payload, context) {
  const postId = String(payload.post_id);
  const userId = String(payload.user_id);

  // `status: 1` is the whole guard, and no upsert - withdrawing must not create
  // a row. A null is "nothing active to withdraw": a redelivery, or an
  // un-react that never had a react.
  const withdrawn = await conversationsPostLikesModel
    .findOneAndUpdate(
      { user_id: userId, post_id: postId, status: 1 },
      { $set: { status: 0 } },
      { new: false, projection: { status: 1 } },
    )
    .lean();

  if (!withdrawn) {
    context.log(
      `No active interest row for user ${userId} on conversations post ${postId} - nothing to withdraw.`,
    );
    return { active: false, changed: false, count: null };
  }

  // No `status` filter on the post, matching unlikePost: a reaction can be
  // withdrawn from a removed post and the counter should still come down.
  // `$gt: 0` keeps a drifted counter off negative.
  const post = await conversationsPostsModel
    .findOneAndUpdate(
      { _id: postId, users_interested_count: { $gt: 0 } },
      { $inc: { users_interested_count: -1 } },
      { new: true, projection: { users_interested_count: 1 } },
    )
    .lean();

  if (!post) {
    context.warn(
      `Withdrew the interest row for user ${userId} but conversations post ${postId} had no count to decrement.`,
    );
    return { active: false, changed: true, count: null };
  }

  return { active: false, changed: true, count: post.users_interested_count || 0 };
}

// Shared with storageQueueTriggerPostAndCommentMongo, which handles the
// explore.interest events arriving on the post/comment queue.
module.exports = { addInterest, removeInterest, readInterestAction, INTEREST_EVENTS };
