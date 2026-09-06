const Cloudflare = require("cloudflare");
const { NotFoundError } = require("cloudflare");

// Cloudflare KV access for the queue handlers. The official SDK is used against
// the REST API rather than a Workers binding, because this code runs on the
// Azure Functions host and there is no binding to bind to.

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE;

// Cloudflare caps key metadata at 1024 bytes and rejects the whole write when
// it is exceeded, so callers trim history to fit rather than letting writes
// start failing once a user has voted enough times.
const MAX_METADATA_BYTES = 1024;

// The client picks CLOUDFLARE_API_TOKEN up from the environment on its own, but
// naming it here keeps all three settings visible in one place.
const client = new Cloudflare({
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

function requireConfig() {
  const missing = [
    !accountId && "CLOUDFLARE_ACCOUNT_ID",
    !process.env.CLOUDFLARE_API_TOKEN && "CLOUDFLARE_API_TOKEN",
    !namespaceId && "CLOUDFLARE_KV_NAMESPACE",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(
      `Cloudflare KV is not configured: ${missing.join(", ")} not set`,
    );
  }
}

function scope() {
  return { account_id: accountId, namespace_id: namespaceId };
}

// A key that has never been written answers 404. That is a normal "no value
// yet", not a failure, so it is folded into null and every other error still
// propagates.
async function orNull(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// `values.get` resolves to a fetch Response carrying the stored bytes; the
// metadata lives behind its own endpoint.
async function getValue(key) {
  requireConfig();
  const res = await orNull(client.kv.namespaces.values.get(key, scope()));
  return res === null ? null : res.text();
}

async function getMetadata(key) {
  requireConfig();
  return orNull(client.kv.namespaces.metadata.get(key, scope()));
}

// One logical read costs two calls because the API exposes the value and its
// metadata separately, so they are issued together.
async function getWithMetadata(key) {
  const [value, metadata] = await Promise.all([
    getValue(key),
    getMetadata(key),
  ]);
  return { value, metadata };
}

async function getJSON(key) {
  const { value, metadata } = await getWithMetadata(key);
  if (value === null) return { value: null, metadata };

  try {
    return { value: JSON.parse(value), metadata };
  } catch {
    // A key holding non-JSON is treated as absent rather than poisoning the
    // caller: the next write replaces it with a well-formed document.
    return { value: null, metadata };
  }
}

async function putJSON(key, value, metadata) {
  requireConfig();
  return client.kv.namespaces.values.update(key, {
    ...scope(),
    value: JSON.stringify(value),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

async function deleteKey(key) {
  requireConfig();
  return (await orNull(client.kv.namespaces.values.delete(key, scope()))) !== null;
}

// Drops the oldest entries until the serialised metadata fits Cloudflare's
// limit. The newest entries are the ones worth keeping, so the trim is from
// the front.
function trimMetadata(metadata, listKey) {
  const list = metadata[listKey];
  if (!Array.isArray(list)) return metadata;

  while (
    list.length > 1 &&
    Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES
  ) {
    list.shift();
  }
  return metadata;
}

module.exports = {
  client,
  getValue,
  getMetadata,
  getWithMetadata,
  getJSON,
  putJSON,
  deleteKey,
  trimMetadata,
  MAX_METADATA_BYTES,
};
