const mongoose = require("mongoose");
const pollsModel = require("../models/communityPolls");
const pollVotesModel = require("../models/communityPollVotes");

// A vote is written twice, on purpose.
//
// The authoritative record is a `community_poll_votes` document, one per
// (poll, user) - the unique index at communityPollVotes.js:35 enforces that -
// so a re-vote updates the existing ballot rather than inserting a second one.
//
// The poll document then gets a denormalised copy in `voters`, alongside the
// `options[].votes_count` and `total_voters` counters it feeds, so that a poll
// and its voters read in one query. The voter entry and the counters always
// move in the *same* updateOne: that is what keeps them from disagreeing, since
// there is no transaction spanning the two collections.
//
// `selected_options` is replaced wholesale on a re-vote, which is why the
// counters move by diffing the old selection against the new one rather than
// just incrementing.
//
// The cost of the copy: `voters` grows by one entry per voter inside the poll
// document, so a poll shares one 16MB BSON budget across all of them. At
// roughly 90 bytes an entry that is on the order of 150k voters - fine for a
// community poll, and the ballots collection remains the record that scales.

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

// The payload carries a single `option_id` for a single-choice poll and an
// array for a multi-select one. Returns null for anything unusable so the
// caller can drop the message: a malformed id cannot become valid on a retry.
function readOptionIds(payload) {
  const raw =
    payload.selected_options ?? payload.option_ids ?? payload.option_id;
  if (raw === undefined || raw === null) return null;

  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) return null;
  if (!list.every((id) => mongoose.Types.ObjectId.isValid(id))) return null;

  // Sorted so a stored ballot round-trips to the same array, which is what
  // makes the old selection usable as an optimistic-concurrency guard below.
  return [...new Set(list.map(String))].sort();
}

function sameSelection(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Both sides of the counter diff move in one update: `$[add]` covers the newly
// picked options and `$[rem]` the abandoned ones. An identifier that matches
// nothing is a no-op, but Mongo rejects one that is declared and never used, so
// the update document is built to match only the filters actually needed.
function buildCounterDiff({ added, removed }) {
  const inc = {};
  const arrayFilters = [];

  if (added.length) {
    inc["options.$[add].votes_count"] = 1;
    arrayFilters.push({ "add._id": { $in: added.map(toObjectId) } });
  }
  if (removed.length) {
    inc["options.$[rem].votes_count"] = -1;
    // Same guard as the response counters: never take a count below zero.
    arrayFilters.push({
      "rem._id": { $in: removed.map(toObjectId) },
      "rem.votes_count": { $gt: 0 },
    });
  }
  return { inc, arrayFilters };
}

function voterEntry({ userId, selected, now }) {
  return {
    user_id: toObjectId(userId),
    selected_options: selected.map(toObjectId),
    edited_count: 0,
    voted_at: now,
  };
}

// What has to be added to, and taken off, the option counts to move a voter
// from `from` to `to`. Both arrays are sorted and deduped.
function diffSelections(from, to) {
  return {
    added: to.filter((id) => !from.includes(id)),
    removed: from.filter((id) => !to.includes(id)),
  };
}

// A first vote: append the voter and move the counts in the same update, so a
// voter entry never exists without its votes having been counted.
//
// `voters.user_id: { $ne: ... }` is what makes this safe to retry. The queue
// delivers at least once and the ballot insert may already have succeeded on an
// earlier attempt, so without the guard a redelivery would append a second
// entry for the same voter and count their vote twice.
async function recordFreshVoter({ pollId, userId, selected, now }) {
  const { inc, arrayFilters } = buildCounterDiff({
    added: selected,
    removed: [],
  });
  inc.total_voters = 1;

  const result = await pollsModel.updateOne(
    { _id: pollId, "voters.user_id": { $ne: toObjectId(userId) } },
    { $inc: inc, $push: { voters: voterEntry({ userId, selected, now }) } },
    { arrayFilters },
  );
  return result.modifiedCount > 0;
}

// A re-vote: replace the voter's picks and move only the difference.
// `total_voters` does not change - the same person is still one voter.
//
// `expected` is the voter's picks as the poll currently holds them, i.e. the
// picks the counter diff was computed from. Requiring the entry to still match
// them is what makes this idempotent: a retry, or a racer that got here second,
// finds the entry already moved on, matches nothing, and applies neither the
// `$set` nor the `$inc`. Guarding at the document filter rather than in the
// array filter is deliberate - `$[add]` / `$[rem]` are independent of `$[v]`,
// so a guard inside the array filter would still let the counts move twice.
async function recordVoterRevision({
  pollId,
  userId,
  selected,
  added,
  removed,
  editedCount,
  expected,
  now,
}) {
  const { inc, arrayFilters } = buildCounterDiff({ added, removed });
  const uid = toObjectId(userId);
  const update = {};
  if (Object.keys(inc).length) update.$inc = inc;

  const filter = {
    _id: pollId,
    voters: { $elemMatch: { user_id: uid, selected_options: expected } },
  };
  // `edited_count` is set to the ballot's value, never incremented here: the
  // ballot is the source of truth for it, and setting keeps this update
  // idempotent - a repeat writes the same number rather than climbing.
  update.$set = {
    "voters.$[v].selected_options": selected.map(toObjectId),
    "voters.$[v].edited_count": editedCount,
    "voters.$[v].edited_at": now,
  };
  arrayFilters.push({ "v.user_id": uid });

  const result = await pollsModel.updateOne(filter, update, { arrayFilters });
  return result.modifiedCount > 0;
}

// `voters` is projected through $elemMatch rather than whole: the array holds
// an entry per voter on the poll and only this voter's is needed here.
function readPollForVoter(pollId, userId) {
  return pollsModel
    .findOne(
      { _id: pollId },
      {
        options: 1,
        edit_count: 1,
        voters: { $elemMatch: { user_id: toObjectId(userId) } },
      },
    )
    .lean();
}

async function reviseBallot({ poll, existing, next, pollId, context }) {
  const current = (existing.selected_options || []).map(String).sort();
  const userId = String(existing.user_id);

  // The poll's copy of this voter, as projected by the $elemMatch above.
  const entry = (poll.voters || [])[0] || null;
  const pollPicks = entry
    ? (entry.selected_options || []).map(String).sort()
    : null;

  // The queue delivers at least once, so the same ballot can arrive twice.
  // Rewriting it would spend the user's one allowed edit on a change they
  // never made, so an unchanged selection does not touch the ballot.
  if (sameSelection(current, next)) {
    // It is not necessarily a plain redelivery, though: this is also what a
    // retry looks like when the ballot write landed and the poll write did not.
    // The vote has to end up in both collections, so the poll is checked rather
    // than assumed before the message is dropped.
    if (entry && sameSelection(pollPicks, next)) {
      context.log(
        `Poll vote unchanged for user ${userId} on poll ${pollId}, skipping`,
      );
      return null;
    }

    if (!entry) {
      // Nothing readable here says whether this ballot's votes were already
      // counted - a ballot written before `voters` existed looks exactly like
      // one whose poll write was lost - so counting it now could double it.
      // scripts/reconcilePollVotes.js recomputes from the ballots and is the
      // repair that cannot get this wrong.
      context.warn(
        `Poll ${pollId} has no voter entry for user ${userId} but the ballot exists;`,
        `run scripts/reconcilePollVotes.js to repair`,
      );
      return null;
    }

    context.warn(
      `Poll ${pollId} was behind the ballot for user ${userId}, reconciling its counts`,
    );
    const repair = diffSelections(pollPicks, next);
    await recordVoterRevision({
      pollId,
      userId,
      selected: next,
      ...repair,
      // The ballot already carries its final count, so the poll is brought up
      // to it rather than moved past it.
      editedCount: Number(existing.edited_count) || 0,
      expected: entry.selected_options,
      now: new Date(),
    });
    return null;
  }

  // `edit_count` on the poll caps revisions and is itself capped at 1
  // (communityPolls.js:50), so in practice this allows one revision.
  const cap = Number.isFinite(poll.edit_count) ? poll.edit_count : 1;
  const edits = Number(existing.edited_count) || 0;
  if (edits >= cap) {
    context.warn(
      `Rejecting poll vote revision for user ${userId} on poll ${pollId}:`,
      `edited_count=${edits} has reached edit_count=${cap}`,
    );
    return null;
  }

  if (!entry) {
    context.warn(
      `Poll ${pollId} has no voter entry for user ${userId} to revise;`,
      `run scripts/reconcilePollVotes.js to repair, then re-send this vote`,
    );
    return null;
  }

  // The poll is written before the ballot because the poll write is the
  // idempotent one - `expected` makes a repeat a no-op - while the ballot's
  // own guard below is what serialises concurrent revisions. In that order a
  // failure between the two leaves the ballot behind the poll, which the
  // unchanged-ballot branch above detects and finishes on the retry.
  const now = new Date();
  const { added, removed } = diffSelections(pollPicks, next);

  const moved = await recordVoterRevision({
    pollId,
    userId,
    selected: next,
    added,
    removed,
    // What the ballot is about to become, one line below.
    editedCount: edits + 1,
    expected: entry.selected_options,
    now,
  });
  if (!moved) {
    context.warn(
      `Poll ${pollId} moved underneath this revision for user ${userId}, skipping`,
    );
    return null;
  }

  // Matching the old selection is the guard: two concurrent revisions read the
  // same ballot, but only the first to write still matches.
  const result = await pollVotesModel.updateOne(
    { _id: existing._id, selected_options: existing.selected_options },
    {
      $set: { selected_options: next.map(toObjectId), edited_at: now },
      $inc: { edited_count: 1 },
    },
  );

  // The poll already moved, so leaving the ballot behind would put the two
  // collections out of step. Throwing hands the message back to the queue,
  // whose retry finds the poll already correct and completes the ballot.
  if (!result.modifiedCount) {
    throw new Error(
      `Poll ${pollId} was updated for user ${userId} but the ballot did not match; retrying`,
    );
  }

  return {
    ballot_id: existing._id,
    poll_id: pollId,
    user_id: userId,
    selected_options: next,
    edited_count: edits + 1,
    added,
    removed,
    fresh: false,
  };
}

async function applyPollVote(payload, context) {
  const pollId = String(payload.poll_id);
  const userId = String(payload.user_id);

  const next = readOptionIds(payload);
  if (!next) {
    context.warn("Skipping poll.vote with no usable option ids:", payload);
    return null;
  }

  const poll = await readPollForVoter(pollId, userId);
  if (!poll) {
    context.warn(`Skipping poll.vote for unknown poll ${pollId}:`, payload);
    return null;
  }

  // A ballot references options by id, so an id that is not on the poll would
  // be a vote for nothing and would leave the counters unmovable.
  const onPoll = new Set((poll.options || []).map((o) => String(o._id)));
  const unknown = next.filter((id) => !onPoll.has(id));
  if (unknown.length) {
    context.warn(
      `Skipping poll.vote with options not on poll ${pollId}:`,
      unknown.join(", "),
    );
    return null;
  }

  const existing = await pollVotesModel
    .findOne(
      { poll_id: pollId, user_id: userId },
      { selected_options: 1, edited_count: 1, user_id: 1 },
    )
    .lean();

  if (existing) {
    return reviseBallot({ poll, existing, next, pollId, context });
  }

  const now = new Date();

  // The poll goes first because that write is idempotent - the `$ne` guard
  // makes a repeat a no-op - whereas an insert is not. So if the ballot insert
  // then fails, the retry redoes the poll harmlessly and completes the ballot;
  // the reverse order would leave a ballot the poll never counted.
  const counted = await recordFreshVoter({ pollId, userId, selected: next, now });
  if (!counted) {
    context.warn(
      `Poll ${pollId} already carried a voter entry for user ${userId}, counts left alone`,
    );
  }

  try {
    const created = await pollVotesModel.create({
      poll_id: pollId,
      user_id: userId,
      selected_options: next.map(toObjectId),
      edited_count: 0,
    });

    return {
      ballot_id: created._id,
      poll_id: pollId,
      user_id: userId,
      selected_options: next,
      edited_count: 0,
      added: next,
      removed: [],
      fresh: true,
    };
  } catch (err) {
    // The unique index caught a first vote racing another writer. The ballot
    // that won is now the one on record, so this message becomes a revision of
    // it - or a no-op, if the winner stored the same selection.
    if (!err || err.code !== 11000) throw err;

    context.warn(
      `Concurrent first vote for user ${userId} on poll ${pollId}, treating as a revision`,
    );
    const raced = await pollVotesModel
      .findOne(
        { poll_id: pollId, user_id: userId },
        { selected_options: 1, edited_count: 1, user_id: 1 },
      )
      .lean();
    if (!raced) return null;

    // The poll was written above, so the copy read at the top of this function
    // is stale and would look as though the voter had no entry. Re-read it.
    const fresh = await readPollForVoter(pollId, userId);
    if (!fresh) return null;

    return reviseBallot({ poll: fresh, existing: raced, next, pollId, context });
  }
}

module.exports = { applyPollVote, recordFreshVoter, recordVoterRevision };
