# Kerich Pharmaceuticals Platform

A pharmacy e-commerce, telemedicine, and admin platform for Kerich
Pharmaceuticals Ltd (Nairobi, Kenya). Express + Firebase (Auth, Firestore,
Storage), plain HTML/JS frontend (no build step), M-Pesa + Stripe payments.

**9,032 catalog products** (1,470 active, with real photos and
descriptions) · Firebase Auth · Firestore · Cloud Storage · PPB-compliant

More detail lives in [`docs/`](docs/):

| Doc | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, roles/permissions, security posture |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Every backend endpoint, auth requirements, request/response shapes |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Firestore collections, fields, security rules, indexes |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Local dev, Firebase Hosting deploy, production checklist |
| [`FIXES-APPLIED.md`](FIXES-APPLIED.md) | Change log — what's been built/fixed session by session |

---

## What's in here

Every public and staff-facing page includes a floating accessibility
widget (bottom-left) — light/dark theme, text & UI size, and reduced
motion, all persisted per-browser. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#accessibility) for how it
works.

- **Patient site** (`public/index.html`) — landing page, account portal,
  order history, prescription upload, doctor consultations booking, and
  a live chat + video/voice call room for confirmed consultations.
- **Shop** (`public/shop.html`) — product catalog with search, category
  filters, cart, checkout (M-Pesa / Stripe / insurance).
- **Admin panel** (`public/admin.html`) — orders, inventory, patients,
  prescription verification queue, consultations, delivery/riders,
  analytics, settings.
- **Doctor portal** (`public/doctor.html`) — separate login for doctors;
  manage their own consultation queue, toggle availability, and use the
  same live chat + call room to talk with patients.
- **Rider portal** (`public/rider.html`) — separate login for delivery
  riders; view assigned deliveries, share live location, mark delivered.
- **API** (`server.js` + `routes/`) — Express REST API backing all of the
  above; Firebase Admin SDK for privileged operations.

## Quick start

```bash
npm install
cp .env.example .env
# fill in FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY from a Firebase
# service account JSON (Firebase Console → Project Settings → Service
# Accounts → Generate new private key) — or drop the JSON file itself at
# ./serviceAccountKey.json instead, which config/firebase.js checks first.

node scripts/seed.js   # populates Firestore: products, doctors (+ real
                        # login accounts), admin user, pharmacy config
npm run dev             # http://localhost:3001
```

Seed output prints the admin login and every doctor's login. Full detail
on what gets seeded and why: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

Before this will actually serve real inventory/consultations/orders, you
also need to deploy Firestore rules and indexes:

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

## Project layout

```
server.js               Express app: middleware, route mounting, security headers
config/firebase.js      Firebase Admin SDK init (service account or env vars)
middleware/auth.js      authenticateToken (verifies Firebase ID token), requireRole
routes/                 One file per API resource — see docs/API_REFERENCE.md
  seo.js                   Server-rendered /product/:sku pages + dynamic sitemap.xml
scripts/seed.js         Seeds Firestore from data/products.json + doctor roster
data/products.json      Full 9,032-product catalog (generated from the Glovo feed)
public/                 Static frontend — plain HTML/CSS/JS, no build step
  index.html               Patient landing + account portal
  shop.html                Product catalog + checkout
  admin.html               Staff admin panel
  doctor.html               Doctor login + consultation queue
  rider.html                Rider login + delivery queue + location sharing
  news.html, Aboutus.html   Content pages
firestore.rules          Firestore security rules
firestore.indexes.json   Composite indexes (see docs/DATA_MODEL.md for why each exists)
storage.rules            Cloud Storage security rules
firebase.json            Hosting rewrites + rules/indexes wiring
```

## Roles

Every authenticated user has a `kerich_role` custom claim on their
Firebase Auth token: `patient` (default), `pharmacist`, `admin`, `rider`,
or `doctor`. `middleware/auth.js`'s `requireRole(...)` checks this claim;
`firestore.rules` checks the same claim for any direct client-side
Firestore access. Full breakdown in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#roles--permissions).
