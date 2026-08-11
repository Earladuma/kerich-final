// api/index.js — Vercel entry point.
//
// Vercel's Node runtime treats any exported (req, res) handler (or an
// Express app, which is one) as a serverless function. Requiring
// server.js runs its normal top-level setup — Firebase Admin init,
// middleware, route mounting — exactly once per cold start; server.js
// itself skips calling app.listen() when process.env.VERCEL is set
// (Vercel sets this automatically), so nothing tries to bind a port in
// an environment where that's meaningless.
//
// This file should never contain real logic of its own — it exists only
// because Vercel's convention is to look in /api for serverless
// functions, and the actual app lives at the project root as server.js
// so that `npm run dev` / `npm start` keep working completely unchanged
// for local development and any traditional (non-serverless) host.
module.exports = require('../server.js');
