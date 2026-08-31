const { app } = require('@azure/functions');
// Required for its side effect: loading it opens the mongoose connection at
// worker startup, so the pool is ready before the first queue message.
// require('./mongo');
// const { startWatchingPosts } = require('./watchPosts');

app.setup({
    enableHttpStream: true,
});

// Start watching at worker startup so changes written by anyone - not just
// this function - get printed. Errors are logged inside, never thrown, so a
// failing change stream can't stop the function host from booting.
// startWatchingPosts();
