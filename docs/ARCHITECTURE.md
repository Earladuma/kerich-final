# Architecture

## Overview

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Static frontend │─────▶│   Express API     │─────▶│   Firestore /    │
│  (public/*.html)  │◀─────│   (server.js +    │◀─────│   Firebase Auth /│
│  plain JS, no      │      │   routes/*.js)    │      │   Cloud Storage   │
│  build step         │      │                    │      │                  │
└─────────────────┘      └──────────────────┘      └─────────────────┘
        │                          │
        │ Firebase JS SDK          │ firebase-admin SDK
        │ (client, some            │ (server, bypasses
        │  direct Firestore        │  Firestore rules —
        │  reads — see below)      │  routes do their own
        │                          │  validation instead)
        ▼                          ▼
   Firebase Auth              M-Pesa Daraja / Stripe
   (ID tokens)                 (payment providers)
```

Two different data-access patterns coexist in this codebase, deliberately:

1. **Client SDK, direct Firestore reads/writes** — used by `admin.html`
   for real-time tables (orders, prescriptions queue, consultations) via
   `onSnapshot`, protected by `firestore.rules`. This is the original
   pattern the app was built with. Consultation chat and call signaling
   (`index.html`, `doctor.html`) also use this pattern for both reads
   *and* writes — real-time delivery matters enough for a live chat/call
   that REST polling isn't an acceptable substitute, and the security
   rules for `consultations/{id}/messages` and `calls/{id}` do the same
   ownership verification the REST endpoints do elsewhere (see
   `docs/DATA_MODEL.md`).
2. **REST API via `fetch()`** — used for anything that needs server-side
   validation beyond what a Firestore rule can express (numeric ranges,
   cross-field checks, creating linked Firebase Auth accounts, stripping
   sensitive fields before returning data to the public). This is the
   pattern all new work in this project has followed
   (`/api/pharmacy/*`, `/api/consultations/*`).
3. **Server-rendered HTML** (`routes/seo.js`) — a small, deliberate
   exception to "the frontend is static files with no build step". Search
   engines can't meaningfully index individual products out of a
   client-rendered SPA-style page, so `GET /product/:sku` renders real
   HTML server-side with proper meta tags and structured data. This is
   the only place in the app that generates HTML on the server — don't
   extend this pattern to other pages without a similarly specific reason
   (it reintroduces server-side templating this codebase otherwise
   avoids).

When adding a new admin feature: prefer the REST API pattern for writes
that need validation, and either pattern for reads (client SDK gives you
free real-time updates via `onSnapshot`; the REST API gives you the
ability to filter sensitive fields before they leave the server).

## Backend structure

- `server.js` — helmet security headers, HTTPS redirect (production),
  rate limiting (global `apiLimiter` + stricter `authLimiter` on
  `/api/auth/*`), CORS allowlist, body size limits, gzip compression,
  static file serving from `public/`, route mounting, centralized error
  handler.
- `config/firebase.js` — initializes the Firebase Admin SDK. Tries
  `./serviceAccountKey.json` first, falls back to
  `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` env vars. Exports
  `getDb()`, `getAuth()`.
- `middleware/auth.js` — `authenticateToken` verifies the Firebase ID
  token from the `Authorization: Bearer <token>` header and sets
  `req.user` (decoded token — `uid`, `email`, and the `kerich_role`
  custom claim). `requireRole(...roles)` is a middleware factory that
  403s unless `req.user`'s role is in the allowed list.
- `routes/*.js` — one file per resource. See
  [`API_REFERENCE.md`](API_REFERENCE.md) for every endpoint.

## Roles & permissions

Set via a Firebase Auth **custom claim** named `kerich_role` (not a
Firestore field — claims live on the ID token itself, set with
`auth.setCustomUserClaims(uid, { kerich_role: 'admin' })`). A user must
re-fetch their ID token (`getIdToken(true)`) after a claim change before
it takes effect.

| Role | Set by | Can do |
|---|---|---|
| `patient` | default (no claim set) | Browse shop, place orders, upload prescriptions, book/cancel own consultations, view own order/Rx/consultation history |
| `pharmacist` | admin, via Firebase Console or a future admin tool | Everything patient can, plus: manage products/inventory, verify prescriptions, update order status, manage deliveries |
| `admin` | seeded directly (`scripts/seed.js`) | Everything pharmacist can, plus: manage users, doctors (create real doctor accounts), pharmacy config, compliance reports, audit log |
| `rider` | `scripts/seed.js` or admin via `POST /api/delivery/riders` | Log into `rider.html`, view/complete own assigned deliveries, share live location |
| `doctor` | `scripts/seed.js` (initial roster) or admin via `POST /api/consultations/doctors` | Log into `doctor.html`, manage own consultation queue, toggle own availability |

Both `middleware/auth.js` (`requireRole`) and `firestore.rules` (`role()`
helper, reading the same claim from `request.auth.token.kerich_role`)
check this claim independently — the API and direct Firestore access are
both locked down, not just one or the other.

## Security posture

- **Transport**: helmet (CSP, HSTS, frame-ancestors, etc.), forced HTTPS
  redirect outside development.
- **Rate limiting**: global limiter on all `/api/*`, a stricter one on
  `/api/auth/*` to slow credential-stuffing/brute-force attempts.
- **Input validation**: every write endpoint that accepts a body
  (products, config, consultations, doctors) validates types, ranges, and
  string lengths server-side and returns `400` with details rather than
  trusting the client — see each endpoint's validation notes in
  `API_REFERENCE.md`.
- **Least-privilege data exposure**: `GET /api/consultations/doctors`
  (public, used by the patient-facing doctor list) explicitly strips
  `uid`/`email` before responding, even though the underlying `doctors`
  Firestore documents carry them (needed server-side to link a doctor's
  login to their record). Direct client Firestore reads of `doctors` are
  restricted to staff for the same reason.
- **Defense in depth**: Firestore rules restrict direct client access
  even for collections the API also validates, so a bug in one layer
  doesn't fully expose the collection.
- **Secrets**: `.env` is git-ignored; `.env.example` documents every
  variable actually read by the code (kept in sync — see
  `FIXES-APPLIED.md` for the audit that verified this). M-Pesa/Stripe
  keys, Firebase service account credentials never appear in the
  repository.

## Accessibility

Every page (`index.html`, `shop.html`, `admin.html`, `doctor.html`,
`rider.html`, `news.html`, `Aboutus.html`) includes the same floating
widget via two shared files: `public/css/accessibility.css` and
`public/js/accessibility.js`. Nothing is duplicated per-page beyond a
small bootstrap snippet (see below) — this is the one place in the
frontend that isn't copy-pasted across pages.

- **Theme (light/dark)**: toggled via a `data-theme` attribute on
  `<html>`, overridden with `html[data-theme="light"] { --dark: ...; }`
  etc. in `accessibility.css`. Works because every page defines the same
  core CSS custom property names (`--dark`, `--text`, `--gold`, etc.) in
  its own `:root` — `news.html` and `Aboutus.html` didn't originally use
  variables at all (hardcoded hex throughout) and were refactored to as
  part of adding this, since a variable-override approach can't work on
  a page that doesn't use variables.
- **Text/UI size**: uses CSS `zoom`, not a `rem`-based font scale. This
  codebase is built almost entirely with fixed `px` values, so scaling
  the root font-size wouldn't cascade to most text at all — `zoom` scales
  the whole layout together (text, buttons, spacing), which actually
  works with what's here. Supported in every evergreen browser (Firefox
  added it in version 126, 2024).
- **Reduced motion**: an `a11y-reduce-motion` class on `<html>` collapses
  all CSS animation/transition durations to near-zero.
- All three preferences persist in `localStorage`
  (`kerich_theme`, `kerich_a11y_scale`, `kerich_reduce_motion`) and are
  applied by a small **blocking** inline script at the very top of each
  page's `<head>` — before `accessibility.css`/`.js` load — specifically
  to avoid a flash of the wrong theme on page load. The full widget
  (button + panel + interactivity) loads separately via a `defer`red
  script, since building the UI doesn't need to block rendering the way
  applying the theme attribute does.
- **A real mistake worth knowing about**: the first pass at converting
  `Aboutus.html`'s hardcoded colors to variables mapped "dark text on a
  gold button" to `var(--dark)` — which flips to near-white in light
  mode, making that text invisible against the still-gold button
  background. Text-on-a-fixed-accent-color needs to stay a fixed color
  regardless of theme; only true background/foreground pairs should
  follow the theme variable. Caught by reasoning through what light mode
  would actually do to it, not by a rendering check (this sandbox can't
  render pages) — fixed to a fixed `#1A1200` instead. Worth double-
  checking if you add more gold-button-style elements elsewhere.
- Not every hardcoded color in every page was converted to a variable —
  many are legitimate fixed-contrast pairs (badge/button text on a
  colored background) that are correct to leave alone, same reasoning as
  the mistake above. The ones that mattered for overall theme
  cohesion (page/card backgrounds, primary/secondary text) are the ones
  that got converted.

## Notifications

`services/notifications.js` sends email (via SMTP, any provider —
nodemailer) and SMS (via Africa's Talking's REST API, the standard
choice for Kenyan businesses) for order confirmation/status changes,
prescription approval/rejection, and consultation booking/status
changes. Both channels degrade gracefully when unconfigured (log a
warning, return without throwing) — the same pattern already used for
Stripe/M-Pesa credentials, so a missing `SMTP_*`/`AT_*` env var never
breaks the underlying order/prescription/consultation operation itself.

Every route calls a **templated, event-level function**
(`notifyOrderConfirmed`, `notifyPrescriptionReviewed`, etc.) rather than
`sendEmail`/`sendSMS` directly — those live at the bottom of
`services/notifications.js` and are the only functions anything outside
that file should call.

**A real architecture wrinkle this surfaced**: `admin.html`'s order
status flow writes directly to Firestore client-side (its own
established stock-decrement/sales-recording logic for `delivered` — see
the Increment 5 audit) rather than through `PATCH /api/orders/:id/status`.
Rather than risk that already-verified logic by rerouting it through the
REST API, there's a narrow `POST /api/orders/:id/notify-status`
endpoint that *only* fires the notification, called right after
`admin.html`'s existing Firestore write succeeds. `routes/delivery.js`'s
`/complete` endpoint (the rider path) and `PATCH /api/orders/:id/status`
(for any other caller) both fire notifications directly, since they
already own the Firestore write.

## Known gaps (intentionally not built, flagged rather than faked)

- No password-reset flow for doctor accounts from the doctor portal
  itself (would need `sendPasswordResetEmail` wired up, or a Console
  reset by admin).
- Consultation calls use only a free public STUN server, no TURN server
  — calls may fail to connect on some restrictive/symmetric-NAT networks.
  A TURN server (self-hosted `coturn` or a paid service like Twilio's)
  would fix this; not set up here. See `docs/DATA_MODEL.md`'s `calls`
  collection entry.
- The consultation *list* in the doctor portal and patient portal still
  re-fetches every 30s rather than listening via `onSnapshot` — the
  consultation *room* (chat + call) is fully real-time, but a newly
  requested/confirmed consultation can take up to 30s to appear in the
  list itself.
- Rider live-location tracking now has a full loop: `rider.html`
  broadcasts position, `index.html` shows it on a live Leaflet map (see
  `FIXES-APPLIED.md` Increment 7). `admin.html`'s delivery board still
  shows status/counts only, not a live map — a reasonable next step if
  dispatchers need it, not built here since the ask was specifically
  about the customer-facing tracking experience.
- The route line on the tracking map is a straight line between rider and
  destination, not a real routed path along roads — that needs a routing
  API (e.g. OSRM, Google Directions), which needs its own API key/service
  and wasn't part of this pass. Good enough to show direction/progress,
  not turn-by-turn accurate.
