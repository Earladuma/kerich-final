const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/delivery  — all active deliveries (admin/pharmacist/rider)
router.get('/', authenticateToken, requireRole('admin', 'pharmacist', 'rider'), async (req, res, next) => {
  try {
    const db   = getDb();
    const role = req.user.kerich_role;

    let q = db.collection('orders').where('status', 'in', ['dispensed', 'in_transit']).orderBy('createdAt', 'desc');
    if (role === 'rider') q = db.collection('orders').where('riderId', '==', req.user.uid).where('status', '==', 'in_transit');

    const snap      = await q.get();
    const deliveries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ deliveries });
  } catch (err) { next(err); }
});

// GET /api/delivery/riders  — list available riders (admin only)
router.get('/riders', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const snap   = await getDb().collection('users').where('role', '==', 'rider').get();
    const riders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ riders });
  } catch (err) { next(err); }
});

// POST /api/delivery/assign
router.post('/assign', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db = getDb();
    const { orderId, riderId } = req.body;
    if (!orderId || !riderId) return res.status(400).json({ error: 'orderId and riderId required.' });

    const eta = new Date(Date.now() + 45 * 60 * 1000).toISOString();

    await db.collection('orders').doc(orderId).update({
      riderId,
      status:        'in_transit',
      estimatedETA:  eta,
      statusHistory: admin.firestore.FieldValue.arrayUnion({ status: 'in_transit', by: req.user.uid, timestamp: new Date().toISOString() }),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create a delivery tracking document
    await db.collection('deliveries').doc(orderId).set({
      orderId,
      riderId,
      status:       'in_transit',
      estimatedETA: eta,
      location:     null,
      startedAt:    admin.firestore.FieldValue.serverTimestamp(),
      completedAt:  null,
    });

    res.json({ message: 'Rider assigned.', estimatedETA: eta });
  } catch (err) { next(err); }
});

// PATCH /api/delivery/:orderId/location  — rider updates GPS location
router.patch('/:orderId/location', authenticateToken, requireRole('rider'), async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required.' });

    await getDb().collection('deliveries').doc(req.params.orderId).update({
      location:        { lat, lng },
      locationUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Location updated.' });
  } catch (err) { next(err); }
});

// POST /api/delivery/:orderId/complete  — rider marks as delivered
router.post('/:orderId/complete', authenticateToken, requireRole('rider', 'admin'), async (req, res, next) => {
  try {
    const db = getDb();

    await db.collection('orders').doc(req.params.orderId).update({
      status:        'delivered',
      statusHistory: admin.firestore.FieldValue.arrayUnion({ status: 'delivered', by: req.user.uid, timestamp: new Date().toISOString() }),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('deliveries').doc(req.params.orderId).update({
      status:      'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Delivery marked as completed.' });
  } catch (err) { next(err); }
});

// GET /api/delivery/:orderId/track  — patient tracks their delivery
router.get('/:orderId/track', authenticateToken, async (req, res, next) => {
  try {
    const db   = getDb();
    const [orderSnap, deliverySnap] = await Promise.all([
      db.collection('orders').doc(req.params.orderId).get(),
      db.collection('deliveries').doc(req.params.orderId).get(),
    ]);

    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const order = orderSnap.data();

    // Patients can only track their own orders
    const role = req.user.kerich_role;
    if (!['admin', 'pharmacist', 'rider'].includes(role) && order.patientId !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.json({
      orderId:      req.params.orderId,
      status:       order.status,
      estimatedETA: order.estimatedETA,
      delivery:     deliverySnap.exists ? deliverySnap.data() : null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
