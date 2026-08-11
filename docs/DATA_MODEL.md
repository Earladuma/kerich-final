# Data Model

Firestore project: `kerich-4aefa`. All collections are top-level
(no subcollections currently used).

## Collections

### `products`
Seeded from `data/products.json` (9,032 docs — see below). Fields:
`sku, name, price, category, rawCategory, type (otc|rx), icon, image,
description, active, stock, unitCost, createdAt, updatedAt`.

- **Rules**: public read where `active == true`; full read + create/update
  for pharmacist/admin; delete admin-only.
- **Indexes**: none needed — `GET /api/pharmacy/products` only combines
  equality filters (`active`, `category`, `type`) with no `orderBy`,
  which Firestore serves from automatic single-field indexes.

### `orders`
`orderId` (human-readable, e.g. `KP-2026-0042`), `patientId,
patientEmail, patientPhone, items[], total, deliveryAddress {street,
city, lat, lng}, paymentMethod, paymentStatus, status, statusHistory[],
riderId, notes, estimatedETA, createdAt, updatedAt`. `patientPhone` is
pulled from the patient's `users/{uid}` profile at order time (riders
need a way to actually contact them). `items[].productId` holds the
product's **SKU**, not a Firestore document ID — `shop.html`'s cart uses
SKU as the item identifier throughout, and `routes/orders.js` /
`routes/delivery.js` both look products up via `where('sku','==',...)`
accordingly. Stock is decremented once, at delivery completion, not at
order creation — see the note in `docs/API_REFERENCE.md`'s Orders
section for why doing it at both points would double-count.

- **Rules**: patient reads/creates own; clinical staff + rider read any;
  clinical staff + rider update status; no client deletes.
- **Indexes**: `patientId+createdAt`, `status+createdAt`,
  `patientId+status+createdAt` (a patient filtering their own orders by
  status combines all three fields).

### `prescriptions`
`patientId, patientEmail, medicines[], doctorName, doctorLicence, notes,
fileUrl, filePath, status (pending_verification|verified|rejected),
verifiedBy, verifiedAt, rejectionReason, expiryDate, createdAt,
updatedAt`. File itself lives in Cloud Storage at
`prescriptions/{uid}/{timestamp}-{filename}`, `fileUrl` is a 7-day signed
URL (regenerate if it expires and is still needed).

- **Rules**: patient reads/creates own; clinical staff read/verify any.
- **Indexes**: `patientId+createdAt` (patient's own list),
  `status+createdAt` (admin's pending-verification queue in `admin.html`).

### `consultations`
`patientId, patientName, patientEmail, patientPhone, doctorId,
doctorName, doctorSpeciality, fee, channel (video|voice|chat), reason,
status (requested|confirmed|in_progress|completed|cancelled|declined),
scheduledFor (Timestamp|null — null means "ASAP"), notes, createdAt,
updatedAt`.

- **Rules**: patient reads own + clinical staff read any; any
  authenticated user can create (booking); clinical staff update
  (the API additionally allows the *assigned doctor* to update their own
  — enforced in `routes/consultations.js`, not expressible as a simple
  Firestore rule since it requires a lookup into `doctors` to resolve
  which doctor the caller is).
- **Indexes**: `patientId+createdAt`, `doctorId+createdAt`,
  `doctorId+status+createdAt`, `status+createdAt` — four different query
  shapes across the patient list, doctor queue (with/without a status
  filter), and admin list (with a status filter).

### `doctors`
`name, speciality, licence, fee, available, rating, reviews, uid, email,
createdAt`. **Document ID is the doctor's own Firebase Auth `uid`** (not
an auto-generated ID) — this is what lets Firestore *security rules*
verify "is this the assigned doctor" on a consultation via a direct
`get()` lookup, since rules cannot run queries (only doc-ID lookups).
Every place that creates a doctor (`scripts/seed.js`, `POST
/api/consultations/doctors`) uses `.doc(uid).set(...)`, never `.add()`.

- **Rules**: read restricted to clinical/admin staff (**not** public —
  the patient-facing list goes through `GET /api/consultations/doctors`,
  which strips `uid`/`email` before responding; a public Firestore rule
  would leak those fields to any client). Write: admin only.
- **Indexes**: none — doc-ID lookups don't need one.

### `consultations/{id}/messages` (subcollection)
The permanent chat record for a consultation. `senderId, senderName,
senderRole (patient|doctor), text, type (text|system), createdAt`.
Written directly by the client (Firestore SDK, not the REST API) for
real-time delivery via `onSnapshot` — a REST/polling approach would be
noticeably laggy for a live chat. **Immutable**: rules allow `create`
and `read` only, never `update`/`delete` — a chat transcript that could
be edited after the fact isn't a real record.

- **Rules**: readable/writable only by the consultation's patient, its
  assigned doctor (verified via the `doctors`-doc-ID-equals-uid trick
  above), or clinical staff. Message length capped at 4000 chars,
  `senderId` must match the caller's own uid (can't send as someone
  else).
- **Indexes**: none needed — single `orderBy` on a subcollection query
  is covered by Firestore's automatic indexing.

### `calls/{consultationId}`
WebRTC signaling for consultation video/voice calls — `offer, answer,
withVideo, initiatedBy, status, createdAt`, plus `callerCandidates` and
`calleeCandidates` subcollections for ICE candidate exchange (the
standard Firebase WebRTC signaling pattern). **This collection is
plumbing, not the record** — it's deleted when a call ends. The actual
permanent record of a call (who, when, how long) is written to
`audit_logs` (`CONSULTATION_CALL_STARTED`/`CONSULTATION_CALL_ENDED`)
by the client at call start/end.

- **Rules**: read/write restricted to the consultation's patient,
  assigned doctor, or clinical staff — same ownership check as messages.
- **No TURN server is configured** — only a free public STUN server
  (`stun:stun.l.google.com:19302`). Calls on some restrictive/symmetric-
  NAT networks may fail to connect; a TURN server (self-hosted `coturn`
  or a paid service) would fix this but wasn't set up here. Disclosed
  limitation, not a silent gap.

### `deliveries`
Keyed by `orderId`. `riderId, status, estimatedETA, location {lat,lng},
startedAt, completedAt, locationUpdated`. Created by `POST
/api/delivery/assign`, updated by the assigned rider.

- **Rules**: clinical staff + assigned rider read/update.

### `payments`
`orderId, patientId, method (mpesa|stripe), amount, phoneNumber,
mpesaRequestId, status (pending|completed|failed), createdAt`.

- **Rules**: patient reads own (via `orderId` ownership check), staff
  read any; writes are server-only (M-Pesa callback, Stripe processing)
  — no client create/update.
- **Indexes**: `orderId+createdAt`.

### `sales`
Revenue records, one per delivered order. Written by `admin.html` when an
order is marked delivered (alongside a stock decrement, in one
`Promise.all`).

- **Rules**: added in the audit pass in `FIXES-APPLIED.md` Increment 5 —
  this collection had **no rule at all** before, which silently broke the
  entire "mark as delivered" flow (the write threw, the surrounding
  `Promise.all` rejected, and the order status update after it never
  ran). Now: clinical staff create, clinical staff read, immutable
  (no update/delete).

### `users`
`uid, email, displayName, phoneNumber, role, status, healthProfile
{bloodGroup, allergies, conditions, emergencyContact}, dataConsent {given,
timestamp, version}, createdAt, updatedAt`.

- **Rules**: owner reads/updates own (except `role` — only admin can
  change that field); admin/pharmacist read any.

### `config`
Single doc: `config/pharmacy` — `name, ppbLicence, address, phone,
latitude, longitude, email, website, openingHours, deliveryRadius,
deliveryFee, freeDeliveryAbove, updatedAt, updatedBy`.

- **Rules**: no explicit rule — falls through to deny-all, which is
  *correct* here, not a bug. The only access path is `GET`/`PATCH
  /api/pharmacy/config` via the Admin SDK (bypasses rules); there's no
  legitimate reason for a client to read/write this collection directly.

### `audit_logs`
Append-only. `action, ...context fields vary by action, timestamp`.
Written by nearly every mutating action across the app (order created,
prescription uploaded, order delivered/cancelled, user registered,
`CONSULTATION_CALL_STARTED`/`CONSULTATION_CALL_ENDED` with
`consultationId` + `durationSeconds`, etc.) for PPB/DPA compliance
traceability.

- **Rules**: any authenticated client can create (not just server —
  `admin.html` writes some of these directly); only admin reads; no
  update/delete (immutable).
- **Indexes**: `action+timestamp` (admin's audit log filter, and `GET
  /api/compliance/audit-log`), `consultationId+timestamp` (the
  per-consultation call audit trail shown in admin.html's consultation
  detail view).

### `error_logs`
Server-only (see `firestore.rules` — no client access at all).

---

## Cloud Storage layout

| Path | Who can write | Who can read | Notes |
|---|---|---|---|
| `prescriptions/{uid}/{filename}` | that patient only | owner + pharmacist/admin | jpg/png/pdf, ≤10MB |
| `products/{imageId}` | pharmacist/admin | public | product photos |
| `avatars/{uid}/{filename}` | that user only | any authenticated user | ≤2MB |
| `reports/{filename}` | admin | admin | compliance exports |

Everything else is denied by a catch-all rule.

---

## The product catalog (`data/products.json`)

Generated (not hand-written) from the pharmacy's Glovo inventory export —
see `FIXES-APPLIED.md` Increment 2 for the full process. Key facts:

- **9,032 total rows**: 1,470 marked `active: true` (real price, real
  stock=200, shown in the shop), 7,562 `active: false, stock: 0`
  (discontinued/out-of-stock on the source feed — kept rather than
  discarded, so they can be reactivated later instead of re-importing).
- **219 active products had no category** in the source feed —
  auto-assigned via keyword matching against the product name (see
  `process_catalog.py`'s `KEYWORD_RULES`); genuinely unmatched ones land
  in `Miscellaneous General Supplies`.
- **`category`** is a broad bucket (~31 values) matching the fixed filter
  sidebar in `shop.html`; **`rawCategory`** is the original, more granular
  category from the source feed (shown in product detail views).
- Regenerating this file: `python3 process_catalog.py` (reads the source
  xlsx, not included in this repo — re-run only if you have a fresh
  export).

To reload Firestore from this file: `node scripts/seed.js` — batches in
groups of 400 (23 batches for the full catalog).
