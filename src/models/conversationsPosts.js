var mongoose = require("mongoose");
var Schema = mongoose.Schema;

// Copy of the API's schema (node-productG-service-v1) - same collection, must
// not drift. The require is for its side effect: it registers the model
// `dol_id` refs by name, so populating that path cannot throw
// MissingSchemaError mid-message. Same reasoning as models/users.js.
require("./conversationsDol");

var ConversationsPostsSchema = new Schema(
  {
    // embedded link to the original content — the required one: it is what the
    // feed renders and what `source` is derived from. post_link (the plain
    // source URL) is optional and not always available.
    post_embedded_link: { type: String, required: true },
    post_link: { type: String },
    // where the content originated from (ex. LinkedIn, X, etc.)
    source: { type: String },
    // when the content was originally published at the source
    original_published_date: { type: Date },
    // when the content was added into oncopilot
    added_in_oncopilot_date: { type: Date, default: Date.now },
    // type of content e.g. article, video, podcast, publication, etc.
    content_type: { type: String },
    // free-form tags for categorising / filtering posts
    tags: [{ type: String }],
    // Curated taxonomy, typed by the admin team in the CMS. Free text, not refs
    // and not validated against any collection, so a value that exists nowhere
    // else is valid. The user-facing filter lists are aggregated from these
    // fields themselves, so consistent spelling is all that keeps them clean.
    cancer_types: [{ type: String, trim: true }],
    biomarkers: [{ type: String, trim: true }],
    products: [{ type: String, trim: true }],
    keywords: [{ type: String, trim: true }],
    // Digital Opinion Leader this post is attributed to (conversations_dol)
    dol_id: { type: Schema.Types.ObjectId, ref: "conversations_dol" },
    // number of distinct users who found the post interesting
    users_interested_count: { type: Number, default: 0 },
    // free-form metadata (mixed type)
    metadata: { type: Schema.Types.Mixed },
    status: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true },
);

// multikey indexes — serve the admin/user feed filters on these fields
ConversationsPostsSchema.index({ cancer_types: 1 });
ConversationsPostsSchema.index({ biomarkers: 1 });
ConversationsPostsSchema.index({ products: 1 });
ConversationsPostsSchema.index({ keywords: 1 });

module.exports = mongoose.model("conversations_posts_v1", ConversationsPostsSchema);
