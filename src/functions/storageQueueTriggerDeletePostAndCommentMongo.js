const { app } = require('@azure/functions');
const { connectMongo } = require('../mongo');
const postsModel = require('../models/communityPosts');
const usersModel = require('../models/users');

// The queue can hand us either a parsed object or the raw JSON string,
// depending on how the message was written.
function parseMessage(message) {
    if (typeof message === 'string') {
        return JSON.parse(message);
    }
    if (Buffer.isBuffer(message)) {
        return JSON.parse(message.toString('utf8'));
    }
    return message;
}

function parseHashtags(body) {
  if (!body) return [];
  const found = new Set();
  const pattern = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]{1,50})/gu;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    found.add(match[1].toLowerCase());
    if (found.size >= MAX_HASHTAGS) break;
  }
  return [...found];
}


function resolveReplyPosition(parent) {
  return {
    parent_post_id: parent._id,
    parent_user_id: parent.user_id,
    root_post_id: parent.root_post_id || parent._id,
    depth: (parent.depth || 0) + 1,
  };
}
async function adjustResponseCounts({ postId, parentPostId, rootPostId, delta }) {
  const self = postId ? String(postId) : null;
  const ids = [...new Set([parentPostId, rootPostId].filter(Boolean).map(String))].filter((id) => id !== self);
  if (!ids.length) return;

  const filter = delta > 0 ? { _id: { $in: ids } } : { _id: { $in: ids }, responses_count: { $gt: 0 } };
  await postsModel.updateMany(filter, { $inc: { responses_count: delta } });
}

function authorProjection(userId) {
  return usersModel
    .findOne({ _id: userId }, "first_name last_name organisation speciality")
    .populate("speciality", "speciality_name")
    .lean();
}

const MAX_DISPLAY_DEPTH = 2;

function displayDepth(depth) {
  const level = Number(depth) || 0;
  return level < MAX_DISPLAY_DEPTH ? level : MAX_DISPLAY_DEPTH;
}

app.storageQueue('storageQueueTriggerDeletePostAndCommentMongo', {
    queueName: 'conversation-delete-post-mongodb-v1',
    connection: 'likequeuetestv1_STORAGE',
    handler: async (message, context) => {
        context.log('Queue item received:', message);

        try {
            // Verifies the cached connection is still alive and redials if not,
            // so a pool that died between messages doesn't hang the write.
            await connectMongo();

            const payload = parseMessage(message);

            if (!payload || !payload.post_id) {
                context.warn('Skipping message with no post_id:', payload);
                return;
            }

            const postId = payload.post_id;

            console.log('Parsed payload:', payload);
            const post = await postsModel
                .findOne({ _id: postId }, { user_id: 1, status: 1, parent_post_id: 1, root_post_id: 1 })
                .lean();
            if (!post) {
                context.warn('Post cannot be found');
                return;
            }
            if (String(post.user_id) !== String(payload.user_id)) {
                context.warn('You can delete only your post');
                return;
            }

            // `status: 1` is the guard: concurrent deletes both return 200, but only
            // one matches, so counters move exactly once
            const result = await postsModel.updateOne(
                { _id: postId, status: 1 },
                { $set: { status: 0, deleted_at: new Date() }, $currentDate: { version: true } },
            );

            if (result.modifiedCount > 0 && post.parent_post_id){
                await adjustResponseCounts({
                    postId: postId,
                    parentPostId: post.parent_post_id,
                    rootPostId: post.root_post_id,
                    delta: -1,
                })
            }
            
            
        } catch (err) {
            context.error('Error writing post to MongoDB:', err);
            throw err;
        }
    },
});
