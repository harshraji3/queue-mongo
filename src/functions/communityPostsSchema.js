var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * OncoCommunity post — a user-authored message or a reply to one.
 *
 * NOT related to `conversations_posts_v1`, which is admin-curated third-party
 * content attributed to Digital Opinion Leaders. That collection is imported
 * through the CMS and has no author in `users`; this one is user-generated and
 * has no admin surface. The two must never be joined or conflated.
 *
 * One collection holds both roots and replies. A post's place in the tree is
 * described by four fields that are always written together and are always
 * derived server-side — never trusted from the client:
 *
 *   parent_post_id  the post being replied to        (unset on a root)
 *   parent_user_id  author of that post              (unset on a root)
 *   root_post_id    the root of the whole thread     (unset on a root)
 *   depth           0 = root, 1 = reply, 2 = reply-to-a-reply
 *
 * `depth` is NOT capped. A reply attaches to the post it replies to at
 * whatever depth that lands, so `parent_post_id` and `parent_user_id` always
 * name the post actually replied to. The read endpoints do the flattening:
 * everything below level 1 is presented at level 2, ordered by time, so the
 * client renders three levels however deep the stored chain runs.
 *
 * Reply counts under that scheme: `responses_count` moves on the direct parent
 * and the root only. A depth-1 post therefore holds its DIRECT child count while
 * the flattened view shows its whole subtree beneath it — the client derives the
 * displayed number from the thread payload, which contains every post.
 *
 * `post_type` duplicates information already carried by `parent_post_id` — it
 * exists because the main feed queries roots by equality on an indexed scalar,
 * which a `parent_post_id: { $exists: false }` predicate cannot do. It is
 * derived from the presence of a parent on create and is not client-settable.
 *
 * Likes and bookmarks are held in BOTH places. `community_post_likes`
 * and `community_bookmarks` are the source of truth and carry the full set; the
 * `active_*` arrays below are a read cache capped at CACHE_LIMIT entries, and
 * the `*_count` fields are denormalised counters. Every like is therefore three
 * writes, and array-vs-collection drift needs its own reconciliation pass
 * alongside the counter check in §5.
 *
 * The cache holds ACTIVE entries only — `$pull` on unlike, `$push`/`$slice` on
 * like. It cannot hold `status: 0` rows: twenty unlikes would otherwise evict
 * every real liker and the cache would show nobody.
 *
 * !! `active_bookmarks` MUST be projected out of every response. Bookmarks
 * are private, and this array puts bookmarker ids on a document that is served
 * to everyone who can see the post. Reads go through the shared public
 * projection; nothing builds its own.
 */
// How many entries each cached array keeps. The collections hold the
// full set; this is only what a feed read needs to render "liked by A, B and N
// others" without a second query.
const CACHE_LIMIT = 20;

// Shape kept as specced. `status` is always 1 in the cache, since inactive rows
// are pulled rather than flipped here.
var CommunityPostReactionSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },
    status: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

var CommunityPostsSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },

    // derived from parent_post_id on create; see the note above
    post_type: { type: String, enum: ["primary", "response"], required: true },

    body: { type: String, required: true, trim: true, maxlength: 2000 },

    // parsed out of body on write: "#Trial" -> "trial". The leading # is stripped.
    hashtags: [{ type: String, lowercase: true, trim: true }],

    // user ids the post @-mentions. Supplied by the client (the compose UI has
    // the picker) and validated against `users` on write — `users` has no
    // handle/username field to resolve free text against. Stored only; nothing
    // consumes it in this phase, so a mention raises no notification.
    mentions: [{ type: Schema.Types.ObjectId, ref: "users" }],

    // interest tags used by the feed's topic filter. Free-text, same treatment
    // as perspective_articles.cancers and conversations_posts_v1.cancer_types.
    tags: [{ type: String, trim: true }],

    // thread position — all four are server-derived, all unset on a root
    parent_post_id: { type: Schema.Types.ObjectId, ref: "community_posts" },
    parent_user_id: { type: Schema.Types.ObjectId, ref: "users" },
    root_post_id: { type: Schema.Types.ObjectId, ref: "community_posts" },
    depth: { type: Number, default: 0 },

    // denormalised counters; source of truth is the join collections and, for
    // responses_count, the posts themselves. responses_count counts ALL
    // descendants on a root (the feed shows one thread total); every other post
    // carries its DIRECT child count — see the note above.
    total_likes_count: { type: Number, default: 0 },
    responses_count: { type: Number, default: 0 },
    bookmarks_count: { type: Number, default: 0 },

    // Read cache of the most recent CACHE_LIMIT likers. Source of truth is
    // community_post_likes.
    active_likes: [CommunityPostReactionSchema],
    // Same, for bookmarks. PRIVATE — must never reach a response.
    active_bookmarks: [CommunityPostReactionSchema],

    // 1 = active, 0 = removed. Posts are soft-deleted and never dropped, so a
    // reply whose parent was removed still renders under a "[removed]" stub.
    status: { type: Number, default: 1 },

    edited_at: { type: Date },
    deleted_at: { type: Date },

    // Optimistic-concurrency token. Read it with the document, send it back in
    // the update filter, and the write lands only if nobody else has written
    // since. See helper/community/concurrency.js — and read the note there about
    // what this does and does NOT guard: the *_count fields above are updated
    // with atomic $inc and deliberately do not bump `version`, so a counter
    // moving does not invalidate an in-flight body edit.
    version: { type: Date, default: Date.now },

    // reserved: no endpoint reads or writes this in this phase
    direct_message: { type: Boolean },
  },
  { timestamps: true },
);

// 1. Main feed — root posts, newest first. The trailing _id matches the
//    { createdAt: -1, _id: -1 } keyset sort so the feed pages without a SORT stage.
CommunityPostsSchema.index({ post_type: 1, status: 1, createdAt: -1, _id: -1 });
// 2. Messages posted by one user (own profile and another user's profile)
CommunityPostsSchema.index({ user_id: 1, post_type: 1, status: 1, createdAt: -1 });
// 3. Whole-thread fetch — every descendant of a root, oldest first
CommunityPostsSchema.index({ root_post_id: 1, status: 1, createdAt: 1 });
// 4. Direct replies to one post (the reply-to-a-reply expansion)
CommunityPostsSchema.index({ parent_post_id: 1, status: 1, createdAt: 1 });
// 5. Interest-based feed filtering
CommunityPostsSchema.index({ tags: 1, status: 1, createdAt: -1 });
// 6. Hashtag pages
CommunityPostsSchema.index({ hashtags: 1, status: 1, createdAt: -1 });

// No text index on `body`. This repo's search layer is Atlas Search
// (src/config/atlasSearchIndexes/), and community search is served by an index
// definition added to that manifest rather than by a second, divergent
// full-text mechanism. See docs/ONCOCOMMUNITY_PHASE0.md.

const CommunityPosts = mongoose.model("community_posts", CommunityPostsSchema);

module.exports = CommunityPosts;
module.exports.CACHE_LIMIT = CACHE_LIMIT;
