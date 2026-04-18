const express  = require('express');
const router   = express.Router();
const admin    = require('firebase-admin');
const multer   = require('multer');
const path     = require('path');
const { getDb, getStorage } = require('../config/firebase');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Multer — memory storage (we stream to Firebase Storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(req, file, cb) {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    const ext     = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error('Only JPG, PNG, and PDF files are allowed.'));
    }
    cb(null, true);
  },
});

// POST /api/prescriptions  — patient uploads prescription image/PDF
router.post('/', authenticateToken, upload.single('file'), async (req, res, next) => {
  try {
    const db     = getDb();
    const bucket = getStorage().bucket();

    let fileUrl  = null;
    let fileName = null;

    if (req.file) {
      // Upload to Firebase Storage under prescriptions/{uid}/{timestamp}-{originalname}
      const timestamp = Date.now();
      fileName        = `prescriptions/${req.user.uid}/${timestamp}-${req.file.originalname}`;
      const fileRef   = bucket.file(fileName);

      await fileRef.save(req.file.buffer, {
        metadata: {
          contentType:  req.file.mimetype,
          metadata: {
            uploadedBy: req.user.uid,
            purpose:    'prescription',
          },
        },
      });

      // Generate signed URL (7 days) — pharmacist can view
      const [url] = await fileRef.getSignedUrl({
        action:  'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      fileUrl = url;
    }

    const { medicines, doctorName, doctorLicence, notes = '' } = req.body;

    const rxRef  = db.collection('prescriptions').doc();
    const rxData = {
      patientId:      req.user.uid,
      patientEmail:   req.user.email,
      medicines:      medicines ? (typeof medicines === 'string' ? JSON.parse(medicines) : medicines) : [],
      doctorName:     doctorName || null,
      doctorLicence:  doctorLicence || null,
      notes,
      fileUrl,
      filePath:       fileName,
      status:         'pending_verification', // pending_verification | verified | rejected
      verifiedBy:     null,
      verifiedAt:     null,
      rejectionReason: null,
      expiryDate:     null,
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    };

    await rxRef.set(rxData);

    // Audit log — PPB requirement
    await db.collection('audit_logs').add({
      action:          'PRESCRIPTION_UPLOADED',
      prescriptionId:  rxRef.id,
      patientId:       req.user.uid,
      filePath:        fileName,
      timestamp:       admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ id: rxRef.id, status: 'pending_verification', fileUrl });
  } catch (err) { next(err); }
});

// GET /api/prescriptions  — patient: own only; pharmacist/admin: all
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const db   = getDb();
    const role = req.user.kerich_role || req.user['kerich_role'];

    let q = db.collection('prescriptions').orderBy('createdAt', 'desc');
    if (!['admin', 'pharmacist'].includes(role)) {
      q = db.collection('prescriptions')
            .where('patientId', '==', req.user.uid)
            .orderBy('createdAt', 'desc');
    }

    const snap = await q.get();
    const rxs  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ prescriptions: rxs });
  } catch (err) { next(err); }
});

// PATCH /api/prescriptions/:id/verify  — pharmacist / admin
router.patch('/:id/verify', authenticateToken, requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const db  = getDb();
    const { action, rejectionReason, expiryDate } = req.body; // action: 'approve' | 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: "action must be 'approve' or 'reject'." });
    }

    const status = action === 'approve' ? 'verified' : 'rejected';

    await db.collection('prescriptions').doc(req.params.id).update({
      status,
      verifiedBy:      req.user.uid,
      verifiedAt:      new Date().toISOString(),
      rejectionReason: rejectionReason || null,
      expiryDate:      expiryDate || null,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    // Audit log — PPB requirement: all Rx decisions must be logged
    await db.collection('audit_logs').add({
      action:          `PRESCRIPTION_${status.toUpperCase()}`,
      prescriptionId:  req.params.id,
      pharmacistId:    req.user.uid,
      rejectionReason: rejectionReason || null,
      timestamp:       admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: `Prescription ${status}.` });
  } catch (err) { next(err); }
});

module.exports = router;
