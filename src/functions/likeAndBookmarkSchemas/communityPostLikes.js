var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * A user's like on an OncoCommunity post. Join collection, one row per
 * (user, post) pair for the lifetime of that pair.
 *
 * Unliking flips `status` to 0; it never deletes the row. That keeps like/unlike
 * history and makes both operations idempotent under the unique index below —
 * a repeated like cannot insert a second row, and the counter on
 * `community_posts.total_likes_count` moves only when `status` actually changed.
 *
 * Any script that reconciles total_likes_count must
 * therefore count `{ status: 1 }` here, not every row.
 */
var CommunityPostLikesSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },
    post_id: { type: Schema.Types.ObjectId, ref: "community_posts", required: true },
    status: { type: Number, default: 1 },
    // optimistic-concurrency token — see helper/community/concurrency.js
    version: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// A user can hold only one like row per post — this is what makes concurrent
// like calls collapse to a single like instead of racing the counter.
CommunityPostLikesSchema.index({ user_id: 1, post_id: 1 }, { unique: true });
// "who liked this post", newest first
CommunityPostLikesSchema.index({ post_id: 1, createdAt: -1 });

module.exports = mongoose.model("community_post_likes", CommunityPostLikesSchema);
