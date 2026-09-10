const mongoose = require('mongoose');

// The credentials arrive as three separate settings rather than one URI so the
// password can be rotated on its own and never has to be pasted inside a
// larger string. MONGO_URI holds only the host part of the address (plus any
// query it needs), e.g. `my-cluster.abcde.mongodb.net`.
const username = process.env.MONGO_USERNAME;
const password = process.env.MONGO_PASSWORD;
const host = process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB_NAME || 'oncopilot-dev';

// Names the settings that are missing, so a misconfigured deployment says which
// one rather than just failing to connect.
function missingSettings() {
    return [
        ['MONGO_USERNAME', username],
        ['MONGO_PASSWORD', password],
        ['MONGO_URI', host],
    ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
}

// The username and password are percent-encoded because they are credentials
// going into a URI: an unescaped `@`, `:` or `/` in a password would otherwise
// be read as URI punctuation and silently point the driver somewhere else. The
// host is normalised so a value that was pasted with the scheme or a trailing
// slash still builds a valid string.
function buildConnectionString() {
    const user = encodeURIComponent(username);
    const pass = encodeURIComponent(password);

    const [address, query] = host
        .replace(/^mongodb(\+srv)?:\/\//, '')
        .split('?');

    return (
        `mongodb+srv://${user}:${pass}@${address.replace(/\/+$/, '')}/` +
        (query ? `?${query}` : '')
    );
}

const connectionString = missingSettings().length ? null : buildConnectionString();

// A ping costs a round trip, so it is not worth doing on every message when
// messages arrive in bursts. Anything younger than this is trusted as live.
const PING_INTERVAL_MS = 30000;

const connectOptions = {
    dbName,
    serverSelectionTimeoutMS: 10000,
};

// The connection is cached on the module so every invocation in this worker
// process reuses one connection pool instead of dialing Atlas each time.
// mongoose buffers model commands until the handshake finishes, so the models
// are safe to use before this promise settles.
let connectionPromise = null;
let lastPingAt = 0;

// Installs a fresh dial as the cached connection. `previous` is the promise the
// caller had already awaited: if the cache has moved on since then, someone
// else is already redialing and we just join their attempt instead of opening a
// second pool.
function dial(previous) {
    if (previous !== undefined && connectionPromise !== previous) {
        return connectionPromise;
    }

    const attempt = (previous ? mongoose.disconnect().catch(() => {}) : Promise.resolve())
        .then(() => mongoose.connect(connectionString, connectOptions))
        .then((m) => {
            lastPingAt = Date.now();
            return m.connection;
        })
        .catch((err) => {
            // Cleared so a later call can retry instead of being stuck with
            // a permanently rejected promise.
            if (connectionPromise === attempt) {
                connectionPromise = null;
            }
            throw err;
        });

    connectionPromise = attempt;
    return attempt;
}

// The single entry point: hand back a live connection, verifying it first and
// redialing only when the existing one is actually gone.
async function connectMongo() {
    if (!connectionString) {
        throw new Error(`${missingSettings().join(', ')} is not set`);
    }

    if (!connectionPromise) {
        return dial();
    }

    const current = connectionPromise;
    const connection = await current;

    // readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting.
    // 2 means the driver is already re-handshaking on its own and mongoose is
    // buffering commands meanwhile, so there is nothing to check or fix.
    if (connection.readyState === 2) {
        return connection;
    }

    if (connection.readyState === 1) {
        if (Date.now() - lastPingAt < PING_INTERVAL_MS) {
            return connection;
        }
        try {
            await connection.db.admin().command({ ping: 1 });
            lastPingAt = Date.now();
            return connection;
        } catch (err) {
            console.warn('[mongo] ping failed, reconnecting:', err.message);
        }
    }

    return dial(current);
}

mongoose.connection.on('connected', () =>
    console.log(`[mongo] connected to ${dbName}`)
);
mongoose.connection.on('disconnected', () => {
    // Force the next caller to ping instead of trusting a stale timestamp.
    lastPingAt = 0;
    console.warn('[mongo] disconnected');
});
mongoose.connection.on('error', (err) => {
    lastPingAt = 0;
    console.error('[mongo] connection error:', err.message);
});

// Dial as soon as the module is loaded so the pool is warm before the first
// queue message arrives. Rejections are logged rather than thrown, so a
// unreachable database can't stop the function host from booting.
if (connectionString) {
    connectMongo().catch((err) =>
        console.error('[mongo] initial connection failed:', err.message)
    );
} else {
    console.error(
        `[mongo] ${missingSettings().join(', ')} is not set - skipping connect`
    );
}

module.exports = { connectMongo, dbName };
