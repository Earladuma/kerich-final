# API Reference

Base URL: `http://localhost:3001` (local) — all routes below are relative
to that, e.g. `POST /api/orders` = `POST http://localhost:3001/api/orders`.

## Auth

Every endpoint marked **🔒 Auth** requires an `Authorization: Bearer
<Firebase ID token>` header. Get a token client-side with
`user.getIdToken()`. Endpoints marked with a role (e.g. **🔒 admin**)
additionally require that `kerich_role` custom claim.

Rate limits: all `/api/*` routes share a global limiter; `/api/auth/*` has
a stricter one on top of that (see `server.js`).

---

## Auth — `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | — | Create a patient account |
| POST | `/set-role` | 🔒 admin | Assign a role to another user |
| GET | `/me` | 🔒 | Get your own user profile |
| POST | `/logout` | 🔒 | Revoke refresh tokens (forces re-login everywhere) |

**POST `/register`**
```jsonc
// body
{ "email": "...", "password": "...", "displayName": "...", "phoneNumber": "+254...", "role": "patient" }
```
Only `role: "patient"` is honored from the client — anything else is
silently downgraded to `patient`. Creates the Firebase Auth user, sets
the `kerich_role: 'patient'` claim, creates the matching `users/{uid}`
Firestore doc (with an empty `healthProfile` and a Kenya DPA 2019 consent
record), and writes a `USER_REGISTERED` audit log entry. Returns `409` if
the email is already registered.

**POST `/set-role`** — 🔒 admin only (checked via the caller's own
`kerich_role`, not the `requireRole` middleware — same effect).
```jsonc
{ "uid": "...", "role": "pharmacist" }   // one of: patient, pharmacist, doctor, rider, admin
```
Note: for doctors specifically, prefer `POST /api/consultations/doctors`
(see below) — it also creates the linked `doctors/{id}` record, which
this endpoint does not.

---

## Pharmacy — `/api/pharmacy`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/products` | — | List active products (search/filter/paginate) |
| GET | `/products/:id` | — | Get one product |
| POST | `/products` | 🔒 admin/pharmacist | Create a product |
| PATCH | `/products/:id` | 🔒 admin/pharmacist | Update a product |
| GET | `/config` | — | Pharmacy contact/address/delivery-fee config |
| PATCH | `/config` | 🔒 admin | Update pharmacy config |
| GET | `/inventory` | 🔒 admin/pharmacist | Full inventory incl. inactive/out-of-stock |
| PATCH | `/inventory/:id/stock` | 🔒 admin/pharmacist | Adjust stock level |

**GET `/products`** — query params: `category`, `type` (`otc`\|`rx`),
`search`, `limit` (default 50, capped at 5000). Returns
`{ products: [...] }`, each with `id, sku, name, price, category,
rawCategory, type, icon, image, description, active, stock`.

**POST/PATCH `/products`** — validates server-side: `name` non-empty
string ≤300 chars, `price` non-negative number, `stock` non-negative
integer, `type` must be `otc`/`rx`, `category`/`sku` length-capped.
Returns `400` with `{ error, details: [...] }` on validation failure —
never silently coerces bad input.

**GET/PATCH `/config`** — `GET` is public (returns `name, address, phone,
email, website, openingHours, deliveryRadius, deliveryFee,
freeDeliveryAbove, latitude, longitude`). `PATCH` is admin-only, merges
into the existing doc, validates numeric fields are actually numbers.

---

## Orders — `/api/orders` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | 🔒 patient | Place an order |
| GET | `/` | 🔒 | List orders — own (patient) or all (admin/pharmacist/rider) |
| GET | `/:id` | 🔒 | Get one order |
| PATCH | `/:id/status` | 🔒 admin/pharmacist/rider | Update order status |
| POST | `/:id/notify-status` | 🔒 admin/pharmacist/rider | Fire a status-change notification without touching Firestore |

**POST `/`**
```jsonc
{
  "items": [{ "productId": "AMS002", "quantity": 2, "prescriptionId": "..." /* required if the product is type:'rx' */ }],
  "deliveryAddress": { "street": "...", "city": "...", "lat": -1.28, "lng": 36.79 },
  "paymentMethod": "mpesa",   // mpesa | card | insurance
  "notes": ""
}
```
Despite the field name, `items[].productId` is actually the product's
**SKU** (that's what `shop.html`'s cart sends) — looked up via
`where('sku','==',...)`, not `.doc()`. Server re-verifies every product
exists, is active, has enough stock, and (for Rx items) has a
`prescriptionId` attached — never trusts client-side prices or stock.
Pulls `patientPhone` from the caller's own `users/{uid}` profile so
riders have a way to actually contact them (see `docs/DATA_MODEL.md`).
Generates a human-readable `orderId` like `KP-2026-0042`.

**Stock is not decremented at order time** — only the availability check
runs here (`stock < quantity` → `400`). The actual decrement happens
once, at delivery completion (`admin.html`'s mark-delivered flow, or
`POST /api/delivery/:orderId/complete`) — see `docs/DATA_MODEL.md` for
why doing it at both points would double-count.

Valid statuses:
`pending → confirmed → processing → dispensed → in_transit → delivered`,
or `cancelled` at any point. Note: an order should reach `in_transit`
*only* via `POST /api/delivery/assign` (which also creates the
`deliveries` tracking doc) — setting `status: 'in_transit'` directly via
`PATCH /:id/status` with no rider assigned means no rider's queue will
ever pick it up. `admin.html`'s UI enforces this (the status dropdown
routes through "Assign Rider…" instead of a raw status write); if you're
calling the API directly, do the same. (A duplicate, buggy
`POST /:id/assign-rider` endpoint that bypassed the `deliveries`
collection used to exist here — removed once confirmed unused, see
`FIXES-APPLIED.md`.)

**POST `/:id/notify-status`** — fires the customer email/SMS for a
status change (see `docs/ARCHITECTURE.md`'s Notifications section)
without writing to Firestore. Exists because `admin.html`'s order-status
flow writes directly to Firestore client-side rather than through this
API — call this right after that write succeeds. `{ status }` in the
body, same valid values as `PATCH /:id/status`.

---

## Prescriptions — `/api/prescriptions` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | 🔒 patient | Upload a prescription (multipart) |
| GET | `/` | 🔒 | List — own (patient) or all (admin/pharmacist) |
| PATCH | `/:id/verify` | 🔒 admin/pharmacist | Verify or reject |

**POST `/`** — `multipart/form-data`, field name `file` (jpg/png/pdf,
10MB max). Also accepts `medicines` (JSON string or array),
`doctorName`, `doctorLicence`, `notes`. Uploads to Firebase Storage under
`prescriptions/{uid}/{timestamp}-{filename}`, generates a 7-day signed
URL, sets `status: 'pending_verification'`, writes a
`PRESCRIPTION_UPLOADED` audit log entry (PPB requirement). Approval/
rejection (`PATCH /:id/verify`) sends the patient an email —
see `docs/ARCHITECTURE.md`'s Notifications section.

---

## Consultations — `/api/consultations` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/doctors` | 🔒 | Public-safe doctor list (patient-facing) |
| GET | `/doctors/me` | 🔒 doctor | Your own doctor profile |
| PATCH | `/doctors/me/availability` | 🔒 doctor | Toggle your own availability |
| POST | `/doctors` | 🔒 admin | Create a doctor + linked login account |
| POST | `/` | 🔒 patient | Book a consultation |
| GET | `/mine` | 🔒 | Your own bookings (patient) |
| GET | `/doctor/mine` | 🔒 doctor/admin | A doctor's own queue |
| PATCH | `/:id/cancel` | 🔒 | Cancel (owner or staff) |
| GET | `/` | 🔒 admin/pharmacist | List all consultations |
| PATCH | `/:id` | 🔒 staff or assigned doctor | Update status/notes |

**GET `/doctors`** — deliberately strips `uid`/`email` (those exist on
the Firestore doc to link a doctor's login account, and must never reach
an unauthenticated/patient-facing response). Returns `id, name,
speciality, licence, fee, available, rating, reviews`.

**POST `/`**
```jsonc
{
  "doctorId": "...",
  "channel": "video",           // video | voice | chat
  "reason": "...",               // optional, ≤500 chars
  "scheduledFor": "2026-08-05T14:00:00Z"   // omit for "book now" — requires doctor.available == true
}
```
`400` if the doctor doesn't exist, `409` if booking "now" against an
unavailable doctor. Creates with `status: 'requested'`, and emails the
patient a booking confirmation. Any subsequent status change (via
`PATCH /:id` or `PATCH /:id/cancel`) also notifies the patient where
the new status is customer-facing (`confirmed`, `cancelled`, `declined`)
— see `docs/ARCHITECTURE.md`'s Notifications section.

**PATCH `/:id`** — `{ status, notes }`, both optional but at least one
required. `status` must be one of `requested, confirmed, in_progress,
completed, cancelled, declined`. Admin/pharmacist can update any
consultation; a `doctor`-role caller can only update one where
`doctorId` matches their own linked doctor record (resolved via the
`uid` field on the `doctors` doc — see `DATA_MODEL.md`).

**POST `/doctors`** — 🔒 admin only.
```jsonc
{ "name": "Dr. ...", "email": "...", "speciality": "...", "licence": "...", "fee": 1000 }
```
Creates (or reuses, if the email already has an account) a Firebase Auth
account with `kerich_role: 'doctor'`, a `doctors/{id}` Firestore doc
linked via `uid`, and a `users/{uid}` doc. Response includes
`defaultPassword` (`KerichDoctor2025!`) — the caller (admin.html) is
expected to relay this to the doctor and have them change it.

---

## Delivery — `/api/delivery` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/riders` | 🔒 admin | Create a rider + linked login account |
| GET | `/` | 🔒 admin/pharmacist/rider | Active deliveries (own, if rider) |
| GET | `/riders` | 🔒 admin/pharmacist | List riders |
| POST | `/assign` | 🔒 admin/pharmacist | Assign a rider to an order |
| PATCH | `/:orderId/location` | 🔒 rider | Update GPS location |
| POST | `/:orderId/complete` | 🔒 rider/admin | Mark delivered |
| GET | `/:orderId/track` | 🔒 | Patient tracks their own delivery |

**POST `/riders`** — mirrors `POST /api/consultations/doctors`. Riders
have no separate collection (unlike doctors) — this just creates a real
Firebase Auth account (`kerich_role: 'rider'`) and a `users/{uid}` doc.
```jsonc
{ "name": "...", "email": "...", "phoneNumber": "+254..." }
```
Response includes `defaultPassword` (`KerichRider2025!`) for the admin to
relay. Rider signs in at `rider.html`.

**POST `/assign`** — `{ orderId, riderId }`. Sets a 45-minute estimated
ETA, flips the order to `in_transit`, creates a `deliveries/{orderId}`
tracking document. This is the *only* correct way to move an order into
`in_transit` — see the note in the Orders section above.

**POST `/:orderId/complete`** — does everything `admin.html`'s
client-side mark-delivered flow does: flips order status to `delivered`,
sets `paymentStatus: 'paid'`, decrements stock for every item (matched by
SKU), and writes a `sales` record. A `rider`-role caller can only
complete a delivery assigned to them (`403` otherwise); `admin` can
complete any. Returns `409` if the order is already `delivered`.

**PATCH `/:orderId/location`** — `{ lat, lng }`. Rider-only, and the
server verifies the order's `riderId` matches the caller (`403`
otherwise) — not just relying on `rider.html` to only call it for its own
deliveries. `rider.html` broadcasts the same position to every currently
active delivery the rider has, since location lives per-order on the
`deliveries` doc rather than per-rider.

**GET `/:orderId/track`** — used by `index.html`'s live tracking map.
Returns `{ orderId, status, estimatedETA, deliveryAddress, delivery:
{riderId, status, location {lat,lng}|null, ...}, rider: {name,
phoneNumber}|null }`. `rider` is resolved server-side from the assigned
rider's `users/{uid}` doc — the frontend never queries that collection
directly (it's staff-only, see `docs/DATA_MODEL.md`).

---

## Payments — `/api/payments`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/mpesa/initiate` | 🔒 | Trigger an M-Pesa STK push |
| POST | `/mpesa/callback` | — (public — Safaricom calls this) | M-Pesa payment confirmation |
| POST | `/stripe/process` | 🔒 | Process a card payment |
| GET | `/:orderId` | 🔒 | Get payment record(s) for an order |

**Important**: `/mpesa/callback` is intentionally **not** behind
`authenticateToken` — Safaricom's server calls it directly with no bearer
token. Don't "fix" this by adding auth back (see `FIXES-APPLIED.md`
Increment 1 — this was a real bug that broke M-Pesa payments entirely
until it was found and fixed).

**POST `/mpesa/initiate`** — `{ orderId, phoneNumber, amount }`. Verifies
the order belongs to the calling patient before initiating. Saves a
`payments` doc with `status: 'pending'`; the callback endpoint updates it
to `completed`/`failed` when Safaricom responds.

---

## Compliance — `/api/compliance` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/report` | 🔒 admin | 30-day PPB compliance report |
| GET | `/audit-log` | 🔒 admin | Query the audit log |
| POST | `/data-access` | 🔒 | Patient requests their own data (Kenya DPA 2019) |

**GET `/report`** — aggregates orders/prescriptions/patients from the
last 30 days: prescription verification rate, order totals/revenue,
patient count, and the last 100 audit log entries.

---

## Users — `/api/users` (🔒 all routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | 🔒 admin | List users (filter by `role`) |
| GET | `/:uid` | 🔒 | Get a user (self or staff) |
| PATCH | `/:uid` | 🔒 | Update a user (self or staff) |
| GET | `/:uid/health-record` | 🔒 | Dashboard: profile + recent Rx/orders/consultations |
| DELETE | `/:uid` | 🔒 | Deactivate a user |

---

## SEO — public HTML routes (not under `/api`, no auth)

Unlike everything else in this document, these two routes render HTML/XML
directly rather than JSON — they exist because `shop.html` is a single
client-rendered page with no individually crawlable URL per product,
which is a real SEO gap for a 1,470-product catalog (see
`docs/ARCHITECTURE.md`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/product/:sku` | Server-rendered product landing page |
| GET | `/sitemap.xml` | Dynamically generated sitemap (static pages + every active product) |

**GET `/product/:sku`** — looks the product up by SKU (same lookup
pattern as everywhere else — see the Orders section above), returns
`404` with a small branded not-found page if missing or inactive.
Renders real `<title>`/meta description/canonical/Open Graph tags and
`Product` + `BreadcrumbList` JSON-LD with accurate, live price and
availability (never fabricated — pulled straight from Firestore). The
page itself is a lightweight read-only summary with a prominent link to
`shop.html?search={sku}` for actually adding to cart — it doesn't
duplicate the shop's cart/checkout logic.

**GET `/sitemap.xml`** — supersedes what used to be a static file.
Generates `<url>` entries for the 4 static pages plus every product
where `active == true`, with `lastmod` set to the current date. Product
URLs point at `/product/:sku` (properly `encodeURIComponent`-escaped —
tested against SKUs containing `&` and spaces during development).

## Error shape

Every error response is `{ "error": "<short message>" }`, sometimes with
a `details` array for validation failures. HTTP status codes are used
meaningfully: `400` validation, `401` no/bad token, `403` wrong role or
not the resource owner, `404` not found, `409` conflict (e.g. booking an
unavailable doctor), `502` upstream provider error (M-Pesa/Stripe), `500`
unexpected server error (logged, generic message returned to the
client).
