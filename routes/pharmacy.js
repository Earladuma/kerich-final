const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { getDb } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/pharmacy/products  — public
router.get('/products', async (req, res, next) => {
  try {
    const db = getDb();
    const { category, type, search } = req.query;

    // Validate limit: numeric, capped, defaults to 50. Prevents unbounded
    // reads and rejects non-numeric query-string tampering.
    let lim = parseInt(req.query.limit, 10);
    if (!Number.isFinite(lim) || lim <= 0) lim = 50;
    lim = Math.min(lim, 5000);

    let q = db.collection('products').where('active', '==', true);
    if (category && category !== 'all') q = q.where('category', '==', String(category).slice(0, 100));
    if (type === 'otc' || type === 'rx') q = q.where('type', '==', type);
    q = q.limit(lim);

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

// Shared validation for product writes — rejects bad data rather than
// silently persisting it (negative price, non-numeric stock, oversized
// strings, unexpected field types).
function validateProductBody(body, { partial = false } = {}) {
  const errors = [];
  const clean  = {};

  const need = (key) => !partial || body[key] !== undefined;

  if (need('name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 300) {
      errors.push('name must be a non-empty string under 300 characters.');
    } else clean.name = body.name.trim();
  }
  if (need('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push('price must be a non-negative number.');
    else clean.price = price;
  }
  if (need('stock')) {
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0) errors.push('stock must be a non-negative integer.');
    else clean.stock = stock;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || body.category.length > 100) errors.push('category must be a string under 100 characters.');
    else clean.category = body.category;
  }
  if (body.type !== undefined) {
    if (body.type !== 'otc' && body.type !== 'rx') errors.push("type must be 'otc' or 'rx'.");
    else clean.type = body.type;
  }
  if (body.sku !== undefined) {
    if (typeof body.sku !== 'string' || !body.sku.trim() || body.sku.length > 60) errors.push('sku must be a non-empty string under 60 characters.');
    else clean.sku = body.sku.trim();
  }
  if (body.description !== undefined) {
    clean.description = body.description === null ? null : String(body.description).slice(0, 2000);
  }
  if (body.image !== undefined) {
    clean.image = body.image === null ? null : String(body.image).slice(0, 1000);
  }
  if (body.active !== undefined) clean.active = Boolean(body.active);

  return { errors, clean };
}

// POST /api/pharmacy/products  — admin / pharmacist only
router.post('/products', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const { errors, clean } = validateProductBody(req.body || {});
    if (!clean.name || clean.price === undefined) errors.push('name and price are required.');
    if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

    const db  = getDb();
    const data = {
      ...clean,
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
    const { errors, clean } = validateProductBody(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

    const db  = getDb();
    const ref = db.collection('products').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Product not found.' });

    await ref.update({ ...clean, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ id: req.params.id, ...(await ref.get()).data() });
  } catch (err) { next(err); }
});

// GET /api/pharmacy/config — public. Lets the frontend read pharmacy
// name/address/phone/hours from Firestore instead of hardcoding them
// in HTML, so a config change doesn't require a redeploy.
router.get('/config', async (req, res, next) => {
  try {
    const snap = await getDb().collection('config').doc('pharmacy').get();
    if (!snap.exists) return res.status(404).json({ error: 'Pharmacy config not set.' });
    const {
      name, address, phone, email, website,
      openingHours, deliveryRadius, deliveryFee, freeDeliveryAbove,
      latitude, longitude,
    } = snap.data();
    res.json({
      name, address, phone, email, website,
      openingHours, deliveryRadius, deliveryFee, freeDeliveryAbove,
      latitude, longitude,
    });
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

// PATCH /api/pharmacy/config — admin only. Validates and merges into the
// existing config doc rather than overwriting fields the caller didn't send.
router.patch('/config', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['name', 'ppbLicence', 'address', 'phone', 'email', 'website',
                      'openingHours', 'deliveryRadius', 'deliveryFee', 'freeDeliveryAbove',
                      'latitude', 'longitude'];
    const update = {};
    const errors = [];
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      const val = req.body[key];
      if (['deliveryRadius', 'deliveryFee', 'freeDeliveryAbove', 'latitude', 'longitude'].includes(key)) {
        const n = Number(val);
        if (!Number.isFinite(n)) { errors.push(`${key} must be a number.`); continue; }
        update[key] = n;
      } else {
        if (typeof val !== 'string' || val.length > 300) { errors.push(`${key} must be a string under 300 characters.`); continue; }
        update[key] = val.trim();
      }
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    update.updatedBy = req.user.uid;
    await getDb().collection('config').doc('pharmacy').set(update, { merge: true });
    res.json({ message: 'Config updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
