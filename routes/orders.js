const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { notifyOrderConfirmed, notifyOrderStatusChanged } = require('../services/notifications');

const ORDER_STATUSES = ['pending','confirmed','processing','dispensed','in_transit','delivered','cancelled'];

// POST /api/orders  — authenticated patient
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();
    const { items, deliveryAddress, paymentMethod = 'mpesa', notes = '' } = req.body;

    if (!items || !items.length) return res.status(400).json({ error: 'No items in order.' });
    if (!deliveryAddress)        return res.status(400).json({ error: 'Delivery address required.' });

    // Verify products and calculate total.
    // NOTE: the frontend (shop.html) sends the product's SKU as
    // "productId" in cart items — it is NOT a Firestore document ID.
    // Look products up by their `sku` field, not `.doc()`, and keep a
    // reference to the actual document for the stock decrement below.
    let total = 0;
    const resolvedItems = [];
    for (const item of items) {
      const querySnap = await db.collection('products').where('sku', '==', item.productId).limit(1).get();
      if (querySnap.empty) return res.status(404).json({ error: `Product ${item.productId} not found.` });
      const p = querySnap.docs[0].data();
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

    // Riders need a way to actually contact the patient — pull it from
    // their profile rather than leaving it uncaptured (it wasn't stored
    // on orders at all before this).
    const userSnap = await db.collection('users').doc(req.user.uid).get();
    const patientPhone = userSnap.exists ? (userSnap.data().phoneNumber || null) : null;

    const orderRef = db.collection('orders').doc();
    const orderData = {
      orderId,
      patientId:       req.user.uid,
      patientEmail:    req.user.email,
      patientPhone,
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
    // NOTE: stock is intentionally NOT decremented here. It's decremented
    // once, at delivery completion (see admin.html's mark-delivered flow
    // and POST /api/delivery/:orderId/complete) — decrementing at both
    // creation and delivery would double-count every order, and there's
    // no stock-restoration logic for cancelled/expired pending orders.
    // The availability check above (stock < quantity) still protects
    // against overselling at order time.

    await db.collection('audit_logs').add({
      action:    'ORDER_CREATED',
      orderId,
      firestoreId: orderRef.id,
      userId:    req.user.uid,
      total,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Fire-and-forget — never let a slow/failed email or SMS delay or
    // break order creation itself.
    notifyOrderConfirmed({ ...orderData, orderId });

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

    notifyOrderStatusChanged({ ...snap.data(), orderId: snap.data().orderId || req.params.id }, status);

    res.json({ message: `Order status updated to '${status}'.` });
  } catch (err) { next(err); }
});

// POST /api/orders/:id/notify-status — fires the customer notification
// for a status change without touching Firestore. Exists because
// admin.html's order-status flow writes directly to Firestore client-side
// (it has its own established stock-decrement/sales-recording logic for
// 'delivered' — see FIXES-APPLIED.md — which this deliberately does not
// duplicate or risk touching). Call this right after that write succeeds.
router.post('/:id/notify-status', authenticateToken, requireRole('admin', 'pharmacist', 'rider'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
    }
    const snap = await getDb().collection('orders').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Order not found.' });

    notifyOrderStatusChanged({ ...snap.data(), orderId: snap.data().orderId || req.params.id }, status);
    res.json({ message: 'Notification queued.' });
  } catch (err) { next(err); }
});

// NOTE: rider assignment lives at POST /api/delivery/assign (routes/delivery.js),
// which also creates the deliveries/{orderId} tracking doc. A duplicate
// assign-rider endpoint used to live here — removed because it set
// status directly without creating that doc, which is exactly the bug
// already fixed in admin.html's UI (see FIXES-APPLIED.md Increment 6).

module.exports = router;
