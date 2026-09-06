const { getJSON, putJSON, trimMetadata } = require("../cloudflareKv");

// A poll vote is stored in Cloudflare KV under the voter's id:
//
//   key      68a2db6e64b83c8888ea11da
//   value    { poll_id, option_id, edit }
//   metadata { options: [{ option_id, createdAt }, ...] }
//
// The value is the vote as it stands now; the metadata keeps every option the
// user has picked, in order, so the change history survives the overwrite.

const METADATA_LIST_KEY = "options";

function voteKey(userId) {
  return String(userId);
}

function existingHistory(metadata) {
  const list = metadata && metadata[METADATA_LIST_KEY];
  return Array.isArray(list) ? [...list] : [];
}

async function applyPollVote(payload, context) {
  const pollId = String(payload.poll_id);
  const optionId = String(payload.option_id);
  const key = voteKey(payload.user_id);

  const { value: current, metadata } = await getJSON(key);

  // The queue delivers at least once, so the same vote can arrive twice. Re-
  // writing it would bump `edit` and append a duplicate history entry for a
  // choice the user never actually changed, so an unchanged vote is a no-op.
  if (
    current &&
    String(current.poll_id) === pollId &&
    String(current.option_id) === optionId
  ) {
    context.log(`Poll vote unchanged for user ${key} on poll ${pollId}, skipping`);
    return null;
  }

  const vote = {
    poll_id: pollId,
    option_id: optionId,
    // First vote is edit 0; every later change to the key counts as one edit.
    edit: current ? Number(current.edit || 0) + 1 : 0,
  };

  const history = existingHistory(metadata);
  history.push({ option_id: optionId, createdAt: new Date().toISOString() });

  const nextMetadata = trimMetadata({ [METADATA_LIST_KEY]: history }, METADATA_LIST_KEY);

  await putJSON(key, vote, nextMetadata);

  return { key, vote, metadata: nextMetadata };
}

module.exports = { applyPollVote, voteKey, METADATA_LIST_KEY };
