var mongoose = require("mongoose");
var Schema = mongoose.Schema;

// Digital Opinion Leader (DOL) profile — the person a conversations post is
// attributed to. Extracted out of each post's metadata so a profile is defined
// once and reused across many posts (admin selects one from a dropdown).
var ConversationsDolSchema = new Schema(
  {
    name: { type: String, required: true },
    x_profile: { type: String },
    linkedin_profile: { type: String },
    cancer_type: { type: String },
    affiliation: { type: String },
    location: { type: String },
    country: { type: String },
    status: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("conversations_dol", ConversationsDolSchema);
