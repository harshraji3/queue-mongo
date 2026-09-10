const conversationsPostsModel = require("../models/conversationsPosts");
const conversationsPostLikesModel = require("../models/conversationsPostLikes");

// The "found interesting" reaction on an OncoPilot Conversations (Explore) post,
// applied to Mongo off the posts queue — the same job applyReaction does for
// community likes and bookmarks.
//
// WHY THIS IS NOT applyReaction:
//
//   * the row lifecycle is the same idea - un-reacting flips `status` to 0
//     rather than removing the row, so the (post, user) pair is written once and
//     lives forever under the unique index - but the post side is not. A
//     community post caches its reactors in `active_likes`, capped at
//     CACHE_LIMIT; a conversations post caches only a number,
//     `users_interested_count`. There is no array to push to or pull from, so
//     nothing here needs the cacheField half of toggleReaction.
//   * there is no bookmark counterpart and no comment depth, so there is nothing
//     to parameterise: one collection, one counter, one row per (post, user).
//     Hence two writers rather than one toggle — the two directions share a
//     message shape, not a write path.
//
// SOFT DELETE, AND WHERE THAT DIVERGES FROM THE API: un-reacting sets `status`
// to 0 here. ConversationsController.unlikePost still hard-deletes the row, and
// its likePost upserts with `$setOnInsert`, which matches a status-0 row and
// leaves it at 0 — so a row this consumer has soft-deleted cannot be re-liked
// through the API until that upsert learns to flip the status back. The read
// path is already fine: getPosts resolves is_liked with `status: 1`, so a
// soft-deleted row correctly reads as not liked.
//
// NOTHING HERE READS BEFORE IT WRITES. Every step is one atomic update whose own
// match result decides the next: a filter that matches nothing is how we learn
// the reaction was already applied or the post is gone, so there is no window
// between a check and the write it guards, and a redelivered message cannot slip
// through one. The row write reports whether it actually changed anything, and
// the counter moves only when it did.
//
// That matters because the producer fires when the request arrives rather than
// off the back of the write (see PushLikesIntoMongoqueue for the same caveat): a
// create for a row that already exists and a delete for a row that was never
// there both have to be no-ops rather than moving the counter.
//
// Expected message on `conversation-posts-mongodb-v1`:
//
//   { "event": "explore.interest.create" | "explore.interest.delete",
//     "post_id": "...", "user_id": "..." }
//
// A bare "explore.interest" is also accepted, in which case the direction is
// read off the payload — `action`, `is_interested` / `is_liked`, or `status`.
const INTEREST_EVENTS = {
  "explore.interest.create": true,
  "explore.interest.delete": false,
};

const TRUTHY = new Set(["create", "add", "interested", "true", "1"]);
const FALSY = new Set(["delete", "remove", "uninterested", "false", "0"]);

// true to record the reaction, false to remove it, null when the message says
// neither — the caller drops those, since no retry can make them decidable.
function readInterestAction(payload) {
  if (!payload) return null;

  const byEvent = INTEREST_EVENTS[payload.event];
  if (byEvent !== undefined) return byEvent;

  // `status` is last: it is the like row's own field, so a message that carries
  // the row verbatim still resolves (1 = interested, 0 = not).
  const raw =
    payload.action ?? payload.is_interested ?? payload.is_liked ?? payload.status;
  if (typeof raw === "boolean") return raw;
  if (raw === undefined || raw === null) return null;

  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return null;
}

// Records the reaction.
//
// One upsert covers both shapes the row can be in, because with soft deletes it
// can already exist: absent (first reaction, so insert) or present at status 0
// (re-reacting, so flip it back to 1). `$set` rather than `$setOnInsert` is what
// makes the second case work — `$setOnInsert` would match the status-0 row and
// leave it there, silently dropping the reaction.
//
// This is the collection's $addToSet: set semantics come from the unique index
// on (user_id, post_id) rather than an array operator, since the reactions are
// documents of their own and not an array on the post. What stands in for
// "$addToSet changed nothing" is the pre-image the write hands back —
// `new: false`, so `previous` is the row as it was. A null means the write
// inserted it and a status of 1 means it was already active, which is the only
// thing allowed to keep the counter still. Same read-your-own-write trick as
// toggleReaction.
//
// The row goes first, and the order is not arbitrary. Incrementing first would
// mean every redelivery of an already-applied create counts a second time, since
// nothing in that update can see the row. This way a redelivery finds the row
// already at status 1 and stops. The cost is the opposite, rarer failure: a
// crash between the two writes leaves an active row the counter never counted,
// and the retry then finds it active and does not correct it.
//
// Returns null when the message names something that isn't there, so the caller
// can drop it instead of retrying.
async function addInterest(payload, context) {
  const postId = String(payload.post_id);
  const userId = String(payload.user_id);

  let previous;
  try {
    previous = await conversationsPostLikesModel
      .findOneAndUpdate(
        { user_id: userId, post_id: postId },
        { $set: { status: 1 } },
        { upsert: true, new: false, projection: { status: 1 } },
      )
      .lean();
  } catch (error) {
    // Two upserts racing for the same pair: the unique index lets one create the
    // row and the loser lands here. The row now exists, so the same write
    // without the upsert both settles this message and reports whether the
    // winner had already made it active.
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

  // `status: 1` is the same filter the controller's likePost checks up front,
  // so the two agree on what a reactable post is — but as a filter rather than
  // a lookup, so the count comes back from the write that moved it. The
  // India/Europe regions read secondaries, which is the other reason not to
  // re-read it afterwards.
  const post = await conversationsPostsModel
    .findOneAndUpdate(
      { _id: postId, status: 1 },
      { $inc: { users_interested_count: 1 } },
      { new: true, projection: { users_interested_count: 1 } },
    )
    .lean();

  if (!post) {
    // No post to count against: it never existed, or it was removed between the
    // request and this message. The row activated above would be a reaction on
    // nothing, so `status` goes back to what the pre-image says it was — 0 for a
    // row that was soft-deleted, and 0 for one this call inserted, since an
    // uncounted reaction on a missing post should not read as active. Nothing in
    // this collection is ever hard-deleted, not even a row written by mistake.
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
// the pair keeps its reaction history and stays re-usable under the unique
// index. Any query that means "who is interested" therefore has to say
// `status: 1` — getPosts already does, and so must anything that recounts
// users_interested_count from this collection.
//
// `status: 1` in the filter is the whole idempotency guard, and it is why this
// is one atomic write rather than a read followed by one: only an active row can
// be withdrawn, so a redelivery, or an un-react that never had a react, matches
// nothing and the counter stays put. No upsert either — withdrawing must never
// bring a row into existence.
//
// No `status` filter on the post, matching unlikePost: a reaction can be
// withdrawn from a post that has since been removed, and the counter should
// still come down. `$gt: 0` keeps a counter that has already drifted from going
// negative, and a post that is genuinely gone simply matches nothing.
async function removeInterest(payload, context) {
  const postId = String(payload.post_id);
  const userId = String(payload.user_id);

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
