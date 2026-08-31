const postsModel = require('../../models/communityPosts');

const { CACHE_LIMIT } = postsModel;

// The join collection is the source of truth and flips status;
// the post's active_* array is a cache of the most recent CACHE_LIMIT active
// entries; the *_count field is a counter. Counts come back from the write
// itself because the India/Europe regions read from secondaries.
async function toggleReaction({ joinModel, postId, userId, counterField, cacheField, on }) {
  const nextStatus = on ? 1 : 0;
  const filter = { user_id: userId, post_id: postId };
  const update = { $set: { status: nextStatus }, $currentDate: { version: true } };

  let previous;
  try {
    // upsert only when turning ON — un-reacting must not create a row
    previous = await joinModel.findOneAndUpdate(filter, update, { upsert: on, new: false }).lean();
  } catch (error) {
    // two concurrent upserts: the unique index lets one win, the loser retries
    if (error?.code !== 11000) throw error;
    previous = await joinModel.findOneAndUpdate(filter, update, { new: false }).lean();
  }

  const changed = previous ? previous.status !== nextStatus : on;
  if (!changed) return readCount(postId, counterField, on);

  if (on) {
    const entry = { user_id: userId, status: 1, createdAt: new Date() };
    const updated = await postsModel
      .findOneAndUpdate(
        { _id: postId },
        {
          $inc: { [counterField]: 1 },
          $push: { [cacheField]: { $each: [entry], $slice: -CACHE_LIMIT } },
        },
        { new: true, projection: { [counterField]: 1 } },
      )
      .lean();
    return updated ? { active: true, count: updated[counterField] || 0 } : null;
  }

  await postsModel.updateOne({ _id: postId }, { $pull: { [cacheField]: { user_id: userId } } });
  const updated = await postsModel
    .findOneAndUpdate(
      { _id: postId, [counterField]: { $gt: 0 } },
      { $inc: { [counterField]: -1 } },
      { new: true, projection: { [counterField]: 1 } },
    )
    .lean();
  if (updated) return { active: false, count: updated[counterField] || 0 };
  return readCount(postId, counterField, false);
}

async function readCount(postId, counterField, active) {
  const post = await postsModel.findOne({ _id: postId }, { [counterField]: 1 }).lean();
  return post ? { active, count: post[counterField] || 0 } : null;
}

module.exports = { toggleReaction };
