const mongoose = require("mongoose");

const connectionString = process.env.MONGODB_CONNECTION_STRING;
const dbName = process.env.MONGODB_DB_NAME || 'myDatabase';

// The connection is cached on the module so every invocation in this worker
// process reuses one connection pool instead of dialing Atlas each time.
// mongoose buffers model commands until the handshake finishes, so the models
// are safe to use before this promise settles.
let connectionPromise = null;

function connectMongo() {
    if (!connectionString) {
        throw new Error('MONGODB_CONNECTION_STRING is not set');
    }
    if (!connectionPromise) {
        connectionPromise = mongoose
            .connect(connectionString, {
                dbName,
                serverSelectionTimeoutMS: 10000,
            })
            .then((m) => m.connection)
            .catch((err) => {
                // Cleared so a later call can retry instead of being stuck with
                // a permanently rejected promise.
                connectionPromise = null;
                throw err;
            });
    }
    return connectionPromise;
}

async function getConnection() {
    return connectMongo();
}

mongoose.connection.on('connected', () =>
    console.log(`[mongo] connected to ${dbName}`)
);
mongoose.connection.on('disconnected', () =>
    console.warn('[mongo] disconnected')
);
mongoose.connection.on('error', (err) =>
    console.error('[mongo] connection error:', err.message)
);

// Dial as soon as the module is loaded so the pool is warm before the first
// queue message arrives. Rejections are logged rather than thrown, so a
// unreachable database can't stop the function host from booting.
if (connectionString) {
    connectMongo().catch((err) =>
        console.error('[mongo] initial connection failed:', err.message)
    );
} else {
    console.error('[mongo] MONGODB_CONNECTION_STRING is not set - skipping connect');
}

module.exports = { connectMongo, getConnection, dbName };
