const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/pharmacy/products  — public
router.get('/products', async (req, res, next) => {
  try {
    const db = getDb();
    const { category, type, search, limit: lim = 50 } = req.query;

    let q = db.collection('products').where('active', '==', true);
    if (category && category !== 'all') q = q.where('category', '==', category);
    if (type)     q = q.where('type', '==', type);   // 'otc' | 'rx'
    q = q.limit(Number(lim));

    const snap = await q.get();
    let products = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Client-side search filter (Firestore doesn't do full-text)
    if (search) {
      const s = search.toLowerCase();
      products = products.filter(p =>
        p.name?.toLowerCase().includes(s) ||
        p.brand?.toLowerCase().includes(s) ||
        p.category?.toLowerCase().includes(s)
      );
    }

    res.json({ products, total: products.length });
  } catch (err) { next(err); }
});

// GET /api/pharmacy/products/:id
router.get('/products/:id', async (req, res, next) => {
  try {
    const snap = await getDb().collection('products').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Product not found.' });
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) { next(err); }
});

// POST /api/pharmacy/products  — admin / pharmacist only
router.post('/products', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db  = getDb();
    const data = {
      ...req.body,
      active:    true,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('products').add(data);
    res.status(201).json({ id: ref.id, ...data });
  } catch (err) { next(err); }
});

// PATCH /api/pharmacy/products/:id  — admin / pharmacist only
router.patch('/products/:id', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db  = getDb();
    const ref = db.collection('products').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Product not found.' });

    await ref.update({ ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ id: req.params.id, ...(await ref.get()).data() });
  } catch (err) { next(err); }
});

// GET /api/pharmacy/inventory  — admin / pharmacist only
router.get('/inventory', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const snap = await getDb().collection('products').orderBy('name').get();
    const items = snap.docs.map(d => {
      const p = d.data();
      return {
        id:         d.id,
        name:       p.name,
        category:   p.category,
        stock:      p.stock || 0,
        unitCost:   p.unitCost || 0,
        sellPrice:  p.price || 0,
        expiry:     p.expiry || null,
        stockLevel: p.stock > 200 ? 'good' : p.stock > 0 ? 'low' : 'out',
      };
    });

    const stats = {
      totalSKUs:  items.length,
      lowStock:   items.filter(i => i.stockLevel === 'low').length,
      outOfStock: items.filter(i => i.stockLevel === 'out').length,
    };

    res.json({ items, stats });
  } catch (err) { next(err); }
});

// PATCH /api/pharmacy/inventory/:id/stock  — pharmacist / admin
router.patch('/inventory/:id/stock', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const { quantity, operation = 'set' } = req.body; // operation: 'set' | 'increment'
    const ref = getDb().collection('products').doc(req.params.id);
    const update = operation === 'increment'
      ? { stock: admin.firestore.FieldValue.increment(quantity), updatedAt: admin.firestore.FieldValue.serverTimestamp() }
      : { stock: quantity, updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    await ref.update(update);

    await getDb().collection('audit_logs').add({
      action:    'STOCK_UPDATED',
      productId: req.params.id,
      quantity,
      operation,
      updatedBy: req.user.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Stock updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
