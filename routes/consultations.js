const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb, getAuth } = require('../config/firebase');
const { requireRole } = require('../middleware/auth');
const { notifyConsultationBooked, notifyConsultationStatusChanged } = require('../services/notifications');
// NOTE: this router is mounted with authenticateToken already applied in
// server.js (every route below assumes req.user is set).

const VALID_CHANNELS = ['video', 'voice', 'chat'];
const VALID_STATUSES = ['requested', 'confirmed', 'in_progress', 'completed', 'cancelled', 'declined'];

// Looks up the doctors/{doctorId} doc linked to this auth uid (via the
// `uid` field set when the doctor account was created). Returns null if
// this user isn't linked to a doctor record.
// A doctor's Firestore doc ID is their own auth uid (see POST /doctors
// below and scripts/seed.js) — this is what lets Firestore *security
// rules* verify "is this the assigned doctor" via a direct get() on
// consultations/{id}.doctorId, with no query support needed (rules can't
// run queries, only doc-ID lookups). Kept as a named helper for clarity
// at call sites even though it's now a simple existence check.
async function resolveDoctorId(db, uid) {
  const snap = await db.collection('doctors').doc(uid).get();
  return snap.exists ? uid : null;
}

// GET /api/consultations/doctors/me — the signed-in doctor's own profile.
router.get('/doctors/me', requireRole('doctor'), async (req, res, next) => {
  try {
    const db = getDb();
    const doctorId = await resolveDoctorId(db, req.user.uid);
    if (!doctorId) return res.status(404).json({ error: 'No doctor profile is linked to this account.' });
    const snap = await db.collection('doctors').doc(doctorId).get();
    res.json({ id: doctorId, ...snap.data() });
  } catch (err) { next(err); }
});

// PATCH /api/consultations/doctors/me/availability — the signed-in doctor
// toggles their own availability. (Admin already has a separate roster
// management path in admin.html.)
router.patch('/doctors/me/availability', requireRole('doctor'), async (req, res, next) => {
  try {
    const { available } = req.body || {};
    if (typeof available !== 'boolean') {
      return res.status(400).json({ error: 'available must be true or false.' });
    }
    const db = getDb();
    const doctorId = await resolveDoctorId(db, req.user.uid);
    if (!doctorId) return res.status(404).json({ error: 'No doctor profile is linked to this account.' });

    await db.collection('doctors').doc(doctorId).update({
      available, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ id: doctorId, available });
  } catch (err) { next(err); }
});

// GET /api/consultations/doctors — public. Returns only patient-safe
// fields — the doctors collection now also stores `uid`/`email` (used to
// link a doctor's login account to their record), which must never be
// exposed to an unauthenticated storefront request.
router.get('/doctors', async (req, res, next) => {
  try {
    const db = getDb();
    let lim = parseInt(req.query.limit, 10);
    if (!Number.isFinite(lim) || lim <= 0) lim = 12;
    lim = Math.min(lim, 100);

    const snap = await db.collection('doctors').limit(lim).get();
    const doctors = snap.docs.map(d => {
      const { name, speciality, licence, fee, available, rating, reviews } = d.data();
      return { id: d.id, name, speciality, licence, fee, available, rating, reviews };
    });
    res.json({ doctors });
  } catch (err) { next(err); }
});

// POST /api/consultations — patient books a consultation with a doctor.
router.post('/', async (req, res, next) => {
  try {
    const { doctorId, channel, reason, scheduledFor } = req.body || {};

    if (!doctorId || typeof doctorId !== 'string') {
      return res.status(400).json({ error: 'doctorId is required.' });
    }
    if (!VALID_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` });
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      return res.status(400).json({ error: 'reason must be a string under 500 characters.' });
    }
    let scheduledForDate = null;
    if (scheduledFor) {
      scheduledForDate = new Date(scheduledFor);
      if (isNaN(scheduledForDate.getTime())) {
        return res.status(400).json({ error: 'scheduledFor must be a valid date/time.' });
      }
      if (scheduledForDate.getTime() < Date.now() - 5 * 60 * 1000) {
        return res.status(400).json({ error: 'scheduledFor cannot be in the past.' });
      }
    }

    const db = getDb();
    const docSnap = await db.collection('doctors').doc(doctorId).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Doctor not found.' });
    const doctor = docSnap.data();

    // Booking "now" (no scheduledFor) requires the doctor to currently be available.
    if (!scheduledForDate && !doctor.available) {
      return res.status(409).json({ error: 'This doctor is not available right now. Pick a scheduled time instead.' });
    }

    const userSnap = await db.collection('users').doc(req.user.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};

    const consultation = {
      patientId:        req.user.uid,
      patientName:      userData.displayName || req.user.name || null,
      patientEmail:      req.user.email || userData.email || null,
      patientPhone:      userData.phoneNumber || null,
      doctorId,
      doctorName:        doctor.name || null,
      doctorSpeciality:  doctor.speciality || null,
      fee:               doctor.fee || 0,
      channel,
      reason:            reason ? reason.trim() : null,
      status:            'requested',
      scheduledFor:      scheduledForDate,
      notes:             null,
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('consultations').add(consultation);
    const saved = await ref.get();
    notifyConsultationBooked(saved.data());
    res.status(201).json({ id: ref.id, ...saved.data() });
  } catch (err) { next(err); }
});

// GET /api/consultations/mine — the current patient's own bookings.
router.get('/mine', async (req, res, next) => {
  try {
    const db = getDb();
    let lim = parseInt(req.query.limit, 10);
    if (!Number.isFinite(lim) || lim <= 0) lim = 20;
    lim = Math.min(lim, 100);

    const snap = await db.collection('consultations')
      .where('patientId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(lim)
      .get();

    res.json({ consultations: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { next(err); }
});

// GET /api/consultations/doctor/mine — the signed-in doctor's own queue.
router.get('/doctor/mine', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const db = getDb();
    const role = req.user.role || req.user.kerich_role;

    let doctorId = req.query.doctorId; // admins may pass a specific doctorId
    if (role !== 'admin' || !doctorId) {
      doctorId = await resolveDoctorId(db, req.user.uid);
    }
    if (!doctorId) {
      return res.status(404).json({ error: 'No doctor profile is linked to this account.' });
    }

    let lim = parseInt(req.query.limit, 10);
    if (!Number.isFinite(lim) || lim <= 0) lim = 50;
    lim = Math.min(lim, 200);

    let q = db.collection('consultations').where('doctorId', '==', doctorId);
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      q = q.where('status', '==', req.query.status);
    }
    q = q.orderBy('createdAt', 'desc').limit(lim);

    const snap = await q.get();
    res.json({ doctorId, consultations: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { next(err); }
});

// PATCH /api/consultations/:id/cancel — patient cancels their own pending/confirmed booking.
router.patch('/:id/cancel', async (req, res, next) => {
  try {
    const db  = getDb();
    const ref = db.collection('consultations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Consultation not found.' });

    const data = snap.data();
    const role = req.user.role || req.user.kerich_role;
    const isOwner = data.patientId === req.user.uid;
    const isStaff = ['admin', 'pharmacist'].includes(role);
    if (!isOwner && !isStaff) return res.status(403).json({ error: 'Access denied.' });

    if (['completed', 'cancelled', 'declined'].includes(data.status)) {
      return res.status(409).json({ error: `Cannot cancel a consultation that is already ${data.status}.` });
    }

    await ref.update({ status: 'cancelled', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    notifyConsultationStatusChanged(data, 'cancelled');
    res.json({ id: req.params.id, message: 'Consultation cancelled.' });
  } catch (err) { next(err); }
});

// GET /api/consultations — admin/pharmacist: list all consultations (optionally by status).
router.get('/', requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db = getDb();
    let lim = parseInt(req.query.limit, 10);
    if (!Number.isFinite(lim) || lim <= 0) lim = 50;
    lim = Math.min(lim, 500);

    let q = db.collection('consultations');
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      q = q.where('status', '==', req.query.status);
    }
    q = q.orderBy('createdAt', 'desc').limit(lim);

    const snap = await q.get();
    res.json({ consultations: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { next(err); }
});

// PATCH /api/consultations/:id — admin/pharmacist (any consultation), or
// the assigned doctor (their own consultations only): update status /
// add consultation notes.
router.patch('/:id', async (req, res, next) => {
  try {
    const role = req.user.role || req.user.kerich_role;
    const isStaff = ['admin', 'pharmacist'].includes(role);

    const { status, notes } = req.body || {};
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      update.status = status;
    }
    if (notes !== undefined) {
      if (typeof notes !== 'string' || notes.length > 2000) {
        return res.status(400).json({ error: 'notes must be a string under 2000 characters.' });
      }
      update.notes = notes.trim();
    }
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: 'Provide at least one of: status, notes.' });
    }

    const db  = getDb();
    const ref = db.collection('consultations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Consultation not found.' });

    if (!isStaff) {
      // Must be the assigned doctor on this specific consultation.
      const myDoctorId = await resolveDoctorId(db, req.user.uid);
      if (!myDoctorId || myDoctorId !== snap.data().doctorId) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    await ref.update(update);
    const updated = await ref.get();
    if (status) notifyConsultationStatusChanged(updated.data(), status);
    res.json({ id: req.params.id, ...updated.data() });
  } catch (err) { next(err); }
});

// POST /api/consultations/doctors — admin only. Creates a doctor record
// AND a real Firebase Auth account for them (kerich_role: 'doctor'),
// linked via uid — mirrors what scripts/seed.js does for the initial
// roster, so doctors added later through the admin panel can log in too.
const DEFAULT_DOCTOR_PASSWORD = 'KerichDoctor2025!';

router.post('/doctors', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, speciality, licence, fee } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required (used for the doctor\'s login).' });
    }
    const feeVal = Number(fee);

    const authInst = getAuth();
    const db = getDb();

    let uid;
    try {
      const existing = await authInst.getUserByEmail(email);
      uid = existing.uid;
    } catch {
      const created = await authInst.createUser({
        email, password: DEFAULT_DOCTOR_PASSWORD, displayName: name.trim(), emailVerified: true,
      });
      uid = created.uid;
    }
    await authInst.setCustomUserClaims(uid, { kerich_role: 'doctor' });

    const doctorData = {
      name: name.trim(),
      speciality: speciality ? String(speciality).trim() : 'General Practitioner',
      licence: licence ? String(licence).trim() : '',
      fee: Number.isFinite(feeVal) && feeVal >= 0 ? feeVal : 1000,
      available: true, rating: 5.0, reviews: 0,
      email, uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = db.collection('doctors').doc(uid);
    await ref.set(doctorData);

    await db.collection('users').doc(uid).set({
      uid, email, displayName: name.trim(), role: 'doctor', status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.status(201).json({
      id: ref.id, ...doctorData,
      defaultPassword: DEFAULT_DOCTOR_PASSWORD,
      note: 'Share this password with the doctor — they should change it after first login.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
