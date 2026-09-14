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
// That copy is capped at VOTERS_CACHE_LIMIT entries. Past the cap a vote is
// still counted and still balloted - only the inline entry is skipped - so
// `total_voters` runs ahead of `voters.length` and the array must never be
// read as the roll. It is the FIRST N voters, not the most recent N: the entry
// is what tells a redelivery that this voter was already counted, so an entry
// that could be evicted would be an entry that could stop doing that job.
// (community_posts caches the most recent N likers instead, because a like row
// carries its own `status` flag to guard the counter - reaction.js:8 - and its
// cache is therefore free to forget.)
//
// `selected_options` is replaced wholesale on a re-vote, which is why the
// counters move by diffing the old selection against the new one rather than
// just incrementing.
//
// Neither collection carries a `version` token like community_posts does. Every
// write here is a single `updateOne` on a single document, and MongoDB
// serialises those, so ordering between concurrent writers needs no optimistic
// token. What the filters guard is *repetition*, not ordering: `$ne` /
// `expected` keep an at-least-once redelivery from counting the same vote
// twice. Set-shaped writes (`$addToSet` below) are repeat-safe by themselves;
// `$inc` never is, so wherever a counter moves, a filter has to gate it.
//
// Past the cap the ballot's `counted_at` replaces the voter entry as the guard.
// It is claimed in its own update before the counters move, so a redelivery
// that finds it set counts nothing. The two are in different collections and so
// cannot be one write: a crash between them leaves the vote balloted and marked
// but uncounted, which scripts/reconcilePollVotes.js repairs. That window is two
// adjacent statements wide and errs towards under-counting, never double.

const { VOTERS_CACHE_LIMIT } = pollsModel;

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

// Whether a poll still has room to cache the next new voter. Read off
// `total_voters`, the real count - `voters.length` stops moving at the cap.
// Only ever a hint: the write filters below re-check it, since the cap can
// close between this read and the update that acts on it.
function hasCacheRoom(poll) {
  return (Number(poll.total_voters) || 0) < VOTERS_CACHE_LIMIT;
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

// A first vote: add the voter and move the counts in the same update, so a
// voter entry never exists without its votes having been counted.
//
// `$addToSet`, not `$push`: `voters` is a set keyed by user, so the write says
// so rather than relying on the filter alone to keep it one. It can express
// that because PollVoterSchema is `{ _id: false }` (communityPolls.js:39) - with
// a generated `_id` every entry would be distinct and `$addToSet` would degrade
// into `$push`. MongoDB applies the whole update under one document-level lock,
// so concurrent first votes serialise here with no read-compare-write and no
// version token to carry.
//
// The `$ne` filter still has to stay, and not as a duplicate of `$addToSet`:
// it is what gates the `$inc`. `$addToSet` skips an entry it already holds, but
// a sibling `$inc` in the same update applies regardless - there is no
// "increment only if the set grew" - so dropping the filter would leave a
// redelivery adding no entry and still counting the vote a second time.
//
// It also gates a case `$addToSet` cannot see: dedupe compares the entire
// subdocument, and `voted_at` is the attempt's own clock, so a redelivery
// arrives with a different timestamp and is not a duplicate by value.
//
// `total_voters: { $lt: VOTERS_CACHE_LIMIT }` puts the cap in the filter rather
// than in an `if` around the call. The count read a moment ago can be stale by
// the time this lands, and an `if` would cache the 51st voter on a poll that
// filled up in between; a filter is evaluated against the document as it
// actually is. A false here means only "no entry was cached" - the caller still
// has to count the vote, which countUncachedVote does.
async function recordFreshVoter({ pollId, userId, selected, now }) {
  const { inc, arrayFilters } = buildCounterDiff({
    added: selected,
    removed: [],
  });
  inc.total_voters = 1;

  const result = await pollsModel.updateOne(
    {
      _id: pollId,
      "voters.user_id": { $ne: toObjectId(userId) },
      total_voters: { $lt: VOTERS_CACHE_LIMIT },
    },
    { $inc: inc, $addToSet: { voters: voterEntry({ userId, selected, now }) } },
    { arrayFilters },
  );
  return result.modifiedCount > 0;
}

// Claims the right to count a ballot whose vote the poll will not cache.
//
// Two updates, in this order, because they are in two collections and no
// filter can span them. The claim goes first: flipping `counted_at` off null
// is what a redelivery loses, so at worst a crash in between leaves a marked
// ballot the counters never took - the poll reads low and reconcile puts it
// back. Counting first and marking after would fail the other way, adding the
// same vote on every retry, and an inflated poll result is the worse lie.
async function countUncachedVote({ pollId, ballotId, selected, now, context }) {
  const claimed = await pollVotesModel.updateOne(
    { _id: ballotId, counted_at: null },
    { $set: { counted_at: now } },
  );
  if (!claimed.modifiedCount) return false;

  const { inc, arrayFilters } = buildCounterDiff({
    added: selected,
    removed: [],
  });
  inc.total_voters = 1;

  const result = await pollsModel.updateOne({ _id: pollId }, { $inc: inc }, { arrayFilters });
  if (!result.modifiedCount) {
    // The poll went missing between the claim and the count. Hand the claim
    // back so a retry can try again rather than stranding an uncounted ballot.
    await pollVotesModel.updateOne({ _id: ballotId }, { $set: { counted_at: null } });
    context.warn(
      `Poll ${pollId} did not take the counters for ballot ${ballotId}; claim released`,
    );
    return false;
  }
  return true;
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
// an entry per cached voter and only this voter's is needed here. An empty
// projection is therefore ambiguous on its own - this voter is new, or the poll
// filled up before they voted - which is what `total_voters` is read for.
function readPollForVoter(pollId, userId) {
  return pollsModel
    .findOne(
      { _id: pollId },
      {
        options: 1,
        edit_count: 1,
        total_voters: 1,
        voters: { $elemMatch: { user_id: toObjectId(userId) } },
      },
    )
    .lean();
}

// Moves the option counters for a revision the poll holds no voter entry for.
// The ballot's own compare-and-set has already serialised this - see the call
// site - so the counters follow it rather than guarding themselves.
async function countUncachedRevision({ pollId, added, removed }) {
  const { inc, arrayFilters } = buildCounterDiff({ added, removed });
  if (!Object.keys(inc).length) return true;

  const result = await pollsModel.updateOne({ _id: pollId }, { $inc: inc }, { arrayFilters });
  return result.modifiedCount > 0;
}

async function reviseBallot({ poll, existing, next, pollId, context }) {
  const current = (existing.selected_options || []).map(String).sort();
  const userId = String(existing.user_id);

  // The poll's copy of this voter, as projected by the $elemMatch above.
  const entry = (poll.voters || [])[0] || null;
  const pollPicks = entry
    ? (entry.selected_options || []).map(String).sort()
    : null;

  // No entry means one of two very different things. Past the cap it is simply
  // how this voter is stored - counted, balloted, not cached - and the ballot's
  // `counted_at` is the marker in its place. Below the cap an entry should be
  // there, and its absence is drift.
  const uncached = !entry && !hasCacheRoom(poll);

  // An uncached ballot with no `counted_at` is a vote that was claimed but
  // never counted - the crash window countUncachedVote documents. Finishing it
  // here is what makes that window self-healing on the next delivery, and it
  // has to happen before the diff below, which assumes the ballot's current
  // selection is what the counters hold.
  if (uncached && !existing.counted_at) {
    context.warn(
      `Ballot for user ${userId} on poll ${pollId} was never counted, counting it now`,
    );
    await countUncachedVote({
      pollId,
      ballotId: existing._id,
      selected: current,
      now: new Date(),
      context,
    });
  }

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

    // Past the cap there is nothing on the poll to compare against and nothing
    // owed to it: the counters moved when the ballot was counted, and the entry
    // is absent by design rather than missing.
    if (uncached) {
      context.log(
        `Poll vote unchanged for user ${userId} on poll ${pollId} (uncached voter), skipping`,
      );
      return null;
    }

    if (!entry) {
      // Below the cap, so an entry was owed. Nothing readable here says whether
      // this ballot's votes were already counted - a ballot written before
      // `voters` existed looks exactly like one whose poll write was lost - so
      // counting it now could double it. scripts/reconcilePollVotes.js
      // recomputes from the ballots and is the repair that cannot get this wrong.
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

  const now = new Date();

  // Past the cap the poll holds no entry to compare-and-set, so the ballot's
  // own guard is the only serialiser and it has to move first. The counters
  // then follow the diff the ballot just committed to. A failure between the
  // two leaves the counters short of the ballot with no marker to detect it -
  // `counted_at` says the vote was counted, not which selection it was counted
  // for - so this is the one path reconcile has to finish rather than the
  // retry. It moves at most one voter's picks.
  if (uncached) {
    const diff = diffSelections(current, next);

    const revised = await pollVotesModel.updateOne(
      { _id: existing._id, selected_options: existing.selected_options },
      {
        $set: { selected_options: next.map(toObjectId), edited_at: now },
        $inc: { edited_count: 1 },
      },
    );
    if (!revised.modifiedCount) {
      context.warn(
        `Ballot for user ${userId} on poll ${pollId} moved underneath this revision, skipping`,
      );
      return null;
    }

    const moved = await countUncachedRevision({ pollId, ...diff });
    if (!moved && (diff.added.length || diff.removed.length)) {
      throw new Error(
        `Ballot for user ${userId} on poll ${pollId} was revised but poll ${pollId} did not take the counters; retrying`,
      );
    }

    return {
      ballot_id: existing._id,
      poll_id: pollId,
      user_id: userId,
      selected_options: next,
      edited_count: edits + 1,
      ...diff,
      fresh: false,
      cached: false,
    };
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
    cached: true,
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
      { selected_options: 1, edited_count: 1, user_id: 1, counted_at: 1 },
    )
    .lean();

  if (existing) {
    return reviseBallot({ poll, existing, next, pollId, context });
  }

  const now = new Date();

  // Which of the two first-vote paths runs is decided by what the write does,
  // not by what the read said: `hasCacheRoom` opens the cached attempt, and
  // recordFreshVoter re-checks the cap in its own filter. A non-null
  // `countedAt` from here on means the counters have already moved.
  let countedAt = null;

  if ((poll.voters || []).length) {
    // An entry with no ballot to match it: the counters moved on an earlier
    // delivery whose ballot insert did not land. Below the cap recordFreshVoter's
    // `$ne` filter would catch this on its own, but at or past the cap that call
    // is skipped and nothing else would - the vote would be counted a second
    // time. Reached by polls that filled up under the old uncapped code, where
    // every voter has an entry.
    context.warn(
      `Poll ${pollId} already carried a voter entry for user ${userId}, counts left alone`,
    );
    countedAt = now;
  } else if (hasCacheRoom(poll)) {
    // The poll goes first because that write is idempotent - the `$ne` guard
    // makes a repeat a no-op - whereas an insert is not. So if the ballot insert
    // then fails, the retry redoes the poll harmlessly and completes the ballot;
    // the reverse order would leave a ballot the poll never counted.
    const cached = await recordFreshVoter({ pollId, userId, selected: next, now });

    if (cached) {
      countedAt = now;
    } else {
      // Two very different reasons the filter could have missed, and guessing
      // costs either a double count or a lost one: this voter is already cached
      // (a redelivery whose ballot insert failed last time, counted already), or
      // the poll filled up between the read and the write (not counted yet).
      // Only the poll can say which.
      const recheck = await readPollForVoter(pollId, userId);
      if (!recheck) {
        context.warn(
          `Poll ${pollId} disappeared while recording the vote for user ${userId}`,
        );
        return null;
      }

      if ((recheck.voters || []).length) {
        context.warn(
          `Poll ${pollId} already carried a voter entry for user ${userId}, counts left alone`,
        );
        // Counted by that earlier delivery, so the ballot is all that is owed.
        countedAt = now;
      } else {
        context.log(
          `Poll ${pollId} is at the ${VOTERS_CACHE_LIMIT}-voter cache cap;`,
          `user ${userId} will be counted and balloted but not cached`,
        );
      }
    }
  }

  try {
    const created = await pollVotesModel.create({
      poll_id: pollId,
      user_id: userId,
      selected_options: next.map(toObjectId),
      edited_count: 0,
      counted_at: countedAt,
    });

    // Past the cap the counters still have to move, and the claim they are
    // gated on needs a ballot to live on - which is why this follows the insert
    // rather than leading it the way the cached path does.
    if (!countedAt) {
      await countUncachedVote({
        pollId,
        ballotId: created._id,
        selected: next,
        now,
        context,
      });
    }

    return {
      ballot_id: created._id,
      poll_id: pollId,
      user_id: userId,
      selected_options: next,
      edited_count: 0,
      added: next,
      removed: [],
      fresh: true,
      cached: Boolean(countedAt),
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
        { selected_options: 1, edited_count: 1, user_id: 1, counted_at: 1 },
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

module.exports = {
  applyPollVote,
  recordFreshVoter,
  recordVoterRevision,
  countUncachedVote,
  VOTERS_CACHE_LIMIT,
};
