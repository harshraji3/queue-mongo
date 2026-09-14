var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * User's ballot on a poll — the record of who voted for what.
 *
 * One document per (poll, user), not per selection: `selected_options` holds
 * every option the user picked, since a voter may choose more than one
 *
 * User can revise their ballot once after submitting; `edited_count`
 * tracks that (0 = original, 1,2,..edit_count = revised, further edits rejected).
 * The poll's `options[].votes_count` / `total_voters` are kept in sync by the
 * controller.
 */
var PollVoteSchema = new Schema(
  {
    poll_id: {
      type: Schema.Types.ObjectId,
      ref: "community_polls",
      required: true,
    },
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },

    // option _ids from community_polls.options — multi-select
    selected_options: [{ type: Schema.Types.ObjectId, required: true }],

    // number of times the user has edited their vote, should be < community_polls.edit_count
    edited_count: { type: Number },
    edited_at: { type: Date },

    // When this ballot's votes were added to the poll's counters.
    //
    // Below VOTERS_CACHE_LIMIT the poll's own `voters` entry is the marker that
    // the counters already moved, and the queue handler filters on it. Past the
    // cap there is no entry to filter on, so this takes over: it is claimed in
    // its own update before the counters move, and a redelivery that finds it
    // already set counts nothing. Null means "not counted yet" and is a state
    // the handler completes on the next delivery.
    counted_at: { type: Date, default: null },
  },
  { timestamps: true },
);

// one ballot per user per poll
PollVoteSchema.index({ poll_id: 1, user_id: 1 }, { unique: true });
// "who voted on this poll" / result breakdowns
PollVoteSchema.index({ poll_id: 1, selected_options: 1 });

module.exports = mongoose.model("community_poll_votes", PollVoteSchema);
