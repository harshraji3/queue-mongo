var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * A single choice on a poll.
 *
 * `_id` is explicit and required: ballots in `poll_votes.selected_options`
 * reference options by this id
 */
var PollOptionSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, auto: true },
  text: { type: String, required: true, trim: true, maxlength: 300 },
  votes_count: { type: Number, default: 0, min: 0 },
});

var PollSchema = new Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    options: [PollOptionSchema],
    tags: [{ type: String, trim: true }],

    // originator: admin (Phase 1) or user (Phase 2)
    created_by: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "created_by_model",
    },
    created_by_model: {
      type: String,
      enum: ["admin_users", "users"],
      required: true,
    },

    start_date: { type: Date, required: true },
    duration_days: { type: Number, default: 7, min: 1, max: 90 },
    end_date: { type: Date, required: true },

    review_status: {
      type: String,
      enum: ["submitted", "in_review", "approved", "rejected"],
      default: "submitted",
      index: true,
    },
    review_reason: { type: String },
    reviewed_by: { type: Schema.Types.ObjectId, ref: "admin_users" },
    reviewed_at: { type: Date },

    total_voters: { type: Number, default: 0, min: 0 },
    // number of the times users can edit their votes to the poll
    edit_count: { type: Number, default: 1, min: 0, max: 1 },
    // 0 = inactive, 1 = active, 2 = archived
    status: { type: Number, default: 0 },
  },
  { timestamps: true },
);

PollSchema.index({ review_status: 1, start_date: 1, end_date: 1, status: 1 });

module.exports = mongoose.model("community_polls", PollSchema);
