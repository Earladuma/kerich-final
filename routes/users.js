const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/users  — admin only: list all users
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { role, limit: lim = 50 } = req.query;
    let q = getDb().collection('users').limit(Number(lim));
    if (role) q = q.where('role', '==', role);
    const snap  = await q.get();
    const users = snap.docs.map(d => {
      const u = d.data();
      delete u.dataConsent; // don't expose consent details in list
      return { id: d.id, ...u };
    });
    res.json({ users, total: users.length });
  } catch (err) { next(err); }
});

// GET /api/users/:uid  — own profile or admin
router.get('/:uid', async (req, res, next) => {
  try {
    const role = req.user.kerich_role;
    if (req.params.uid !== req.user.uid && role !== 'admin' && role !== 'pharmacist') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const snap = await getDb().collection('users').doc(req.params.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found.' });

    const data = snap.data();
    // Log access to patient record — Kenya DPA / PPB requirement
    await getDb().collection('audit_logs').add({
      action:      'PATIENT_RECORD_ACCESSED',
      targetUid:   req.params.uid,
      accessedBy:  req.user.uid,
      accessorRole: role,
      timestamp:   admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ id: snap.id, ...data });
  } catch (err) { next(err); }
});

// PATCH /api/users/:uid  — own profile only
router.patch('/:uid', async (req, res, next) => {
  try {
    if (req.params.uid !== req.user.uid) return res.status(403).json({ error: 'Can only update your own profile.' });

    const allowed = ['displayName', 'phoneNumber', 'healthProfile'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await getDb().collection('users').doc(req.params.uid).update(update);
    res.json({ message: 'Profile updated.' });
  } catch (err) { next(err); }
});

// GET /api/users/:uid/health-record  — patient own or doctor/pharmacist/admin
router.get('/:uid/health-record', async (req, res, next) => {
  try {
    const role = req.user.kerich_role;
    if (req.params.uid !== req.user.uid && !['admin', 'pharmacist', 'doctor'].includes(role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const db   = getDb();
    const uid  = req.params.uid;

    const [userSnap, rxSnap, orderSnap, consultSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('prescriptions').where('patientId', '==', uid).orderBy('createdAt', 'desc').limit(20).get(),
      db.collection('orders').where('patientId', '==', uid).orderBy('createdAt', 'desc').limit(20).get(),
      db.collection('consultations').where('patientId', '==', uid).orderBy('createdAt', 'desc').limit(10).get(),
    ]);

    if (!userSnap.exists) return res.status(404).json({ error: 'Patient not found.' });

    const record = {
      profile:       userSnap.data(),
      prescriptions: rxSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      orders:        orderSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      consultations: consultSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    };

    // Audit log
    await db.collection('audit_logs').add({
      action:      'HEALTH_RECORD_ACCESSED',
      targetUid:   uid,
      accessedBy:  req.user.uid,
      accessorRole: role,
      timestamp:   admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json(record);
  } catch (err) { next(err); }
});

// DELETE /api/users/:uid  — Kenya DPA 2019: right to erasure
router.delete('/:uid', async (req, res, next) => {
  try {
    const role = req.user.kerich_role;
    if (req.params.uid !== req.user.uid && role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const db  = getDb();
    const uid = req.params.uid;

    // Anonymise rather than hard-delete (required for financial/audit records)
    await db.collection('users').doc(uid).update({
      email:        'deleted@kerichpharma.co.ke',
      displayName:  'Deleted User',
      phoneNumber:  null,
      healthProfile: {},
      status:       'deleted',
      deletedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    // Revoke Firebase Auth account
    await require('../config/firebase').getAuth().deleteUser(uid);

    await db.collection('audit_logs').add({
      action:      'USER_DATA_DELETED',
      targetUid:   uid,
      requestedBy: req.user.uid,
      compliance:  'Kenya DPA 2019 — Right to Erasure',
      timestamp:   admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Account and data deleted per Kenya Data Protection Act 2019.' });
  } catch (err) { next(err); }
});

module.exports = router;
