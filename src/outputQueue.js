const { QueueClient } = require('@azure/storage-queue');

const connectionString =
    process.env.likequeuetestv1_STORAGE || process.env.AzureWebJobsStorage;
const queueName =
    process.env.CLOUDFLARE_SQL_QUEUE_NAME || 'conversation-posts-cloudflare-sql-v1';

// Cached on the module so every send in this worker reuses one client, and
// createIfNotExists only runs on the first send.
let clientPromise = null;

function getQueueClient() {
    if (!connectionString) {
        throw new Error('likequeuetestv1_STORAGE is not set');
    }
    if (!clientPromise) {
        const client = new QueueClient(connectionString, queueName);
        clientPromise = client.createIfNotExists().then(() => client);
    }
    return clientPromise;
}

async function sendToCloudflareSqlQueue(payload) {
    const client = await getQueueClient();
    return client.sendMessage(JSON.stringify(payload));
}

module.exports = { sendToCloudflareSqlQueue, queueName };
