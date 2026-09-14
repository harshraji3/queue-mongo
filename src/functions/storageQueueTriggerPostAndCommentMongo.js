const { app } = require("@azure/functions");
const mongoose = require("mongoose");
const { connectMongo } = require("../mongo");
const postsModel = require("../models/communityPosts");
const usersModel = require("../models/users");
const { REACTIONS } = require("./storageQueueTriggerLikesAndBookmarkMongo");
const { addReaction, removeReaction } = require("./likeAndBookmarkSchemas/reaction");
const { deletePost } = require("./storageQueueTriggerDeletePostAndCommentMongo");
const { applyPollVote } = require("./storageQueueTriggerPollVoteMongo");
const {
  addInterest,
  removeInterest,
  readInterestAction,
} = require("./storageQueueTriggerConversationsInterestMongo");

// Derivation of a post's stored fields from the request. See
// docs/ONCOCOMMUNITY_PHASE2.md for why each rule is what it is.
const MAX_HASHTAGS = 20;
const MAX_MENTIONS = 20;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 60;

// The queue can hand us either a parsed object or the raw JSON string,
// depending on how the message was written.
function parseMessage(message) {
  if (typeof message === "string") {
    return JSON.parse(message);
  }
  if (Buffer.isBuffer(message)) {
    return JSON.parse(message.toString("utf8"));
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
  const ids = [...new Set([parentPostId, rootPostId].filter(Boolean).map(String))].filter(
    (id) => id !== self,
  );
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

async function resolveMentions(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const ids = [...new Set(raw.filter((id) => mongoose.Types.ObjectId.isValid(id)).map(String))].slice(
    0,
    MAX_MENTIONS,
  );
  if (!ids.length) return [];

  const found = await usersModel.find({ _id: { $in: ids }, status: 1 }, { _id: 1 }).lean();
  return found.map((u) => u._id);
}

// Free text, no vocabulary check.
function normaliseTags(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const seen = new Set();
  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    const clean = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (clean) seen.add(clean);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

app.storageQueue("storageQueueTriggerPostAndCommentMongo", {
  queueName: "conversation-posts-mongodb-v1",
  connection: "likequeuetestv1_STORAGE",
  handler: async (message, context) => {
    context.log("Queue item received:", message);

    try {
      // Verifies the cached connection is still alive and redials if not,
      // so a pool that died between messages doesn't hang the write.
      await connectMongo();

      const payload = parseMessage(message);

      if (!payload) {
        context.warn("Skipping message with no post_id:", payload);
        return;
      }

      switch (payload.event) {
        case "post.create":
        case "comment.create":
          console.log("Parsed payload:", payload);
          const { event, parent_post_id: parentPostId, ...items } = payload;
          console.log("Doc without event field:", items);

          // Only creates land in this queue handler; anything else (edits,
          // deletes, unknown events) is acked and dropped.

          const doc = {
            user_id: items.user_id,
            post_type: items.post_type,
            body: items.body,
            hashtags: parseHashtags(items.body),
            mentions: await resolveMentions(items.body.mentions),
            tags: normaliseTags(items.body.tags),
            depth: 0,
          };

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

          console.log("Post written to MongoDB successfully:", {
            post_id: post._id,
            parent_post_id: post.parent_post_id || null,
            root_post_id: post.root_post_id || null,
            display_depth: displayDepth(post.depth),
            author_id: author ? author._id : null,
          });

          break;
        case "like.create":
        case "like.delete":
        case "bookmark.create":
        case "bookmark.delete":
          const reaction = payload && REACTIONS[payload.event];
          if (!reaction) {
            console.error(`Skipping message with unknown event "${payload?.event}":`, payload);
            return;
          }
          // Bad ids are poison: retrying five times and dead-lettering them adds
          // nothing, so log and drop.
          if (!mongoose.Types.ObjectId.isValid(payload.post_id)) {
            console.error("Skipping message with invalid post_id:", payload);
            return;
          }
          if (!mongoose.Types.ObjectId.isValid(payload.user_id)) {
            console.error("Skipping message with invalid user_id:", payload);
            return;
          }

          // Two writers, not one toggle: `on` off the event name picks which.
          const result = reaction.on
            ? await addReaction(reaction, payload.post_id, payload.user_id)
            : await removeReaction(reaction, payload.post_id, payload.user_id);
          // A null is a post that is gone or removed - addReaction has already
          // put the row back the way it found it, so there is nothing to retry.
          if (!result) {
            console.error(
              `Post ${payload.post_id} not found or removed - dropped ${payload.event}.`,
            );
            return;
          }
          // A null count is a write that changed nothing, so no update handed
          // one back - and re-reading it just to log it is a query for nothing.
          console.log(
            `Applied ${payload.event} for user ${payload.user_id} on post ${payload.post_id}:`,
            `${reaction.flagName}=${result.active} changed=${result.changed}`,
            `${reaction.counterField}=${result.count ?? "unchanged"}`,
          );
          break;

        case "post.delete":
          if (!payload || !payload.post_id) {
            console.error("Skipping message with no post_id:", payload);
            return;
          }
          const deleteresult = deletePost(payload);
          console.log("result after delete", deleteresult);
          break;

        case "poll.vote": {
          // Bad ids are poison here too: retrying cannot make them valid. The
          // option ids are checked inside applyPollVote, which also has to
          // verify they belong to the poll.
          const invalid = ["poll_id", "user_id"].find(
            (field) => !mongoose.Types.ObjectId.isValid(payload[field]),
          );
          if (invalid) {
            console.error(`Skipping poll.vote with invalid ${invalid}:`, payload);
            return;
          }

          const vote = await applyPollVote(payload, context);
          // A null means applyPollVote already logged why it declined to write
          // (unchanged ballot, edit cap reached, unknown poll or option).
          if (!vote) return;
          // `cached` says whether the poll kept an inline `voters` entry for
          // this voter. False past the cache cap - the vote is still counted
          // and still balloted, so this is normal on a busy poll, not a fault.
          console.log(
            `Stored poll vote for user ${vote.user_id} on poll ${vote.poll_id}:`,
            `selected_options=[${vote.selected_options.join(", ")}]`,
            `edited_count=${vote.edited_count} added=${vote.added.length} removed=${vote.removed.length}`,
            `cached=${vote.cached}`,
          );
          break;
        }
        // The "found interesting" reaction on a Conversations (Explore) post.
        // A different pair of collections from the community like above -
        // conversations_post_likes and conversations_posts_v1 - so it gets its
        // own writer rather than another entry in REACTIONS.
        case "explore.interest.create":
        case "explore.interest.delete":
        case "explore.interest": {
          // Bad ids and an undecidable direction are both poison: no retry can
          // make an invalid ObjectId valid, or tell us whether the user was
          // reacting or un-reacting.
          const badId = ["post_id", "user_id"].find(
            (field) => !mongoose.Types.ObjectId.isValid(payload[field]),
          );
          if (badId) {
            console.error(`Skipping ${payload.event} with invalid ${badId}:`, payload);
            return;
          }

          const on = readInterestAction(payload);
          if (on === null) {
            console.error(
              `Skipping ${payload.event} that names neither create nor delete:`,
              payload,
            );
            return;
          }

          // Two writers, not one toggle: the directions share this message
          // shape but not a write path.
          const interest = on
            ? await addInterest(payload, context)
            : await removeInterest(payload, context);
          // A null means the writer already logged why it declined to write
          // (the post is gone or removed).
          if (!interest) return;
          // A null count is a write that changed nothing, so no update handed
          // one back - and re-reading it just to log it is a query for nothing.
          console.log(
            `Applied ${payload.event} for user ${payload.user_id} on conversations post ${payload.post_id}:`,
            `interested=${interest.active} changed=${interest.changed}`,
            `users_interested_count=${interest.count ?? "unchanged"}`,
          );
          break;
        }
        default:
          console.error("Skipping message with unsupported event:", payload.event);
          return;
      }
    } catch (err) {
      console.error("Error writing post to MongoDB:", err);
      throw err;
    }
  },
});
