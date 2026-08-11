const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb, getAuth } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { notifyOrderStatusChanged } = require('../services/notifications');

const DEFAULT_RIDER_PASSWORD = 'KerichRider2025!';

// POST /api/delivery/riders — admin only. Creates a real Firebase Auth
// account (kerich_role: 'rider') plus the users/{uid} doc — riders have
// no separate collection of their own (unlike doctors), they're just a
// role on a user account, so this is simpler than doctor onboarding.
router.post('/riders', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, phoneNumber } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required (used for the rider\'s login).' });
    }

    const authInst = getAuth();
    const db = getDb();

    let uid;
    try {
      const existing = await authInst.getUserByEmail(email);
      uid = existing.uid;
    } catch {
      const created = await authInst.createUser({
        email, password: DEFAULT_RIDER_PASSWORD, displayName: name.trim(), emailVerified: true,
      });
      uid = created.uid;
    }
    await authInst.setCustomUserClaims(uid, { kerich_role: 'rider' });

    await db.collection('users').doc(uid).set({
      uid, email, displayName: name.trim(),
      phoneNumber: phoneNumber ? String(phoneNumber).trim() : null,
      role: 'rider', status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.status(201).json({
      uid, name: name.trim(), email,
      defaultPassword: DEFAULT_RIDER_PASSWORD,
      note: 'Share this password with the rider — they should change it after first login.',
    });
  } catch (err) { next(err); }
});

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
// (their own assigned delivery only)
router.patch('/:orderId/location', authenticateToken, requireRole('rider'), async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required.' });

    const db = getDb();
    const orderSnap = await db.collection('orders').doc(req.params.orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    if (orderSnap.data().riderId !== req.user.uid) {
      return res.status(403).json({ error: 'This delivery is not assigned to you.' });
    }

    await db.collection('deliveries').doc(req.params.orderId).update({
      location:        { lat, lng },
      locationUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Location updated.' });
  } catch (err) { next(err); }
});

// POST /api/delivery/:orderId/complete  — rider marks as delivered.
// Mirrors what admin.html's client-side "mark delivered" flow does
// (decrement stock, record a sale, mark paid) so revenue/inventory stay
// correct regardless of whether a rider or an admin completes the order.
router.post('/:orderId/complete', authenticateToken, requireRole('rider', 'admin'), async (req, res, next) => {
  try {
    const db = getDb();
    const orderRef  = db.collection('orders').doc(req.params.orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const order = orderSnap.data();

    if (order.status === 'delivered') {
      return res.status(409).json({ error: 'This order is already marked delivered.' });
    }

    // A rider may only complete their own assigned delivery.
    if (req.user.kerich_role === 'rider' && order.riderId !== req.user.uid) {
      return res.status(403).json({ error: 'This delivery is not assigned to you.' });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    batch.update(orderRef, {
      status:        'delivered',
      paymentStatus: 'paid',
      deliveredAt:   now,
      updatedAt:     now,
      statusHistory: admin.firestore.FieldValue.arrayUnion({
        status: 'delivered', by: req.user.uid, timestamp: new Date().toISOString(),
      }),
    });

    batch.set(db.collection('deliveries').doc(req.params.orderId), {
      status: 'completed', completedAt: now,
    }, { merge: true });

    // Decrement stock for each item (matched by SKU, same as admin.html).
    for (const item of (order.items || [])) {
      if (!item.productId) continue;
      const prodSnap = await db.collection('products').where('sku', '==', item.productId).limit(1).get();
      if (!prodSnap.empty) {
        batch.update(prodSnap.docs[0].ref, {
          stock:     admin.firestore.FieldValue.increment(-Math.abs(item.quantity || 1)),
          updatedAt: now,
        });
      }
    }

    // Revenue record.
    batch.set(db.collection('sales').doc(), {
      orderId:          order.orderId || req.params.orderId,
      firestoreOrderId: req.params.orderId,
      patientId:        order.patientId,
      patientEmail:     order.patientEmail || '',
      items:            order.items || [],
      subtotal:         order.subtotal || order.total || 0,
      deliveryFee:      order.deliveryFee || 0,
      total:            order.total || 0,
      paymentMethod:    order.paymentMethod || '',
      markedBy:         req.user.uid,
      deliveredAt:      now,
      createdAt:        now,
    });

    await batch.commit();
    notifyOrderStatusChanged({ ...order, orderId: order.orderId || req.params.orderId }, 'delivered');
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

    const delivery = deliverySnap.exists ? deliverySnap.data() : null;
    let rider = null;
    if (delivery?.riderId) {
      const riderSnap = await db.collection('users').doc(delivery.riderId).get();
      if (riderSnap.exists) {
        const r = riderSnap.data();
        rider = { name: r.displayName || null, phoneNumber: r.phoneNumber || null };
      }
    }

    res.json({
      orderId:         req.params.orderId,
      status:          order.status,
      estimatedETA:    order.estimatedETA,
      deliveryAddress: order.deliveryAddress || null,
      delivery,
      rider,
    });
  } catch (err) { next(err); }
});

module.exports = router;
