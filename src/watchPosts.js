const { getCollection, dbName, collectionName } = require('./mongo');
const { sendToCloudflareSqlQueue, queueName } = require('./outputQueue');

let started = false;
let changeStream = null;

// Starts a change stream on the posts collection so every new/updated
// document is printed as it lands. Safe to call repeatedly - only the
// first call actually opens a stream.
async function startWatchingPosts(log = console.log, logError = console.error) {
    if (started) return changeStream;
    started = true;

    try {
        const collection = await getCollection();

        // fullDocument: 'updateLookup' makes update events carry the whole
        // document, not just the changed fields - upserted retries show up
        // as updates, and we want the same detail for those.
        changeStream = collection.watch([], { fullDocument: 'updateLookup' });

        changeStream.on('change', (change) => {
            const doc = change.fullDocument;
            log(
                `[watch] ${change.operationType} on ${dbName}.${collectionName}`,
                JSON.stringify(
                    {
                        documentKey: change.documentKey,
                        post_id: doc && doc.post_id,
                        user_name: doc && doc.user_name,
                        content: doc && doc.content,
                        created_at: doc && doc.created_at,
                    },
                    null,
                    2
                )
            );

            // Only inserts are forwarded - an update event is a retried or
            // edited post that the downstream queue has already seen.
            if (change.operationType !== 'insert' || !doc || !doc.post_id) return;

            // The change handler is sync, so the send is fire-and-forget; a
            // failure is logged rather than left as an unhandled rejection.
            sendToCloudflareSqlQueue({
                post_id: doc.post_id,
                user_id: doc.user_id,
                user_name: doc.user_name,
                content: doc.content,
            })
                .then(() => log(`[watch] sent post ${doc.post_id} to ${queueName}`))
                .catch((err) =>
                    logError(
                        `[watch] failed to send post ${doc.post_id} to ${queueName}:`,
                        err.message
                    )
                );
        });

        // Without this a broken stream (e.g. a standalone mongod with no
        // replica set / oplog) would fail silently.
        changeStream.on('error', (err) => {
            logError('[watch] change stream error:', err.message);
            started = false;
            changeStream = null;
        });

        changeStream.on('close', () => {
            started = false;
            changeStream = null;
        });

        log(`[watch] watching ${dbName}.${collectionName} for changes...`);
    } catch (err) {
        started = false;
        logError('[watch] failed to start change stream:', err.message);
    }

    return changeStream;
}

async function stopWatchingPosts() {
    if (changeStream) {
        await changeStream.close();
    }
    changeStream = null;
    started = false;
}

module.exports = { startWatchingPosts, stopWatchingPosts };
