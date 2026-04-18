const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

const ORDER_STATUSES = ['pending','confirmed','processing','dispensed','in_transit','delivered','cancelled'];

// POST /api/orders  — authenticated patient
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();
    const { items, deliveryAddress, paymentMethod = 'mpesa', notes = '' } = req.body;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in order.' });
    if (!deliveryAddress)        return res.status(400).json({ error: 'Delivery address required.' });

    // Verify products and calculate total
    let total = 0;
    const resolvedItems = [];
    for (const item of items) {
      const snap = await db.collection('products').doc(item.productId).get();
      if (!snap.exists) return res.status(404).json({ error: `Product ${item.productId} not found.` });
      const p = snap.data();
      if (!p.active)       return res.status(400).json({ error: `${p.name} is not available.` });
      if (p.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${p.name}.` });
      if (p.type === 'rx' && !item.prescriptionId) {
        return res.status(400).json({ error: `${p.name} requires a verified prescription.` });
      }
      const lineTotal = p.price * item.quantity;
      total += lineTotal;
      resolvedItems.push({ productId: item.productId, name: p.name, price: p.price, quantity: item.quantity, lineTotal, type: p.type, prescriptionId: item.prescriptionId || null });
    }

    // Generate readable order ID
    const count    = (await db.collection('orders').count().get()).data().count || 0;
    const orderId  = `KP-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const orderRef = db.collection('orders').doc();
    const orderData = {
      orderId,
      patientId:       req.user.uid,
      patientEmail:    req.user.email,
      items:           resolvedItems,
      total,
      deliveryAddress,
      paymentMethod,
      paymentStatus:   'pending',
      status:          'pending',
      statusHistory:   [{ status: 'pending', timestamp: new Date().toISOString(), by: req.user.uid }],
      riderId:         null,
      notes,
      estimatedETA:    null,
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    };

    await orderRef.set(orderData);

    // Decrement stock for each item
    const batch = db.batch();
    for (const item of resolvedItems) {
      batch.update(db.collection('products').doc(item.productId), {
        stock: admin.firestore.FieldValue.increment(-item.quantity),
      });
    }
    await batch.commit();

    await db.collection('audit_logs').add({
      action:    'ORDER_CREATED',
      orderId,
      firestoreId: orderRef.id,
      userId:    req.user.uid,
      total,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ id: orderRef.id, orderId, total, status: 'pending' });
  } catch (err) { next(err); }
});

// GET /api/orders  — patient gets own orders; admin/pharmacist gets all
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const db   = getDb();
    const role = req.user.kerich_role || req.user['kerich_role'];
    const { status, limit: lim = 50 } = req.query;

    let q = db.collection('orders').orderBy('createdAt', 'desc').limit(Number(lim));

    if (!['admin', 'pharmacist', 'rider'].includes(role)) {
      q = db.collection('orders').where('patientId', '==', req.user.uid).orderBy('createdAt', 'desc');
    }
    if (status) q = q.where('status', '==', status);

    const snap   = await q.get();
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ orders, total: orders.length });
  } catch (err) { next(err); }
});

// GET /api/orders/:id
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const snap = await getDb().collection('orders').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Order not found.' });
    const order = snap.data();

    const role = req.user.kerich_role;
    if (!['admin', 'pharmacist', 'rider'].includes(role) && order.patientId !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    res.json({ id: snap.id, ...order });
  } catch (err) { next(err); }
});

// PATCH /api/orders/:id/status  — pharmacist / admin / rider
router.patch('/:id/status', authenticateToken, requireRole('admin', 'pharmacist', 'rider'), async (req, res, next) => {
  try {
    const db   = getDb();
    const { status, note = '' } = req.body;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${ORDER_STATUSES.join(', ')}` });
    }

    const ref  = db.collection('orders').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Order not found.' });

    const historyEntry = { status, timestamp: new Date().toISOString(), by: req.user.uid, note };

    await ref.update({
      status,
      statusHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('audit_logs').add({
      action:    'ORDER_STATUS_UPDATED',
      orderId:   req.params.id,
      status,
      updatedBy: req.user.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: `Order status updated to '${status}'.` });
  } catch (err) { next(err); }
});

// POST /api/orders/:id/assign-rider
router.post('/:id/assign-rider', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db = getDb();
    const { riderId } = req.body;
    if (!riderId) return res.status(400).json({ error: 'riderId required.' });

    const eta = new Date(Date.now() + 45 * 60 * 1000).toISOString(); // 45 min ETA
    await db.collection('orders').doc(req.params.id).update({
      riderId,
      status:        'in_transit',
      estimatedETA:  eta,
      statusHistory: admin.firestore.FieldValue.arrayUnion({ status: 'in_transit', timestamp: new Date().toISOString(), by: req.user.uid }),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Rider assigned.', estimatedETA: eta });
  } catch (err) { next(err); }
});

module.exports = router;
