const express  = require('express');
const router   = express.Router();
const { getAuth, getDb } = require('../config/firebase');
const { authenticateToken } = require('../middleware/auth');
const admin = require('firebase-admin');

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, displayName, phoneNumber, role = 'patient' } = req.body;
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'email, password and displayName are required.' });
    }

    // Only allow patient self-registration; admin/pharmacist roles must be set by an admin
    const allowedSelfRoles = ['patient'];
    const assignedRole = allowedSelfRoles.includes(role) ? role : 'patient';

    // Create Firebase Auth user
    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName,
      phoneNumber: phoneNumber || undefined,
      emailVerified: false,
    });

    // Set custom claim for RBAC
    await getAuth().setCustomUserClaims(userRecord.uid, { kerich_role: assignedRole });

    // Create Firestore patient profile
    const db = getDb();
    await db.collection('users').doc(userRecord.uid).set({
      uid:         userRecord.uid,
      email,
      displayName,
      phoneNumber: phoneNumber || null,
      role:        assignedRole,
      status:      'active',
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      // Patient health profile defaults
      healthProfile: {
        bloodGroup:  null,
        allergies:   [],
        conditions:  [],
        emergencyContact: null,
      },
      // Compliance: Kenya DPA 2019
      dataConsent: {
        given:     true,
        timestamp: new Date().toISOString(),
        version:   '1.0',
      },
    });

    // Audit log
    await db.collection('audit_logs').add({
      action:    'USER_REGISTERED',
      userId:    userRecord.uid,
      email,
      role:      assignedRole,
      ip:        req.ip,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      message: 'Account created successfully.',
      uid:     userRecord.uid,
      email,
      displayName,
      role: assignedRole,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    next(err);
  }
});

// POST /api/auth/set-role  (admin only — call after login with admin token)
router.post('/set-role', authenticateToken, async (req, res, next) => {
  try {
    const callerRole = req.user?.kerich_role;
    if (callerRole !== 'admin') {
      return res.status(403).json({ error: 'Only admins can assign roles.' });
    }
    const { uid, role } = req.body;
    const validRoles = ['patient', 'pharmacist', 'doctor', 'rider', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    await getAuth().setCustomUserClaims(uid, { kerich_role: role });
    await getDb().collection('users').doc(uid).update({ role, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    await getDb().collection('audit_logs').add({
      action:    'ROLE_ASSIGNED',
      targetUid: uid,
      role,
      assignedBy: req.user.uid,
      timestamp:  admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: `Role '${role}' assigned to ${uid}` });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const snap = await getDb().collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User profile not found.' });
    res.json(snap.data());
  } catch (err) { next(err); }
});

// POST /api/auth/logout  (client should also call Firebase signOut)
router.post('/logout', authenticateToken, async (req, res, next) => {
  try {
    // Revoke all refresh tokens — forces re-login on all devices
    await getAuth().revokeRefreshTokens(req.user.uid);

    await getDb().collection('audit_logs').add({
      action:    'USER_LOGOUT',
      userId:    req.user.uid,
      ip:        req.ip,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Logged out successfully.' });
  } catch (err) { next(err); }
});

module.exports = router;
