// services/notifications.js
//
// Real gap this closes: orders, prescriptions, and consultations were all
// happening with absolutely nothing reaching the customer's inbox or
// phone — no confirmation email, no SMS delivery update, nothing. This
// module is the first piece; routes/*.js call the high-level functions
// at the bottom, not sendEmail/sendSMS directly.
//
// Both channels degrade gracefully when unconfigured: they log a warning
// and return without throwing, so a missing SMTP/Africa's Talking
// credential never breaks the underlying business operation (an order
// must still get created even if the confirmation email can't send).

const nodemailer = require('nodemailer');
const axios = require('axios');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) return;
  const t = getTransporter();
  if (!t) {
    console.warn(`⚠️  Email not sent (SMTP not configured): "${subject}" -> ${to}`);
    return;
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || 'Kerich Pharmaceuticals <no-reply@kerichpharma.co.ke>',
      to, subject, html, text: text || html?.replace(/<[^>]+>/g, ' '),
    });
  } catch (err) {
    console.error(`❌ Email send failed ("${subject}" -> ${to}):`, err.message);
  }
}

async function sendSMS({ to, message }) {
  if (!to) return;
  const { AT_USERNAME, AT_API_KEY, AT_SENDER_ID } = process.env;
  if (!AT_USERNAME || !AT_API_KEY) {
    console.warn(`⚠️  SMS not sent (Africa's Talking not configured): "${message.slice(0,40)}…" -> ${to}`);
    return;
  }
  try {
    const isSandbox = AT_USERNAME === 'sandbox';
    const base = isSandbox
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';
    await axios.post(base,
      new URLSearchParams({
        username: AT_USERNAME,
        to,
        message,
        ...(AT_SENDER_ID ? { from: AT_SENDER_ID } : {}),
      }),
      { headers: { apiKey: AT_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );
  } catch (err) {
    console.error(`❌ SMS send failed (-> ${to}):`, err.response?.data || err.message);
  }
}

// ── Templated, event-level notifications — these are what routes/*.js
// actually call. Each wraps its own try/catch so a notification failure
// is logged but never propagates and breaks the calling request. ───────

async function notifyOrderConfirmed(order) {
  try {
    const itemsList = (order.items || []).map(i => `• ${i.name} × ${i.quantity}`).join('<br>');
    await sendEmail({
      to: order.patientEmail,
      subject: `Order confirmed — ${order.orderId}`,
      html: `<p>Hi,</p><p>Your order <strong>${order.orderId}</strong> has been received.</p>
             <p>${itemsList}</p><p><strong>Total: KES ${(order.total||0).toLocaleString()}</strong></p>
             <p>We'll notify you as it's processed and dispatched.</p>
             <p>— Kerich Pharmaceuticals</p>`,
    });
    await sendSMS({
      to: order.patientPhone,
      message: `Kerich Pharmaceuticals: Order ${order.orderId} confirmed, total KES ${(order.total||0).toLocaleString()}. We'll text you delivery updates.`,
    });
  } catch (err) { console.error('notifyOrderConfirmed failed:', err.message); }
}

async function notifyOrderStatusChanged(order, status) {
  const STATUS_TEXT = {
    processing: 'is being processed',
    dispensed:  'has been dispensed and is ready for delivery',
    in_transit: 'is on its way to you',
    delivered:  'has been delivered',
    cancelled:  'has been cancelled',
  };
  const phrase = STATUS_TEXT[status];
  if (!phrase) return; // don't notify for statuses with no customer-facing meaning
  try {
    await sendSMS({
      to: order.patientPhone,
      message: `Kerich Pharmaceuticals: Your order ${order.orderId} ${phrase}.`,
    });
    if (status === 'delivered' || status === 'cancelled') {
      await sendEmail({
        to: order.patientEmail,
        subject: `Order ${order.orderId} ${status}`,
        html: `<p>Your order <strong>${order.orderId}</strong> ${phrase}.</p><p>— Kerich Pharmaceuticals</p>`,
      });
    }
  } catch (err) { console.error('notifyOrderStatusChanged failed:', err.message); }
}

async function notifyPrescriptionReviewed(prescription) {
  const approved = prescription.status === 'verified';
  try {
    await sendEmail({
      to: prescription.patientEmail,
      subject: approved ? 'Your prescription has been approved' : 'Update on your prescription',
      html: approved
        ? `<p>Good news — your uploaded prescription has been reviewed and approved by our pharmacist.</p>
           <p>You can now complete your purchase for the prescribed items in the shop.</p>
           <p>— Kerich Pharmaceuticals</p>`
        : `<p>Your uploaded prescription could not be approved.</p>
           ${prescription.rejectionReason ? `<p><strong>Reason:</strong> ${prescription.rejectionReason}</p>` : ''}
           <p>Please contact us or upload a new prescription if needed.</p>
           <p>— Kerich Pharmaceuticals</p>`,
    });
  } catch (err) { console.error('notifyPrescriptionReviewed failed:', err.message); }
}

async function notifyConsultationBooked(consultation) {
  try {
    await sendEmail({
      to: consultation.patientEmail,
      subject: `Consultation requested with ${consultation.doctorName}`,
      html: `<p>Your consultation request with <strong>${consultation.doctorName}</strong>
             (${consultation.doctorSpeciality || ''}) has been sent.</p>
             <p>Channel: ${consultation.channel}. We'll notify you once it's confirmed.</p>
             <p>— Kerich Pharmaceuticals</p>`,
    });
  } catch (err) { console.error('notifyConsultationBooked failed:', err.message); }
}

async function notifyConsultationStatusChanged(consultation, status) {
  if (!['confirmed', 'cancelled', 'declined'].includes(status)) return;
  try {
    const when = consultation.scheduledFor
      ? new Date(consultation.scheduledFor).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })
      : 'as soon as possible';
    const STATUS_TEXT = {
      confirmed: `has been confirmed for ${when}`,
      cancelled: 'has been cancelled',
      declined:  'could not be accepted by the doctor',
    };
    await sendEmail({
      to: consultation.patientEmail,
      subject: `Consultation update — ${consultation.doctorName}`,
      html: `<p>Your consultation with <strong>${consultation.doctorName}</strong> ${STATUS_TEXT[status]}.</p>
             <p>— Kerich Pharmaceuticals</p>`,
    });
    if (status === 'confirmed') {
      await sendSMS({
        to: consultation.patientPhone,
        message: `Kerich Pharmaceuticals: Your consultation with ${consultation.doctorName} is confirmed for ${when}.`,
      });
    }
  } catch (err) { console.error('notifyConsultationStatusChanged failed:', err.message); }
}

module.exports = {
  sendEmail, sendSMS,
  notifyOrderConfirmed, notifyOrderStatusChanged,
  notifyPrescriptionReviewed,
  notifyConsultationBooked, notifyConsultationStatusChanged,
};
