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

// How many voters the poll caches inline. community_poll_votes holds the full
// roll; this is only what a poll read needs to render "you and A, B and N
// others voted" without a second query. The first VOTERS_CACHE_LIMIT voters
// fill it and it then stays put - see the note in
// storageQueueTriggerPollVoteMongo.js for why it is first-N and not most-recent-N.
const VOTERS_CACHE_LIMIT = 50;

/**
 * A voter and the options they picked, held on the poll itself.
 *
 * The authoritative ballot is still a `community_poll_votes` document; this is
 * a denormalised copy kept next to the counters so "who voted, and for what"
 * reads off the poll without a second query. `user_id` is the key - one entry
 * per voter - and `selected_options` is replaced on a re-vote, in the same
 * update that moves `options[].votes_count`, so the entries and the counts
 * cannot disagree.
 *
 * It is a PARTIAL copy: only the first VOTERS_CACHE_LIMIT voters get an entry.
 * `total_voters` is the real count and can run far ahead of `voters.length`, so
 * nothing may derive a total, a percentage or a "has this user voted" answer
 * from this array - the ballots collection answers those.
 *
 * No `_id`: `user_id` already identifies the entry.
 */
var PollVoterSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },
    // option _ids from this poll's `options` - multi-select
    selected_options: [{ type: Schema.Types.ObjectId, required: true }],
    // mirrors the ballot's `edited_count`; the ballot is the source of truth,
    // so this is set to its value rather than incremented on its own
    edited_count: { type: Number },
    voted_at: { type: Date },
    edited_at: { type: Date },
  },
  { _id: false },
);

var PollSchema = new Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    options: [PollOptionSchema],
    tags: [{ type: String, trim: true }],

    // Read cache of the first VOTERS_CACHE_LIMIT voters. Source of truth is
    // community_poll_votes, and `total_voters` below is the real count.
    voters: [PollVoterSchema],

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

    // Every voter, not just the cached ones: this is what `voters.length` is
    // NOT. It is also the cap check - a vote lands in `voters` only while this
    // is below VOTERS_CACHE_LIMIT.
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
module.exports.VOTERS_CACHE_LIMIT = VOTERS_CACHE_LIMIT;
