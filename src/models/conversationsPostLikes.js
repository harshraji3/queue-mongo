var mongoose = require("mongoose");
var Schema = mongoose.Schema;

// Copy of the API's schema (node-productG-service-v1) - same collection, must
// not drift. Tracks which user liked ("found interesting") which conversations
// post; used to render liked posts on a user's profile.
var ConversationsPostLikesSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "users",
      required: true,
    },
    post_id: {
      type: Schema.Types.ObjectId,
      ref: "conversations_posts_v1",
      required: true,
    },
    status: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true }
);

// A user can like a given post only once.
ConversationsPostLikesSchema.index({ user_id: 1, post_id: 1 }, { unique: true });

module.exports = mongoose.model(
  "conversations_post_likes",
  ConversationsPostLikesSchema
);
