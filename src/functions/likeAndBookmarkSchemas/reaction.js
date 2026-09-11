const postsModel = require('../../models/communityPosts');

const { CACHE_LIMIT } = postsModel;

// The join row (community_post_likes / community_bookmarks) is the source of
// truth; the post's *_count and active_* array are caches over it. Nothing here
// reads before it writes or touches `version` - `status` in each filter is what
// makes a redelivered message a no-op instead of a second count.

// Records the reaction. Returns null when the post is gone, so the caller can
// drop the message instead of retrying.
async function addReaction({ joinModel, counterField, cacheField }, postId, userId) {
  let row;
  try {
    // Matches only a row that is not already active, so a match means this
    // message is the one activating it. The upsert covers both shapes the row
    // can be in: absent (first reaction) or status 0 (reacting again).
    row = await joinModel
      .findOneAndUpdate(
        { user_id: userId, post_id: postId, status: { $ne: 1 } },
        { $set: { status: 1 } },
        { upsert: true, new: true, projection: { status: 1, updatedAt: 1 } },
      )
      .lean();
  } catch (error) {
    // The insert hit the unique index on (user_id, post_id): the row is already
    // active, from an earlier delivery or a racer, so it is already counted.
    if (error?.code !== 11000) throw error;
    return { active: true, changed: false, count: null };
  }

  // Counter and cache move together, so the cache can never show a reactor the
  // counter has not counted. $addToSet makes a repeat entry a no-op, and the
  // `status: 1` filter replaces a lookup - the count comes back from the write
  // that moved it rather than from a secondary read.
  const updated = await postsModel
    .findOneAndUpdate(
      { _id: postId, status: 1 },
      {
        $inc: { [counterField]: 1 },
        $addToSet: { [cacheField]: { user_id: userId, status: 1, createdAt: row.updatedAt || new Date() } },
      },
      {
        new: true,
        // Only the entries past the cap, which is all the trim below needs -
        // the array itself would be twenty subdocuments back per reaction.
        projection: { [counterField]: 1, [cacheField]: { $slice: [CACHE_LIMIT, 1] } },
      },
    )
    .lean();

  if (!updated) {
    // No post to count against, so the row goes back to inactive: uncounted,
    // and still not deleted - this collection keeps its history.
    await joinModel.updateOne({ user_id: userId, post_id: postId }, { $set: { status: 0 } });
    return null;
  }

  // $addToSet takes no $slice, so the cap is a second write, and only when the
  // projection says the array outgrew it. `$each: []` drops the oldest entries.
  if ((updated[cacheField] || []).length) {
    await postsModel.updateOne(
      { _id: postId },
      { $push: { [cacheField]: { $each: [], $slice: -CACHE_LIMIT } } },
    );
  }

  return { active: true, changed: true, count: updated[counterField] || 0 };
}

// Withdraws the reaction. Soft delete: the row stays and `status` goes to 0, so
// anything that counts reactors has to filter `status: 1`.
async function removeReaction({ joinModel, counterField, cacheField }, postId, userId) {
  // No upsert on the way down - withdrawing must not create a row - so a null
  // is "nothing active to withdraw": a redelivery, or an un-react with no react.
  const row = await joinModel
    .findOneAndUpdate(
      { user_id: userId, post_id: postId, status: 1 },
      { $set: { status: 0 } },
      { new: true, projection: { status: 1 } },
    )
    .lean();

  if (!row) return { active: false, changed: false, count: null };

  // $pull by user_id, whatever timestamp the entry carries. No `status` filter
  // on the post, since a reaction can be withdrawn from a removed one, and
  // `$gt: 0` keeps a drifted counter off negative.
  const updated = await postsModel
    .findOneAndUpdate(
      { _id: postId, [counterField]: { $gt: 0 } },
      { $inc: { [counterField]: -1 }, $pull: { [cacheField]: { user_id: userId } } },
      { new: true, projection: { [counterField]: 1 } },
    )
    .lean();

  if (updated) return { active: false, changed: true, count: updated[counterField] || 0 };

  // The counter was already 0 or the post is gone, but a cache entry would
  // still show the user as an active reactor. Pull it on its own.
  await postsModel.updateOne({ _id: postId }, { $pull: { [cacheField]: { user_id: userId } } });
  return { active: false, changed: true, count: null };
}

module.exports = { addReaction, removeReaction };
