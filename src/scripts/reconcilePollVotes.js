// Recomputes every poll's vote state from the ballots, which are the record of
// who voted for what. `community_polls.voters`, `options[].votes_count` and
// `total_voters` are all derived, so this rebuilds them from scratch rather
// than adjusting them - which makes it safe to run repeatedly, and safe to run
// on data written before `voters` existed.
//
// Reach for it when a poll and its ballots disagree: the queue handler writes
// the poll and the ballot as two updates with no transaction across them, so a
// failure in between can leave one behind. The handler logs a line naming this
// script when it sees that.
//
//   node src/scripts/reconcilePollVotes.js              # report only
//   node src/scripts/reconcilePollVotes.js --apply      # write the fixes
//   node src/scripts/reconcilePollVotes.js --apply --poll <id>
//
// Reads MONGO_USERNAME / MONGO_PASSWORD / MONGO_URI / MONGODB_DB_NAME the same
// way the functions do; under `func start` those come from local.settings.json,
// so pass them in the environment when running this directly.

const mongoose = require("mongoose");
const { connectMongo } = require("../mongo");
const pollsModel = require("../models/communityPolls");
const pollVotesModel = require("../models/communityPollVotes");

function parseArgs(argv) {
  const pollAt = argv.indexOf("--poll");
  return {
    apply: argv.includes("--apply"),
    pollId: pollAt === -1 ? null : argv[pollAt + 1],
  };
}

// The truth for one poll, assembled from its ballots.
function tally(poll, ballots) {
  const onPoll = new Set((poll.options || []).map((o) => String(o._id)));
  const counts = new Map([...onPoll].map((id) => [id, 0]));
  const voters = [];
  const orphaned = [];

  for (const ballot of ballots) {
    const picks = [
      ...new Set((ballot.selected_options || []).map(String)),
    ].sort();

    // A pick that is no longer on the poll cannot be counted. Options are
    // referenced by id precisely so this stays rare, but a removed option
    // would leave one behind, and silently dropping it would be worse.
    const live = picks.filter((id) => onPoll.has(id));
    if (live.length !== picks.length) {
      orphaned.push({
        user_id: String(ballot.user_id),
        missing: picks.filter((id) => !onPoll.has(id)),
      });
    }

    for (const id of live) counts.set(id, counts.get(id) + 1);

    voters.push({
      user_id: ballot.user_id,
      selected_options: live.map((id) => new mongoose.Types.ObjectId(id)),
      edited_count: Number(ballot.edited_count) || 0,
      voted_at: ballot.createdAt,
      ...(ballot.edited_at ? { edited_at: ballot.edited_at } : {}),
    });
  }

  return { counts, voters, orphaned, totalVoters: ballots.length };
}

// What is wrong with the poll as stored, in words, or an empty list if nothing
// is. Reported whether or not `--apply` is passed.
function describeDrift(poll, expected) {
  const drift = [];

  if ((poll.total_voters || 0) !== expected.totalVoters) {
    drift.push(
      `total_voters ${poll.total_voters || 0} -> ${expected.totalVoters}`,
    );
  }

  for (const option of poll.options || []) {
    const want = expected.counts.get(String(option._id)) || 0;
    if ((option.votes_count || 0) !== want) {
      drift.push(
        `options[${String(option._id).slice(-6)}].votes_count ${option.votes_count || 0} -> ${want}`,
      );
    }
  }

  const stored = (poll.voters || []).length;
  if (stored !== expected.voters.length) {
    drift.push(`voters ${stored} entries -> ${expected.voters.length}`);
  } else {
    // Same number of entries, so compare each one: the picks it records and
    // the edit count it mirrors off the ballot.
    const fingerprint = (v) =>
      `${(v.selected_options || []).map(String).sort().join(",")}#${Number(v.edited_count) || 0}`;

    const storedBy = new Map(
      (poll.voters || []).map((v) => [String(v.user_id), fingerprint(v)]),
    );
    const changed = expected.voters.filter(
      (v) => storedBy.get(String(v.user_id)) !== fingerprint(v),
    );
    if (changed.length) {
      drift.push(
        `${changed.length} voter entr${changed.length === 1 ? "y" : "ies"} out of step with the ballot`,
      );
    }
  }

  return drift;
}

async function reconcile({ apply, pollId }) {
  await connectMongo();

  const filter = pollId ? { _id: pollId } : {};
  const polls = await pollsModel
    .find(filter, { options: 1, total_voters: 1, voters: 1, question: 1 })
    .lean();

  if (!polls.length) {
    console.log(pollId ? `No poll ${pollId}` : "No polls found");
    return;
  }

  let drifted = 0;
  let repaired = 0;

  for (const poll of polls) {
    const ballots = await pollVotesModel
      .find(
        { poll_id: poll._id },
        { user_id: 1, selected_options: 1, edited_at: 1, createdAt: 1 },
      )
      .lean();

    const expected = tally(poll, ballots);
    const drift = describeDrift(poll, expected);

    for (const o of expected.orphaned) {
      console.warn(
        `  ! poll ${poll._id} user ${o.user_id} voted for options no longer on the poll: ${o.missing.join(", ")}`,
      );
    }

    if (!drift.length) continue;
    drifted += 1;

    console.log(`\npoll ${poll._id} - ${poll.question || "(no question)"}`);
    for (const line of drift) console.log(`  - ${line}`);

    if (!apply) continue;

    // The whole derived state is replaced in one update, so the poll is never
    // left half-corrected.
    const options = (poll.options || []).map((o) => ({
      ...o,
      votes_count: expected.counts.get(String(o._id)) || 0,
    }));

    const result = await pollsModel.updateOne(
      { _id: poll._id },
      {
        $set: {
          options,
          voters: expected.voters,
          total_voters: expected.totalVoters,
        },
      },
    );
    if (result.modifiedCount) repaired += 1;
    console.log(`  repaired`);
  }

  console.log(
    `\n${polls.length} poll(s) checked, ${drifted} needed repair` +
      (apply ? `, ${repaired} written` : ` - re-run with --apply to write`),
  );
}

reconcile(parseArgs(process.argv.slice(2)))
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("reconcilePollVotes failed:", err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
