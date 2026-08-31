var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * A user's private bookmark ("Saved") of an OncoCommunity post. Same shape and
 * same status-flip semantics as community_post_likes — see the note there.
 *
 * Bookmarks are private: nothing is surfaced to the post's author, and
 * `community_posts.bookmarks_count` is maintained for the owner's own list, not
 * as a public number on the feed.
 */
var CommunityBookmarksSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },
    post_id: { type: Schema.Types.ObjectId, ref: "community_posts", required: true },
    status: { type: Number, default: 1 },
    // optimistic-concurrency token — see helper/community/concurrency.js
    version: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One bookmark row per (user, post) — makes bookmarking idempotent.
CommunityBookmarksSchema.index({ user_id: 1, post_id: 1 }, { unique: true });
// "my bookmarks", newest-SAVED first — the sort is on this row's createdAt, not
// the post's, so re-saving an old post puts it at the top of the list.
//
// Specced shape, kept deliberately. Note what it does not cover: the §2.5
// query also filters `status: 1`, which becomes a residual filter, and the keyset
// cursor sorts on { createdAt, _id }, which this index cannot satisfy — so that
// query carries an in-memory SORT stage. §5's no-SORT assertion does not apply
// to it.
CommunityBookmarksSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model("community_bookmarks", CommunityBookmarksSchema);
