const { app } = require('@azure/functions');
const postsModel = require('./communityPostsSchema');
const usersModel = require('./userSchema');

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

app.storageQueue('storageQueueTriggerPostAndCommnetMongo', {
    queueName: 'conversation-posts-mongodb-v1',
    connection: 'likequeuetestv1_STORAGE',
    handler: async (message, context) => {
        context.log('Queue item received:', message);

        try {
            const payload = parseMessage(message);

            if (!payload ) {
                context.warn('Skipping message with no post_id:', payload);
                return;
            }

            console.log('Parsed payload:', payload);
            const { event, parent_post_id: parentPostId, ...doc } = payload;
            console.log('Doc without event field:', doc);
            
            let position = null;
            if (parentPostId) {
                const parent = await postsModel
                    .findOne({ _id: parentPostId, status: 1 }, { user_id: 1, depth: 1, root_post_id: 1 })
                    .lean();
                if (!parent) return context.res.status(404).send("Post being replied to was not found");

                position = resolveReplyPosition(parent);
                Object.assign(doc, position);
            }
            
            const created = await postsModel.create(doc);

            if (position) {
                await adjustResponseCounts({
                    postId: created._id,
                    parentPostId: position.parent_post_id,
                    rootPostId: position.root_post_id,
                    delta: 1,
                });
            }
            // built from the write plus one author lookup: a read straight after an
            // insert can miss on the secondary-reading regions
            const userId = doc.user_id;
            const author = await authorProjection(userId);
            const { active_bookmarks, ...post } = created.toObject();

            context.log('Post written to MongoDB successfully:', {
                post_id: post._id,
                parent_post_id: post.parent_post_id || null,
                root_post_id: post.root_post_id || null,
                display_depth: displayDepth(post.depth),
                author_id: author ? author._id : null,
            });

            return {
                success: true,
                message: 'Post created successfully',
                post: {
                    ...post,
                    user_id: author || null,
                    display_depth: displayDepth(post.depth),
                    liked_by_me: false,
                    bookmarked_by_me: false,
                },
            };
        } catch (err) {
            context.error('Error writing post to MongoDB:', err);
            throw err;
        }
    },
});
