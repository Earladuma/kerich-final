# Fixes applied — July 2026

The repo as pulled from GitHub could not run. Root cause: `.gitignore` had a
blanket `*.json` rule, which silently excluded every JSON config file from
every commit — including the ones the app needs to boot.

## What was missing / broken

1. **`package.json` was never committed.** `npm install` had nothing to
   install from. → Recreated from every `require(...)` call actually used
   across `server.js`, `routes/`, `middleware/`, `config/`, `scripts/`.
2. **`firebase.json` was never committed**, despite the README's deploy
   instructions depending on it. → Recreated with hosting rewrites for the
   SPA + `/admin` app, plus firestore/storage rules wiring.
3. **`firestore.indexes.json`** (referenced by the new `firebase.json`) →
   added with indexes for the query patterns already in the route code
   (`payments` by orderId+createdAt, `orders` by patientId+createdAt,
   `prescriptions` by patientId+status).
4. **`.env.example`** didn't exist, so there was no reference for which
   variables to set. → Added, listing every `process.env.*` the code reads.
5. **M-Pesa callback bug**: `server.js` mounted the entire `payments` router
   behind `authenticateToken`, which would reject Safaricom's callback (it
   carries no bearer token) with a 401 — payments would never confirm as
   paid. There was also a second, broken registration of the same route
   (`app.post('/api/payments/mpesa/callback', require('./routes/payments'))`)
   that passed a whole Router as a single handler, which doesn't work with
   Express path-matching. → Removed the blanket auth on `/api/payments` and
   the broken duplicate route; `routes/payments.js` already applies
   `authenticateToken` per-route for the endpoints that need it.
6. **`multer` bumped from `1.4.5` to `^2.0.0`** — 1.x has known
   vulnerabilities; usage was plain `memoryStorage()` so it's a drop-in swap.
7. **`.gitignore`** — removed the `*.json` blanket rule; now only excludes
   `serviceAccountKey.json` and `package-lock.json` specifically.

## Verified locally

- `npm install` succeeds (288 packages).
- All files pass `node --check` (syntax).
- `node server.js` boots the Express app and fails at the correct point
  (missing real Firebase credentials) rather than crashing on a missing
  module or bad route registration.
- `npm audit` shows only moderate, transitive vulnerabilities inside
  `firebase-admin`'s own dependency chain (`@google-cloud/storage` →
  `teeny-request`/`retry-request`) — not fixable without a breaking
  `firebase-admin` downgrade/upgrade; worth watching for a firebase-admin
  patch release rather than forcing.

## Still needed from you to actually run it

- A real Firebase service account JSON at `./serviceAccountKey.json`
  (Firebase Console → Project Settings → Service Accounts), or the
  `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` pair in `.env`.
- `node scripts/seed.js` once credentials are in place.
- Real M-Pesa Daraja and Stripe keys if you want payments to work beyond
  local stubs.

---

# Increment 2 — real inventory, security, SEO (this session)

## Real inventory from your Glovo catalog

- `data/products.json` — built from `kerich_catalog____2_.xlsx` (9,032 rows).
  All rows kept: 1,470 active (real photos, prices, descriptions from the
  feed) + 7,562 marked `active:false, stock:0` (your call, so they can be
  reactivated later instead of being lost).
- 219 active products had no category in the sheet — auto-assigned by
  keyword matching against the product name (your call). These land in
  "Miscellaneous General Supplies" when no keyword hits; genuinely
  unclassifiable by name alone.
- Mojibake in descriptions (double-encoded UTF-8) is cleaned where
  detectable; HTML entities unescaped; descriptions capped at 600 chars.
- `scripts/seed.js` now loads this file instead of an inline 1,377-item
  array, batching in groups of 400 (23 batches total).

## Shop frontend — no more hardcoded product data

- Removed the ~230KB hardcoded `const ALL_PRODUCTS = [...]` array from
  `shop.html` entirely. Products now load live from
  `GET /api/pharmacy/products` on page load, with a loading state and a
  retry-on-failure state.
- Replaced the PubChem/OpenFDA "guess the active ingredient, hope there's
  a matching 2D structure image" system with your actual catalog photos
  (`p.image`), which are simpler, faster, and don't depend on two external
  APIs that CSP would've silently blocked anyway (they were never in
  `connectSrc`, so that feature was quietly broken before this change).
- Stale hardcoded counts ("1,377 medicines in stock", "Search 1,377
  medicines...", inventory KPI cards, nav badge) replaced with live values
  computed from the actual loaded data.

## Admin — clickable phone/location, real settings

- Order table: phone numbers are now `tel:` links; delivery location
  already had Map/Navigate links when lat/lng existed — added a Google
  Maps text-search fallback for when only a street/city string is stored.
- Patient detail view: phone chip is now a `tel:` link too.
- Settings page was showing hardcoded values with a fake "Settings saved"
  toast that didn't persist anything. Now loads from and saves to
  `GET/PATCH /api/pharmacy/config` (new endpoints, admin-only for writes).
- Inventory KPIs (Total SKUs, Price Range) and the sidebar nav badge were
  hardcoded to the old count — now computed from the live Firestore data.

## API hardening (`routes/pharmacy.js`)

- `GET /products` limit param is now validated (must be a positive number,
  capped at 5,000) instead of trusting raw query-string input.
- `POST/PATCH /products` now validate every field (price ≥ 0, integer
  stock ≥ 0, type must be `otc`/`rx`, string length caps) and reject with
  400 + details instead of writing whatever was sent.
- New `GET /config` (public) and `PATCH /config` (admin-only) so pharmacy
  contact/address/delivery-fee info lives in Firestore, not HTML.

## SEO

- `index.html` / `shop.html`: meta description, canonical URL, Open Graph
  + Twitter card tags, `Pharmacy` JSON-LD structured data on the homepage.
- `admin.html` / `doctor.html`: `noindex, nofollow` (internal tools
  shouldn't be indexed).
- Added `robots.txt` (disallows `/admin.html`, `/doctor.html`, `/api/`)
  and `sitemap.xml` covering the public pages.

## Not done / scope notes

- Category *taxonomy* (the ~31 filter-sidebar buckets in `shop.html`) is
  still a fixed set in the HTML — left as-is deliberately. It's site
  navigation structure, not variable business data, and every one of the
  105 raw categories in your sheet maps cleanly onto an existing bucket
  (new/exotic ones like Makeup, Perfumes, Jewelry fall into the existing
  "Miscellaneous General Supplies" catch-all). Flagging this in case you'd
  rather those get their own dedicated filter buttons.
- Product descriptions are stored and returned by the API but not yet
  shown anywhere in the shop UI (no product detail/quick-view modal
  exists yet) — next logical increment if you want them visible.
- Haven't run `node scripts/seed.js` against a live Firestore project
  (no credentials available here) — only verified it loads the JSON,
  batches correctly, and passes `node --check`.

---

# Increment 3 — real consultation booking (this session)

## The actual root causes

1. **No Firestore rule for the `doctors` collection at all.** The patient
   page reads it directly via the client SDK
   (`getDocs(collection(db,'doctors'))`), and with no explicit rule it fell
   through to the deny-all catch-all — meaning the doctor list was
   silently failing to load and showing "No doctors available right now"
   regardless of anything else. Added a public-read rule (writes restricted
   to admin).
2. **`bookDoctor()` was entirely fake** — it just showed a success toast
   and wrote nothing anywhere. There was also no backend at all for
   consultations: no route file, nothing mounted in `server.js`, even
   though `routes/users.js` already *read* from a `consultations`
   collection that nothing ever wrote to.

## What's built now

- `routes/consultations.js` (new): `POST /` to book (validates channel,
  reason length, scheduled time; checks the doctor exists and is available
  for "book now" requests), `GET /mine` for a patient's own bookings,
  `PATCH /:id/cancel` for the patient (or staff) to cancel, and
  `GET /` + `PATCH /:id` for admin/pharmacist staff to list and manage all
  consultations (status, notes). Mounted at `/api/consultations` in
  `server.js`.
- `index.html`: `bookDoctor()` now opens a real modal — pick video/voice/
  chat, "ASAP" or a scheduled date-time, an optional reason — and actually
  POSTs the booking. A "My Consultations" list under the Doctors tab (and
  a 3-item preview on the health-record home tab) shows real bookings with
  status and a Cancel link, replacing the hardcoded "No consultations yet"
  that was there regardless of reality.
- `firestore.rules`: added the missing `doctors` read rule described above.

## Scope note — doctor-side management

`doctor.html` ("Hospital OS") is a self-contained demo tool with its own
unrelated schema (`patients`/`appointments`/`billing` subcollections) — it
was never wired to the `doctors`/`consultations` collections the patient
side actually uses, and doctor accounts aren't linked to Firebase Auth
users yet. Building a real doctor login + booking-management portal is a
separate, larger piece of work I didn't want to assume my way into. For
now, admin/pharmacist staff can list and update any consultation via the
new `GET/PATCH /api/consultations` endpoints — there's just no UI wired to
them yet (would slot into `admin.html` similarly to the Orders table).
Let me know if you want that built next.

---

# Increment 4 — admin consultation management + real doctor portal (this session)

## Admin: Consultations page (`admin.html`)

- New "Consultations" nav item + page, sitting alongside Orders/Inventory.
- Real-time table (Firestore `onSnapshot`, same pattern as the existing
  Orders table) with patient (phone as a `tel:` link, reusing the earlier
  `renderPhoneLink` helper), doctor, channel, scheduled time, fee, and
  status.
- Filter chips (All/Requested/Confirmed/In Progress/Completed/Cancelled/
  Declined) + a search box over patient/doctor name.
- Status updates go through the validated `PATCH /api/consultations/:id`
  API (not a raw client-side Firestore write), so the same server-side
  validation from Increment 2 applies here too.

## Real doctor accounts

- `scripts/seed.js` now creates an actual Firebase Auth account for each
  of the 6 seeded doctors (`kerich_role: 'doctor'` custom claim, password
  `KerichDoctor2025!`), linked to their `doctors/{id}` doc via a new `uid`
  field. Credentials print in the seed summary.
- Fixed a real gap this surfaced: the existing admin "Add Doctor" flow
  (`showAddDoctorModal`) wrote straight to Firestore with no login account
  at all — any doctor added that way could never sign in. It now calls a
  new admin-only `POST /api/consultations/doctors` endpoint that creates
  the Firestore record *and* the linked Auth account, and shows the admin
  a temporary password to hand off.
- **Security fix I'd have otherwise shipped a leak in**: once `doctors`
  docs carry `uid`/`email`, the old "public read" Firestore rule for that
  collection would have exposed both to any unauthenticated visitor via
  the client SDK. Locked `doctors` reads down to clinical/admin staff only
  (`isClinical()`), and moved the patient-facing doctor list in
  `index.html` onto a new public `GET /api/consultations/doctors`
  endpoint that explicitly strips `uid`/`email` before responding.

## New doctor portal (`doctor.html` — full rebuild)

The old file was a disconnected demo with a literal placeholder Firebase
config (`apiKey: "YOUR_KEY"` — would have thrown immediately) and its own
unrelated `patients`/`appointments`/`billing` schema. Replaced entirely:

- Real login (email/password via Firebase Auth), gated on the
  `kerich_role: 'doctor'` custom claim — a non-doctor account gets signed
  back out with a clear message rather than seeing the portal.
- Queue view (All/Requested/Confirmed/In Progress/Completed tabs) pulling
  from `GET /api/consultations/doctor/mine`.
- Real actions wired to the API: Confirm / Decline a request, Start a
  confirmed consultation, Mark Completed with optional notes, Cancel.
- Availability toggle in the header (`PATCH
  /api/consultations/doctors/me/availability`) — doctors can now mark
  themselves unavailable without needing an admin to do it for them.

## New backend endpoints (`routes/consultations.js`)

- `GET /doctors` — public-safe doctor list (used by the patient page).
- `GET /doctors/me`, `PATCH /doctors/me/availability` — a doctor's own
  profile and availability.
- `POST /doctors` — admin creates a doctor + linked login account.
- `GET /doctor/mine` — a doctor's own consultation queue.
- `PATCH /:id` — extended to also allow the *assigned* doctor to update
  their own consultations, not just admin/pharmacist.

## Not done / scope notes

- No password-reset flow for doctor accounts — they'd need to ask an
  admin to reset via the Firebase Console, or you could wire up
  `sendPasswordResetEmail` fairly quickly if wanted.
- No email/SMS notifications when a consultation is booked, confirmed, or
  updated — the API supports it (it's just missing calls to a
  notification service), and the frontend polls/relies on manual refresh
  rather than pushing updates in real time (the patient side re-fetches
  after booking/cancelling; the doctor portal doesn't auto-refresh either
  — a Firestore listener would fix that same as the admin table has).
- Haven't run this against a live Firestore project — verified by syntax
  checking every file and tracing the auth/permission logic by hand, not
  by clicking through a running instance.

---

# Increment 5 — full audit pass (this session)

Went through the whole app systematically rather than re-testing the same
things: traced every Firestore query for missing composite indexes, every
collection reference for missing security rules, and parsed all four HTML
files with a real HTML parser (not just tag-counting) to catch structural
bugs. Found several real, concrete issues:

## Missing Firestore composite indexes (would crash at runtime)

Traced every `.where()` + `.orderBy()` combination across every route file
and both `admin.html`/`index.html`. `firestore.indexes.json` was badly
incomplete — it had **zero** indexes for `consultations` despite four
different query shapes needing them, and the one index I'd added for
`prescriptions` in an earlier increment (`patientId + status`) didn't
match any query that actually exists in the code — I'd guessed instead of
checking. Any of these missing indexes would make the query throw
`FAILED_PRECONDITION` in production. Rewrote the file with all 11 indexes
it actually needs, each verified against a real query:
`orders` (×3), `prescriptions` (×2), `consultations` (×4), `payments`,
`audit_logs`.

## Missing Firestore rule silently broke "mark as delivered"

`admin.html`'s order-status flow writes a `sales` record and decrements
product stock inside one `Promise.all()`, then updates the order status
afterward. There was no rule for the `sales` collection, so it fell
through to deny-all — meaning that write threw, `Promise.all` rejected,
and **the order status update never ran either**. This meant admins could
not mark orders as delivered at all. Added the missing rule
(clinical-staff create, immutable).

## Structural HTML bugs (found via a real parser, not tag-counting)

Simple open/close tag counting gives false negatives when two separate
bugs happen to cancel out numerically, so I used Python's `HTMLParser`
with a real tag stack to trace actual nesting:

- `index.html`: `map-section`'s closing `</section>` was missing
  entirely. The next section (`team-section`) ended up **nested inside**
  it in the real DOM instead of being a sibling — could inherit unwanted
  layout constraints from the map section's container. Fixed by adding
  the missing close and removing the resulting stray extra tag.
- `shop.html`: the order-success modal had two stray `</div>` and a
  misplaced `</section>` that didn't match the `<section><div id="modal-
  X">...</div></section>` pattern every other modal on the page follows.
  My first attempt at fixing this was wrong — I removed two `</div>` that
  turned out to be the legitimate closers for the outer `modal-bg`/
  `modal-box` wrapper (opened much earlier, around the login modal) — and
  I caught that immediately by re-running the parser check right after,
  which surfaced two newly-unclosed divs at EOF. Corrected it and
  re-verified clean.

All four HTML files (`index.html`, `admin.html`, `shop.html`,
`doctor.html`) now parse with zero structural issues.

## Minor cleanup

- `.env.example` had `MPESA_CALLBACK_URL`, which is never actually read —
  `routes/payments.js` builds the callback URL dynamically from
  `BASE_URL` instead. Removed it and left a comment explaining why, so it
  doesn't mislead whoever fills in `.env` next.

## What I checked and found clean

- Every other Firestore collection reference (`products`, `orders`,
  `prescriptions`, `deliveries`, `payments`, `doctors`, `users`,
  `audit_logs`, `config`) has a corresponding rule — `config` is
  correctly admin-SDK-only with no client rule needed (the API is the
  only path to it).
- All env vars referenced anywhere in server-side code are documented in
  `.env.example` (checked both plain `process.env.X` and destructured
  `const { X } = process.env` access patterns).
- `npm install` succeeds cleanly (279 packages), every `.js` file passes
  `node --check`, every inline `<script>` block across all four HTML
  files passes syntax checking, and the server boots to the expected
  failure point (missing real Firebase credentials) rather than crashing
  on a code error.

---

# Increment 6 — rider & delivery system integration (this session)

Same audit-first approach as the consultations work: traced the existing
delivery code end to end before building anything, which surfaced a bug
far more serious than anything about riders specifically.

## Critical: checkout was completely broken

`shop.html`'s cart sends a product's **SKU** as `productId` when placing
an order. `routes/orders.js` was looking that value up with
`.doc(item.productId)` — treating it as a Firestore document ID. Since
products have auto-generated doc IDs, a SKU essentially never matches
one, so **every real checkout 404'd** at the product-verification step.
This predates all rider/delivery work — it's a core, unrelated bug that
happened to surface while tracing how orders flow into deliveries. Fixed
the lookup to match by `sku`.

Fixing that exposed a second issue: stock would then have been
decremented at both order creation *and* delivery completion (see
below), double-counting every sale. Removed the creation-time decrement
— stock now only decrements once, at actual delivery — while still
checking availability (`stock < quantity`) at order time.

## Delivery/rider gaps found and fixed

- **No way to onboard a rider at all.** The admin rider panel literally
  said "Use set-role API to add riders" with nothing wired to call it —
  and `set-role` only works on an *existing* account anyway, it can't
  create one. Added `POST /api/delivery/riders` (mirrors the doctor
  equivalent from Increment 4): creates a real Firebase Auth account
  (`kerich_role: 'rider'`) + `users/{uid}` doc. Wired a real "+ Add
  Rider" button into `admin.html`.
- **"In Transit" bypassed rider assignment entirely.** The order-status
  dropdown could set `status: 'in_transit'` directly with no `riderId`,
  no ETA, no `deliveries` doc created — meaning a rider's queue (which
  filters by `riderId`) would never show that order. Replaced the direct
  option with a real "Assign Rider…" flow that calls the existing (but
  previously unused from any UI) `POST /api/delivery/assign`.
- **Rider-completed deliveries recorded no revenue.** `POST
  /api/delivery/:orderId/complete` skipped the stock decrement, sale
  record, and `paymentStatus` update that `admin.html`'s own
  mark-delivered flow does. If a rider ever completed a delivery through
  a rider portal, income simply wasn't recorded. Rewrote it to do exactly
  what the admin path does — batched, and ownership-checked (a rider can
  only complete their own assigned delivery).
- **Riders had no way to contact the patient.** Orders never stored a
  phone number at all. Added `patientPhone` to order creation (pulled
  from the patient's own profile), wired into both the admin orders table
  and the new rider portal's tap-to-call.
- **Location updates had no ownership check.** `PATCH
  /api/delivery/:orderId/location` let any authenticated rider update
  location on *any* order, not just their own assigned delivery — found
  while writing the API docs for this endpoint, not by symptom. Added the
  same ownership check `/complete` already had.

## New: `rider.html` (built from scratch — nothing existed before)

Real login gated on the `kerich_role: 'rider'` claim, live delivery queue
(`GET /api/delivery`, refreshed every 30s), tap-to-call patient,
tap-to-open-Maps/Navigate on the delivery address, and a "Mark Delivered"
action wired to the fixed `/complete` endpoint. Location sharing uses the
browser's `navigator.geolocation.watchPosition` and broadcasts to every
currently-active delivery the rider has (location lives per-order on the
`deliveries` doc, not per-rider, so a rider running two deliveries at
once needs both updated together).

## Also

- `scripts/seed.js` now seeds two rider accounts (`KerichRider2025!`),
  same pattern as doctor seeding.
- `admin.html`'s rider grid now shows a real active-delivery count per
  rider (cross-referenced against the live orders feed) instead of a
  hardcoded "Active" label for everyone.
- All docs (`README.md`, `docs/API_REFERENCE.md`, `docs/DATA_MODEL.md`,
  `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`) updated to match —
  written from the current code, not left describing the pre-fix
  behavior.

## Not done / scope notes

- No live map showing rider position — `PATCH .../location` and `GET
  .../track` both work, nothing renders the result on a map yet (same
  gap noted for consultations' lack of real-time push — a future
  increment, not faked here).
- No rider-side password reset flow, same as the doctor portal gap noted
  in Increment 4.

---

# Increment 7 — live order tracking map (this session)

## What's new

`index.html`'s order list now has a "🛵 Track" button on any order that's
`dispensed` or `in_transit`. It opens a modal with a live Leaflet map
(OpenStreetMap tiles — no API key required, unlike Google Maps JS SDK)
showing:

- 🏪 the pharmacy's location (from `GET /api/pharmacy/config`'s
  `latitude`/`longitude`)
- 🛵 the rider's live position, once assigned and once they've shared at
  least one location update — polled every 8 seconds while the modal is
  open
- 🏠 the delivery destination
- a dashed line from rider (or pharmacy, before a rider has moved) to the
  destination — a straight-line direction indicator, **not** a real
  routed path; that needs a routing API/key and wasn't in scope here
- a "your rider" card with name and a tap-to-call button
- the same status-stepper visual already used in the order list, plus a
  plain-language ETA line

## Backend change

`GET /api/delivery/:orderId/track` previously returned just
`{status, estimatedETA, delivery}`. Extended to also resolve and return
`rider: {name, phoneNumber}` (looked up server-side from the assigned
rider's `users/{uid}` doc) and `deliveryAddress`, so the frontend doesn't
need a second round-trip or direct access to a staff-only collection.

## CSP update

`server.js`'s Content-Security-Policy `styleSrc` didn't allow
`cdnjs.cloudflare.com` (only `scriptSrc` did) — needed to add it for
Leaflet's CSS file, which loads from the same CDN as its JS.

## A near-miss worth noting

While adding the tracking modal's CSS block, I initially deleted the
existing `.booking-chan-btn`/`.booking-when-btn` rules from the
consultation booking modal (Increment 3) by mis-scoping a `str_replace`.
Caught it immediately by grepping for those class names right after and
by re-running the HTML structure check, restored the rules in the same
turn. Flagging this so it's traceable rather than silently fixed.

## Scope notes

- Admin doesn't get a live map — `admin.html`'s delivery board still
  shows status/rider-activity counts, not a map. The ask here was
  specifically about the customer-facing "Glovo-style" tracking
  experience; a dispatcher-facing map showing all active riders at once
  would be a reasonable follow-up if wanted.
- The connecting line is straight, not road-routed (see above) — real
  routing needs a paid/keyed service this repo doesn't currently have
  configured.

---

# Increment 8 — full SEO pass (this session)

Audited every page's meta tags/headings/structured data first rather than
just adding more of what was already there. Found real gaps beyond the
surface-level metadata from Increment 2.

## The big one: no crawlable per-product URLs

`shop.html` is a single client-rendered page — all 1,470 active products
load via JS into one URL, with no individual page per product. That's a
genuine, significant SEO gap for a pharmacy with real inventory: no rich
snippets, nothing to rank for long-tail "panadol price Nairobi"-type
searches, nothing shareable. Fixed with a new `routes/seo.js`:

- **`GET /product/:sku`** — real server-rendered HTML per product: title,
  meta description, canonical URL, Open Graph, and `Product` +
  `BreadcrumbList` JSON-LD with live, accurate price/availability (never
  fabricated ratings or reviews — schema.org guidelines and Google's own
  structured-data policy treat fake review/rating markup as a violation).
  Links back to `shop.html?search={sku}` for actual cart/checkout rather
  than duplicating that logic.
- **`GET /sitemap.xml`** made dynamic — the old hand-written static file
  only listed 4 pages and could never scale to or stay in sync with a
  changing product catalog. Now generates entries for all 4 static pages
  plus every active product, `lastmod`-dated.
- **Linked from `shop.html`** — a sitemap alone doesn't get pages
  crawled/ranked without internal links pointing at them. Product names
  in both grid and list view now link to their `/product/:sku` page.
- Guarded the JSON-LD embedding against a `</script>` sequence inside any
  field breaking out of the script tag — low risk given the current data
  pipeline strips HTML from descriptions, but this endpoint serves live
  database content, not static developer-controlled text like the other
  JSON-LD blocks on the site, so it gets the defensive treatment they
  don't need.

## Other real gaps found and fixed

- **`news.html` had three completely broken images** — `news1.jpg`,
  `.jpg`, `.jpg` referenced files that don't exist anywhere in the repo,
  pre-existing and unrelated to SEO specifically but broken images hurt
  page-quality signals and were trivial to fix properly: replaced with
  three original SVG illustrations (own artwork, not reproductions of
  anything) with real `alt` text.
- **Zero meta tags at all on `news.html` and `Aboutus.html`** — no
  description, canonical, robots, or Open Graph. Both now match the
  standard already set on `index.html`/`shop.html`.
- **No `og:image` anywhere on the site** — generated a proper 1200×630
  branded share image (`images/og-default.png`, via an SVG source
  rasterized with cairosvg) and wired it into every public page's Open
  Graph and Twitter Card tags.
- **`shop.html` had no `<h1>`** — only a visually-hidden `<h2>`, which
  both skips a heading level and means the page has no actual top-level
  heading for search engines. Changed to `<h1 class="sr-only">` (kept
  invisible to preserve the compact shop UI, this is a real semantic fix
  not a visual one).
- **Missing `alt` text** — one image on `index.html` (the fixed logo).
- **`SearchAction` structured data added to `shop.html` — but only
  after making it real.** Declaring a `SearchAction` schema with a URL
  template that doesn't actually work would be exactly the kind of
  structured-data-doesn't-match-reality problem search engines penalize.
  So first: wired `shop.html`'s search box to read/write a `?search=`
  URL parameter (and `?category=`) via `history.replaceState`, so search
  results are now genuinely shareable/bookmarkable. *Then* added the
  `SearchAction` JSON-LD pointing at that now-functional URL pattern.
- **`BreadcrumbList` JSON-LD** added to `shop.html`, `news.html`,
  `Aboutus.html`, and the new product pages.
- Enhanced `index.html`'s existing `Pharmacy` JSON-LD with `geo`
  coordinates (matching the real seeded pharmacy location),
  `image`, `logo`, and `areaServed` — all real, verifiable data.
- CSP `styleSrc` didn't allow `cdnjs.cloudflare.com` even though
  `scriptSrc` did (needed for Leaflet's CSS in Increment 7) — same class
  of gap, fixed there too.

## Scope notes

- Product pages are intentionally minimal (no reviews, no related
  products, no full nutritional/dosage detail) — the goal was closing the
  crawlability gap, not rebuilding the shop's product-detail UX. Could be
  extended later.
- No hreflang/i18n — single-language (English) site, not needed yet.
- Didn't touch page load performance (render-blocking resources, etc.) —
  a related but distinct optimization area from what was asked.

---

# Increment 9 — consultation live chat + video/voice call (this session)

## The real constraint this had to solve first

Before writing any chat/call code: Firestore security rules can't run
queries, only direct document-ID lookups. Verifying "is this caller the
consultation's assigned doctor" needs to resolve a `uid` to a `doctors`
doc — but `doctors` used auto-generated IDs, so that resolution required
a query, which rules can't do. Fixed properly rather than working around
it: **a doctor's `doctors` collection document ID is now their own
Firebase Auth `uid`** (changed in `scripts/seed.js` and `POST
/api/consultations/doctors`, both now `.doc(uid).set(...)` instead of
`.add(...)`). This is what makes the new chat/call security rules
possible at all — `get(consultations/$(id)).data.doctorId == uid()` is a
direct, cheap lookup rules can actually do. `resolveDoctorId()` in
`routes/consultations.js` simplified accordingly (existence check instead
of a query).

## Live chat

- `consultations/{id}/messages` subcollection, real-time via Firestore
  `onSnapshot` (not REST polling — chat has to feel instant). Every
  message is permanent and **immutable** — rules allow `create`/`read`
  only, never `update`/`delete`. A chat transcript that could be silently
  edited after the fact isn't a real record, and "records of everything"
  was an explicit part of the ask.
- Built into both `index.html` (patient) and `doctor.html` (doctor) as a
  "Consultation Room" modal, available once a consultation is `confirmed`
  or `in_progress`.

## Live video/voice call

- Real WebRTC, 1:1, with Firestore-based signaling (the standard
  offer/answer/ICE-candidate exchange pattern — no third-party calling
  service, no API key needed). Either side can initiate; the other side
  sees an "is calling…" prompt and answers.
- Mute/camera toggle, local video preview, connection-state-aware status
  text ("Connecting…" → "On call" → "Call ended").
- **Disclosed limitation, not a silent gap**: only a free public STUN
  server is configured (`stun:stun.l.google.com:19302`), no TURN server.
  Most calls will connect fine; some on restrictive/symmetric-NAT
  networks won't without a TURN server, which needs either self-hosting
  (`coturn`) or a paid service. Documented in `docs/DATA_MODEL.md` and
  `docs/ARCHITECTURE.md` rather than left for someone to discover the
  hard way.

## Audit trail

- Chat messages are their own permanent record (see above — immutable
  by rule, not just by convention).
- Call lifecycle is written to `audit_logs`:
  `CONSULTATION_CALL_STARTED` (who, channel type) and
  `CONSULTATION_CALL_ENDED` (duration in seconds) — the same audit
  infrastructure already used for order/prescription events, not a new
  parallel system.
- **Admin visibility**: `admin.html`'s consultation "View" action was a
  crude `alert()` dump before this — rebuilt as a real modal showing
  consultation details, the full chat transcript, and the call audit
  trail together, so "records and audit of everything" actually means
  something an admin can look at, not just data sitting in Firestore
  nobody can see.

## Supporting infrastructure fixes

- `firestore.indexes.json`: added `consultationId+timestamp` for the new
  admin audit-trail query (same discipline as every other index in this
  file — derived from an actual query, not guessed).
- `server.js` CSP: added the STUN server to `connect-src` (CSP Level 3
  governs `RTCPeerConnection` network access, same as any other network
  request) and `cdnjs.cloudflare.com` was already covered from earlier
  increments.
- `server.js`: added an explicit `Permissions-Policy` header allowing
  camera/microphone (and geolocation, covering `rider.html`'s existing
  feature too) for same-origin. No policy existed before this — some
  hosting layers set a restrictive default that would otherwise silently
  break `getUserMedia` with no clear error for the person hitting it.
- `doctor.html` gained the Firestore client SDK for the first time (it
  previously only used Auth, going through the REST API for everything
  else) — necessary because chat/call genuinely need real-time listening,
  which the REST API pattern used everywhere else in that file doesn't
  provide.

## A mistake caught mid-edit, for the record

While inserting the consultation room modal into `index.html`, an earlier
`str_replace` closed a `<style>` block one line too early, orphaning the
existing Leaflet marker-icon CSS rules (`.kp-rider-icon` etc. from
Increment 7) as raw unwrapped text in the page body. Caught it by
re-running the HTML structure check immediately after (as this whole
project has done after every markup edit), found the stray `</style>`,
and merged the new rules into the existing block instead of leaving two
separate ones. Fixed in the same turn, verified clean afterward.

## What "confirm the consultation system is fully working" actually
## means here

Booking, doctor assignment, status transitions, chat, and calls all pass
syntax and structural verification, and the security-rules logic was
traced by hand against every access path (patient-own, assigned-doctor,
staff, and explicitly-not-anyone-else). That is **not** the same as
having exercised the system against a live Firestore project with two
real browser sessions actually placing a call to each other — that
hasn't happened in this environment, the same caveat as everything else
built this session. The concrete next step, if you want real confidence
before relying on this with real patients: seed the two rider/doctor
test accounts, open the patient and doctor portals in two separate
browser windows, book a consultation between them, and actually send a
message and place a call.

---

# Increment 10 — accessibility: theme, text size, reduced motion (this session)

## What's built

A floating widget (bottom-left, avoids the existing bottom-right toast
containers and shop's floating cart) on all 7 pages —
`index.html`, `shop.html`, `admin.html`, `doctor.html`, `rider.html`,
`news.html`, `Aboutus.html`:

- **Light/dark theme** — toggles a `data-theme` attribute on `<html>`,
  overridden in the new shared `public/css/accessibility.css`.
- **Text & UI size** — four steps (90%–125%) via CSS `zoom`, not a
  `rem`-based scale (see rationale below).
- **Reduced motion** — collapses animation/transition durations to
  near-zero.
- All three persist per-browser in `localStorage` and are re-applied on
  every page load via a small blocking inline snippet at the very top of
  `<head>`, specifically to avoid a flash of the wrong theme before the
  full widget script (which is `defer`red) loads.

Implementation is two shared files (`public/css/accessibility.css`,
`public/js/accessibility.js`) referenced identically from all 7 pages —
the one part of this frontend that isn't duplicated per-page, since
there was no reason to duplicate it.

## Why `zoom` instead of scaling font-size

This codebase is built almost entirely with fixed `px` values, not
`rem`. Changing the root font-size (the usual accessibility approach)
wouldn't cascade to most text at all under that setup. CSS `zoom` scales
the whole rendered layout together — text, buttons, spacing — which
actually works with what's here, and arguably serves low-vision users
better than text-only scaling anyway. Supported in every evergreen
browser (Firefox added it in version 126, 2024, well before this
build).

## `news.html` and `Aboutus.html` needed refactoring first

Light-mode overrides work by redefining CSS custom properties — but
`news.html` had no CSS variables at all (hardcoded hex throughout), and
`Aboutus.html` only had a partial set. Neither could support a theme
toggle without variables to override, so both were refactored:
`news.html` gained a `:root` block and had every hardcoded color in its
stylesheet replaced with the corresponding variable; `Aboutus.html`'s
existing variables were extended to cover a few more raw hex instances
that had bypassed them.

## A real mistake, caught and fixed in the same pass

While refactoring `Aboutus.html`, two "dark text on a gold button"
color rules got mapped to `var(--dark)` — which is correct for
background/foreground pairs that should flip with the theme, but wrong
here: the button's gold background doesn't change between themes, so
its text needs to **stay** dark for contrast regardless of theme. Mapping
it to `var(--dark)` would have made that text flip to near-white in
light mode and disappear against the still-gold background. Caught by
reasoning through what light mode would actually render (this sandbox
can't render pages to check visually), not by a symptom — fixed to a
fixed `#1A1200` instead. This is also why the remaining raw hex colors
in `index.html`/`shop.html`/`admin.html`/`doctor.html` (badge and
button text on colored backgrounds, same pattern) were deliberately
**not** converted to variables — they're already correct as fixed
values, and converting them would have reintroduced the same bug across
more files.

## Also fixed while here

`FIXES-APPLIED.md` itself had an ordering bug — Increment 5's entry had
ended up appended after Increment 9 instead of between 4 and 6, from an
earlier turn's edit matching the wrong anchor text. Reordered it into
correct chronological sequence.

## Scope notes

- No system-preference detection (`prefers-color-scheme`,
  `prefers-reduced-motion`) — the widget is manual-only. Could layer
  system-preference as the *default* before any explicit user choice is
  saved, as a follow-up.
- No dedicated high-contrast mode beyond what light/dark already
  provides.
- Verified via syntax/structure checks and by reasoning through the CSS
  cascade and specificity by hand — not by rendering the pages, which
  this environment can't do. The Aboutus.html mistake above is a
  concrete example of why that distinction matters here.

---

# Increment 11 — email/SMS notifications (this session)

Kicked off by uploading five formal requirement documents (BRD, SAD,
NFRS, FRS, and a 745-page combined SRS) and asking for the whole
documented scope, "keeping all existing functionalities still." Given
the BRD's own timeline estimates 30–34 weeks with a full team for that
full scope, the response was a gap analysis first
(`docs/GAP_ANALYSIS.md`) mapping every FRS requirement against what
actually exists, rather than guessing at what to build. This increment
is the first, highest-priority item from that analysis: **customers were
getting zero email or SMS for orders, prescriptions, or consultations —
everything happened silently server-side.**

## What's built

`services/notifications.js` — email via SMTP (nodemailer, any provider)
and SMS via Africa's Talking's REST API (the standard choice for Kenyan
businesses). Both degrade gracefully when unconfigured: log a warning,
return without throwing — same pattern as the existing Stripe/M-Pesa
credential checks, so a missing env var never breaks the order/
prescription/consultation operation itself.

Wired into every real event:
- Order placed → confirmation email + SMS
- Order status changes (processing/dispensed/in_transit/delivered/
  cancelled) → SMS, plus email on delivered/cancelled
- Prescription approved/rejected → email
- Consultation booked → email; confirmed/cancelled/declined → email,
  plus SMS on confirmed

## A real architecture wrinkle, handled without touching working code

`admin.html`'s order-status flow writes directly to Firestore
client-side — it has its own already-verified stock-decrement/sales-
recording logic for `delivered` (fixed once already, see Increment 5).
Rerouting it through the REST API to fire notifications would have
meant re-risking that logic for no good reason. Instead: a narrow
`POST /api/orders/:id/notify-status` endpoint that *only* sends the
notification, called from `admin.html` right after its existing
Firestore write succeeds. The REST `PATCH /api/orders/:id/status` and
`routes/delivery.js`'s `/complete` (rider path) both fire notifications
directly, since they already own the Firestore write.

## Also found and fixed while here

- **A genuine nodemailer security issue almost shipped.** The initial
  `^6.9.15` version constraint resolved to a range with multiple real
  vulnerabilities patched in 9.0.5+ (SMTP command injection, CRLF
  injection enabling header injection, SSRF via the `raw` message
  option, improper TLS certificate validation). Caught by running
  `npm audit` after install — routine for every increment in this
  project — not by assuming a version number was safe. Bumped to
  `^9.0.5` and re-verified the API surface used
  (`createTransport`/`sendMail`) is unchanged.
- **Dead, duplicate, buggy code removed.** `routes/orders.js` had an
  unused `POST /:id/assign-rider` endpoint that set `status: 'in_transit'`
  directly without creating the `deliveries` tracking document — the
  exact bug already fixed in `admin.html`'s UI back in Increment 6,
  just never removed from the API itself. Confirmed nothing calls it,
  removed it as a footgun for any future caller.
- **Repeated a documentation mistake from Increment 10 — caught and
  fixed the same way.** Editing `docs/ARCHITECTURE.md`'s "Known gaps"
  section, a `str_replace` swapped the "no notifications" bullet for a
  new Notifications section but dropped the `## Known gaps` heading
  itself in the process — identical mistake to Increment 10's
  `FIXES-APPLIED.md` reordering slip. Caught immediately by re-grepping
  headings after the edit (the same check that's run after every
  markdown edit in this project) and restored it in the same turn.

## Scope notes

- No notification preferences UI (opt out of SMS, email digest
  frequency, etc.) — every event notifies every time.
- No retry/queue for failed sends — a failed email or SMS is logged and
  dropped, not retried. For a production deployment handling real
  volume, a proper queue (even a simple one) would be worth adding.
- This is one item off `docs/GAP_ANALYSIS.md` — see that document for
  the full remaining scope and recommended sequencing (support
  ticketing, CMS/blog/careers, wishlist/discounts, GA4/Search Console,
  PWA, and the Learning Management System, roughly in that order).

---

# Increment 12 — Vercel deployment support (this session)

Triggered by a real 404 report: `/api/pharmacy/products` and
`/api/pharmacy/config` both 404ing from a `vercel.app` URL. Not a code
bug — a genuine deployment gap. Firebase Hosting (the only deployment
path documented before this) only serves static files; a plain Vercel
deployment of this repo has the same problem for a different reason —
with no Vercel-specific config, Vercel doesn't know to run `server.js`
at all, so every `/api/*` request 404s regardless of what the code does.

## What's built

- **`api/index.js`** — a one-line Vercel entry point that re-exports the
  same Express `app` from `server.js`. Vercel's convention is to treat
  anything in `/api` as a serverless function; this avoids putting real
  logic in two places.
- **`vercel.json`** — routes *every* request (static files, `/api/*`,
  and the dynamic `/product/:sku` + `/sitemap.xml` routes from Increment
  8) through that one function, so Express handles everything exactly
  like it does under normal Node hosting. Deliberately not splitting
  static/dynamic routing — doing so risks missing the server-rendered
  routes, which need Express and can't be served as plain static files.
- **`server.js`**: `app.listen()` (and the process-signal handlers that
  only make sense for a long-running process) now skip when
  `process.env.VERCEL` is set — Vercel sets this automatically, and a
  serverless function must never call `.listen()` itself. Everywhere
  else (local dev, a VM, Render) this is unchanged.

## Verified, not assumed

Traced the actual initialization order first: `initFirebase()` inside
`initializeServices()` has no real `await` in it, so calling it runs
synchronously to completion before `module.exports = app` executes —
there's no race condition between Firebase Admin init and the app being
ready to handle a request, even on a cold serverless start.

Then verified the `app.listen()` guard actually behaves correctly by
mocking `firebase-admin` (real credentials aren't available in this
environment) and booting `server.js` twice — once normally, once with
`VERCEL=1`. Normal mode printed the startup banner and bound port 3999
as before; `VERCEL=1` mode initialized Firebase fine but never printed
the banner or attempted to bind a port, confirming the guard actually
engages rather than just looking correct on inspection.

## Documentation

`docs/DEPLOYMENT.md` gets a full "Deploying to Vercel" section —
including the two Vercel-specific gotchas worth calling out explicitly:
`serviceAccountKey.json` won't be part of the deployment (git-ignored),
so use the `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` env vars
instead; and `BASE_URL` needs to be the real Vercel URL, since the
M-Pesa callback URL is built from it and Safaricom's servers need
something actually reachable to call back.

## Scope note

Routing all traffic through one serverless function means static assets
(images, CSS, JS) are served by that function rather than Vercel's CDN
serving them directly — a deliberate trade-off given the alternative
risks breaking the dynamic product/sitemap routes, documented plainly in
`docs/DEPLOYMENT.md` rather than left for someone to notice as a
performance mystery later.



