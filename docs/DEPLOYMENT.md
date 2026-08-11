# Deployment

## Local development

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- **Firebase Admin credentials** — either drop a downloaded service
  account JSON at `./serviceAccountKey.json` (checked first by
  `config/firebase.js`, and already git-ignored), or fill in
  `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` from that same JSON.
  Get it from Firebase Console → Project Settings → Service Accounts →
  Generate new private key.
- The `FIREBASE_API_KEY`/`FIREBASE_AUTH_DOMAIN`/etc. client config values
  are already filled in for project `kerich-4aefa` — no change needed
  unless you're pointing this at a different Firebase project.
- M-Pesa (`MPESA_*`) and Stripe (`STRIPE_SECRET_KEY`) keys are only
  needed if you want to actually test payments; the app runs fine without
  them for everything else.

```bash
node scripts/seed.js   # populates products, doctors, admin user, config
npm run dev             # nodemon, http://localhost:3001
```

Seeding is not idempotent for products (re-running duplicates them — see
`FIXES-APPLIED.md`), but doctor accounts and the admin user are safe to
re-seed (checked by email/uid before creating).

## Deploying Firestore rules & indexes

**Do this before deploying hosting**, and any time you change
`firestore.rules` or `firestore.indexes.json`:

```bash
npm run deploy:rules
# = firebase deploy --only firestore:rules,firestore:indexes,storage:rules
```

Composite indexes can take several minutes to build after deploying —
check progress in Firebase Console → Firestore → Indexes. Queries that
need an index that isn't built yet will fail with `FAILED_PRECONDITION`
until it finishes.

If you add a new query anywhere in the app that combines a `.where()`
with `.orderBy()` on a different field (or multiple `.where()`s plus an
`.orderBy()`), it almost certainly needs a new composite index — see
`docs/DATA_MODEL.md` for the reasoning behind every index currently in
the file, and add a matching entry rather than waiting for it to fail in
production.

## Deploying hosting

`firebase.json` serves `public/` as the hosting root, with an SPA-style
rewrite (`**` → `index.html`) and a specific rewrite for `/admin/**` →
`admin.html`. Static files (including `admin.html`, `doctor.html`
themselves) are served directly when they exist — the rewrite only
applies when no matching file is found, so this doesn't interfere with
the multi-page structure.

```bash
npm run deploy:hosting     # = firebase deploy --only hosting
# or
npm run deploy              # everything: hosting + rules + indexes + storage
```

Firebase Hosting alone only serves static files — **the Express API
(`server.js`) is not deployed by this**. Either deploy the API
separately (a VM, Cloud Run, Render, etc., pointing the frontend at
wherever that ends up living) or use the Vercel path below, which
deploys frontend and API together from this same repo.

## Deploying to Vercel (frontend + API together)

This is the simpler option if you don't already have a separate Node
host — `vercel.json` + `api/index.js` route every request (static files,
`/api/*`, the dynamic `/product/:sku` and `/sitemap.xml` routes) through
the same Express app this repo already runs locally.

```bash
npm install -g vercel   # if you don't have the CLI
vercel                   # first deploy — follow the prompts
vercel --prod             # subsequent production deploys
```

**Environment variables**: Vercel doesn't read your local `.env` file —
set every variable from `.env.example` in the Vercel dashboard (Project
→ Settings → Environment Variables) or via `vercel env add`. Two things
specific to this setup:

- Use `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`, not
  `serviceAccountKey.json` — that file is git-ignored and won't be part
  of the deployment. `config/firebase.js` already handles the private
  key's `\n` sequences correctly whichever way you paste it in.
- Set `BASE_URL` to your actual Vercel URL (e.g.
  `https://your-project.vercel.app`) — the M-Pesa callback URL is built
  from this, and Safaricom's servers need a real, reachable URL to call
  back.

**How this actually works**: `server.js` skips calling `app.listen()`
whenever `process.env.VERCEL` is set (Vercel sets this automatically) —
everywhere else (local dev, a VM, Render) it behaves exactly as before.
`api/index.js` just re-exports the same Express app for Vercel's Node
runtime to invoke per-request. Nothing about local development changed.

**Trade-off worth knowing**: routing *everything* through one serverless
function means static assets (images, CSS, JS) are served by that
function too, rather than Vercel's CDN serving them directly. This was
the deliberate choice here — splitting static/dynamic routing risks
missing the server-rendered `/product/:sku` pages and dynamic
`/sitemap.xml`, which need Express, not a static file server. For a
storefront this size it's a reasonable trade; revisit if static-asset
latency becomes a real problem.

## Production checklist

- [ ] Real Firebase service account credentials in the API host's
      environment (not committed, not `.env.example`'s placeholder
      values).
- [ ] `firestore.rules` + `firestore.indexes.json` + `storage.rules`
      deployed and indexes finished building.
- [ ] `NODE_ENV=production` set — enables the HTTPS redirect in
      `server.js`.
- [ ] Real M-Pesa Daraja production credentials (not sandbox) and a
      `BASE_URL` that Safaricom's servers can actually reach (the M-Pesa
      callback URL is built from this — see `docs/API_REFERENCE.md`).
- [ ] Real Stripe secret key (live, not test).
- [ ] Real SMTP credentials (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`) and
      Africa's Talking credentials (`AT_USERNAME`/`AT_API_KEY`) — without
      these, order/prescription/consultation notifications silently
      no-op (logged, not sent) rather than failing loudly, so it's easy
      to not notice they're missing until a customer asks why they never
      got a confirmation.
- [ ] `node scripts/seed.js` run once against the production Firestore
      project — note the printed admin, doctor, and rider login
      credentials, and
      change them after first login (they're fixed defaults, meant to be
      rotated).
- [ ] CORS allowlist in `server.js` updated if the frontend is served
      from a different origin than `BASE_URL`.
- [ ] Decide on a real deployment target for `server.js` (see note
      above — Firebase Hosting alone does not run this).
