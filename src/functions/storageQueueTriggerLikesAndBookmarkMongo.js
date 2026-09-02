const { app } = require('@azure/functions');
const mongoose = require('mongoose');
const { connectMongo } = require('../mongo');
const { toggleReaction } = require('./likeAndBookmarkSchemas/reaction');
const postsModel = require('../models/communityPosts');
const likesModel = require('./likeAndBookmarkSchemas/communityPostLikes');
const bookmarksModel = require('./likeAndBookmarkSchemas/communityBookmarks');
// const { startWatchingLikes } = require('../watchLikes');

// The two reactions, each carrying the same fields the API's
// likePost/unlikePost and bookmarkPost/unbookmarkPost pass to handleToggle.
const LIKE = {
    joinModel: likesModel,
    counterField: 'total_likes_count',
    cacheField: 'active_likes',
    flagName: 'liked',
};

const BOOKMARK = {
    joinModel: bookmarksModel,
    counterField: 'bookmarks_count',
    cacheField: 'active_bookmarks',
    flagName: 'bookmarked',
};

// Message shape:
//   { "event": "<reaction>.create" | "<reaction>.delete",
//     "post_id": "...", "user_id": "..." }
//
// .create and .delete land on the same write path — toggleReaction with `on`
// flipped — because neither join collection deletes a row: un-reacting flips
// status to 0. See the note on community_post_likes.
const REACTIONS = {
    'like.create': { ...LIKE, on: true },
    'like.delete': { ...LIKE, on: false },
    'bookmark.create': { ...BOOKMARK, on: true },
    'bookmark.delete': { ...BOOKMARK, on: false },
};

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

// Applies one reaction to Mongo. Returns null when the message names something
// that isn't there, so the caller can drop it instead of retrying.
async function applyReaction(payload, reaction, context) {
    const { post_id: postId, user_id: userId } = payload;
    const { joinModel, counterField, cacheField, on } = reaction;

    const post = await postsModel.findOne({ _id: postId, status: 1 }, { _id: 1 }).lean();
    if (!post) {
        context.warn(`Post ${postId} not found or removed - dropping ${payload.event}.`);
        return null;
    }

    // Idempotent by construction: toggleReaction only moves the counter and the
    // cached array when `status` actually changed, so a redelivered message
    // re-reads the count instead of double-counting.
    return toggleReaction({ joinModel, postId, userId, counterField, cacheField, on });
}

// app.storageQueue('storageQueueTriggerLikesAndBookmarkMongo', {
//     queueName: 'conversation-likes-mongodb-v1',
//     connection: 'likequeuetestv1_STORAGE',
//     handler: async (message, context) => {
//         context.log('Queue item received:', message);

//         // Queue delivery happens before the first message arrives in a cold
//         // worker, so kick the watcher off here - it only starts once.
//         // await startWatchingLikes(
//         //     (...args) => context.log(...args),
//         //     (...args) => context.error(...args)
//         // );

//         let payload;
//         try {
//             payload = parseMessage(message);
//         } catch (err) {
//             // Unparseable message will never parse on a retry - drop it.
//             context.error('Skipping message that is not valid JSON:', err.message);
//             return;
//         }

//         const reaction = payload && REACTIONS[payload.event];
//         if (!reaction) {
//             context.warn(`Skipping message with unknown event "${payload?.event}":`, payload);
//             return;
//         }

//         // Bad ids are poison: retrying five times and dead-lettering them adds
//         // nothing, so log and drop.
//         if (!mongoose.Types.ObjectId.isValid(payload.post_id)) {
//             context.warn('Skipping message with invalid post_id:', payload);
//             return;
//         }
//         if (!mongoose.Types.ObjectId.isValid(payload.user_id)) {
//             context.warn('Skipping message with invalid user_id:', payload);
//             return;
//         }

//         try {
//             await connectMongo();

//             // const result = await applyReaction(payload, reaction, context);
//             // if (!result) return;

//             // context.log(
//             //     `Applied ${payload.event} for user ${payload.user_id} on post ${payload.post_id}:`,
//             //     `${reaction.flagName}=${result.active} ${reaction.counterField}=${result.count}`
//             // );
//         } catch (err) {
//             // Anything left here is transient (Mongo unreachable, write
//             // conflict) - rethrow so the queue redelivers the message.
//             context.error('Error applying like event to MongoDB:', err);
//             throw err;
//         }
//     },
// });

// Shared with storageQueueTriggerPostAndCommentMongo, which handles the same
// reaction events when they arrive on the post/comment queue.
module.exports = { applyReaction, REACTIONS };
