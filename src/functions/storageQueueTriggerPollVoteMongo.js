const mongoose = require("mongoose");
const pollsModel = require("../models/communityPolls");
const pollVotesModel = require("../models/communityPollVotes");

// A ballot is one document per (poll, user) - the unique index at
// communityPollVotes.js:35 enforces that - so a re-vote updates the existing
// document rather than inserting a second one. `selected_options` is replaced
// wholesale, which is why the poll's counters have to be moved by diffing the
// old selection against the new one instead of just incrementing.

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

// One update moves both sides of the diff: `$[add]` covers the newly picked
// options and `$[rem]` the abandoned ones. An identifier that matches nothing
// is a no-op, but Mongo rejects one that is declared and never used, so the
// update document is built to match the filters actually needed.
async function adjustPollCounters({ pollId, added, removed, voterDelta }) {
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
  if (voterDelta) inc.total_voters = voterDelta;

  if (!Object.keys(inc).length) return;

  await pollsModel.updateOne(
    { _id: pollId },
    { $inc: inc },
    arrayFilters.length ? { arrayFilters } : {},
  );
}

async function reviseBallot({ poll, existing, next, pollId, context }) {
  const current = (existing.selected_options || []).map(String).sort();

  // The queue delivers at least once, so the same ballot can arrive twice.
  // Rewriting it would spend the user's one allowed edit on a change they
  // never made, so an unchanged selection is a no-op.
  if (sameSelection(current, next)) {
    context.log(
      `Poll vote unchanged for user ${existing.user_id} on poll ${pollId}, skipping`,
    );
    return null;
  }

  // `edit_count` on the poll caps revisions and is itself capped at 1
  // (communityPolls.js:50), so in practice this allows one revision.
  const cap = Number.isFinite(poll.edit_count) ? poll.edit_count : 1;
  const edits = Number(existing.edited_count) || 0;
  if (edits >= cap) {
    context.warn(
      `Rejecting poll vote revision for user ${existing.user_id} on poll ${pollId}:`,
      `edited_count=${edits} has reached edit_count=${cap}`,
    );
    return null;
  }

  // Matching the old selection is the guard: two concurrent revisions read the
  // same document, but only the first to write still matches, so the counter
  // diff is applied exactly once.
  const now = new Date();
  const result = await pollVotesModel.updateOne(
    { _id: existing._id, selected_options: existing.selected_options },
    {
      $set: { selected_options: next.map(toObjectId), edited_at: now },
      $inc: { edited_count: 1 },
    },
  );

  if (!result.modifiedCount) {
    context.warn(
      `Poll vote for user ${existing.user_id} on poll ${pollId} changed underneath this revision, skipping`,
    );
    return null;
  }

  const added = next.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.includes(id));

  // A revision does not change how many people voted, only what they picked.
  await adjustPollCounters({ pollId, added, removed, voterDelta: 0 });

  return {
    ballot_id: existing._id,
    poll_id: pollId,
    user_id: existing.user_id,
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

  const poll = await pollsModel
    .findOne({ _id: pollId }, { options: 1, edit_count: 1 })
    .lean();
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

  try {
    const created = await pollVotesModel.create({
      poll_id: pollId,
      user_id: userId,
      selected_options: next.map(toObjectId),
      edited_count: 0,
    });

    await adjustPollCounters({
      pollId,
      added: next,
      removed: [],
      voterDelta: 1,
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

    return reviseBallot({ poll, existing: raced, next, pollId, context });
  }
}

module.exports = { applyPollVote, adjustPollCounters };
