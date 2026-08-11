const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const axios   = require('axios');
const { getDb } = require('../config/firebase');
const { authenticateToken } = require('../middleware/auth');

// ── M-Pesa helpers ──────────────────────────────────────────
async function getMpesaToken() {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const env    = process.env.MPESA_ENVIRONMENT === 'production' ? 'api' : 'sandbox';
  const url    = `https://${env}.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`;

  const { data } = await axios.get(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
  });
  return data.access_token;
}

function getMpesaPassword() {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey   = process.env.MPESA_PASSKEY;
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const password  = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
}

// POST /api/payments/mpesa/initiate
router.post('/mpesa/initiate', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();
    const { orderId, phoneNumber, amount } = req.body;
    if (!orderId || !phoneNumber || !amount) {
      return res.status(400).json({ error: 'orderId, phoneNumber, and amount are required.' });
    }

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    if (orderSnap.data().patientId !== req.user.uid) return res.status(403).json({ error: 'Access denied.' });

    const token              = await getMpesaToken();
    const { password, timestamp } = getMpesaPassword();
    const env                = process.env.MPESA_ENVIRONMENT === 'production' ? 'api' : 'sandbox';

    const { data } = await axios.post(
      `https://${env}.safaricom.co.ke/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerPayBillOnline',
        Amount:            Math.ceil(amount),
        PartyA:            phoneNumber.replace('+', '').replace(/^0/, '254'),
        PartyB:            process.env.MPESA_SHORTCODE,
        PhoneNumber:       phoneNumber.replace('+', '').replace(/^0/, '254'),
        CallBackURL:       `${process.env.BASE_URL}/api/payments/mpesa/callback`,
        AccountReference:  `KERICH-${orderId}`,
        TransactionDesc:   'Kerich Pharmaceuticals Order',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Save payment record
    await db.collection('payments').add({
      orderId,
      patientId:       req.user.uid,
      method:          'mpesa',
      amount,
      phoneNumber,
      mpesaRequestId:  data.CheckoutRequestID,
      status:          'pending',
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      message:          'M-Pesa STK push sent. Check your phone.',
      checkoutRequestId: data.CheckoutRequestID,
    });
  } catch (err) {
    if (err.response?.data) {
      return res.status(502).json({ error: 'M-Pesa error', details: err.response.data });
    }
    next(err);
  }
});

// POST /api/payments/mpesa/callback  — Safaricom calls this
router.post('/mpesa/callback', async (req, res) => {
  try {
    const db      = getDb();
    const body    = req.body?.Body?.stkCallback;
    const reqId   = body?.CheckoutRequestID;
    const code    = body?.ResultCode;
    const success = code === 0;

    // Find the payment record
    const snap = await db.collection('payments').where('mpesaRequestId', '==', reqId).limit(1).get();
    if (!snap.empty) {
      const payDoc = snap.docs[0];
      const orderId = payDoc.data().orderId;

      await payDoc.ref.update({
        status:           success ? 'completed' : 'failed',
        mpesaResultCode:  code,
        mpesaReceiptNumber: success ? body.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value : null,
        updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
      });

      if (success) {
        await db.collection('orders').doc(orderId).update({
          paymentStatus: 'paid',
          status:        'confirmed',
          updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Safaricom expects 200
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch {
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// POST /api/payments/stripe/process
router.post('/stripe/process', authenticateToken, async (req, res, next) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'Stripe not configured.' });
    }
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const db     = getDb();

    const { orderId, paymentMethodId, amount } = req.body;

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });

    const intent = await stripe.paymentIntents.create({
      amount:          Math.ceil(amount * 100), // Stripe uses cents
      currency:        'kes',
      payment_method:  paymentMethodId,
      confirm:         true,
      return_url:      `${process.env.BASE_URL}/order-complete`,
      metadata: { orderId, patientId: req.user.uid },
    });

    await db.collection('payments').add({
      orderId,
      patientId:          req.user.uid,
      method:             'stripe',
      amount,
      stripePaymentIntentId: intent.id,
      status:             intent.status === 'succeeded' ? 'completed' : 'pending',
      createdAt:          admin.firestore.FieldValue.serverTimestamp(),
    });

    if (intent.status === 'succeeded') {
      await db.collection('orders').doc(orderId).update({ paymentStatus: 'paid', status: 'confirmed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.json({ status: intent.status, clientSecret: intent.client_secret });
  } catch (err) { next(err); }
});

// GET /api/payments/:orderId  — get payment status
router.get('/:orderId', authenticateToken, async (req, res, next) => {
  try {
    const snap = await getDb().collection('payments').where('orderId', '==', req.params.orderId).orderBy('createdAt', 'desc').limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'No payment found for this order.' });
    res.json({ id: snap.docs[0].id, ...snap.docs[0].data() });
  } catch (err) { next(err); }
});

module.exports = router;
