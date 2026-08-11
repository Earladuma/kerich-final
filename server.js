// ════════════════════════════════════════════════════════════════
//  Kerich Pharmaceuticals — Express Server
//  Serves both the client app (/) and admin app (/admin)
//  All API routes are Firebase-backed via Admin SDK
// ════════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const { initializeServices } = require('./services');
const { errorHandler }       = require('./middleware/errorHandler');
const { authenticateToken }  = require('./middleware/auth');

// ── Route imports ─────────────────────────────────────────────
const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const pharmacyRoutes    = require('./routes/pharmacy');
const orderRoutes       = require('./routes/orders');
const prescriptionRoutes = require('./routes/prescriptions');
const consultationRoutes = require('./routes/consultations');
const seoRoutes           = require('./routes/seo');
const deliveryRoutes    = require('./routes/delivery');
const paymentRoutes     = require('./routes/payments');
const complianceRoutes  = require('./routes/compliance');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security ──────────────────────────────────────────────────
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'",
                    "https://cdnjs.cloudflare.com",
                    "https://www.gstatic.com",
                    "https://cdn.jsdelivr.net"],
      styleSrc:    ["'self'", "'unsafe-inline'",
                    "https://fonts.googleapis.com",
                    "https://cdnjs.cloudflare.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "https:", "blob:"],
      connectSrc:  ["'self'",
                    "https://*.firebaseio.com",
                    "https://*.googleapis.com",
                    "https://*.firebasestorage.googleapis.com",
                    "https://identitytoolkit.googleapis.com",
                    "https://securetoken.googleapis.com",
                    "stun:stun.l.google.com:19302"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Explicit Permissions-Policy: camera/microphone must be allowed for the
// consultation video/voice call feature to work — some hosting layers set
// a restrictive default that would otherwise silently block getUserMedia
// with no clear error for the person using it.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
  next();
});

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,   // stricter for auth endpoints
  message: { error: 'Too many login attempts. Please try again later.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:5000',
  'http://127.0.0.1:5500',     // Live Server (VS Code)
  'http://localhost:5500',
  'https://kerich-4aefa.web.app',
  'https://kerich-4aefa.firebaseapp.com',
  'https://kerichpharma.co.ke',
  'https://admin.kerichpharma.co.ke',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed.`));
  },
  credentials: true,
  optionsSuccessStatus: 200,
}));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Static files ──────────────────────────────────────────────
// Serve client app from /public
app.use(express.static(path.join(__dirname, 'public'), {
  etag:         true,
  maxAge:       '1d',
  setHeaders(res, filePath) {
    // Never cache the HTML entry points — always fetch fresh
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'OK',
    service:     'Kerich Pharmaceuticals API',
    version:     '1.0.0',
    timestamp:   new Date().toISOString(),
    uptime:      `${Math.floor(process.uptime())}s`,
    environment: process.env.NODE_ENV || 'development',
  });
});

// ── Firebase config endpoint (safe — public keys only) ────────
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
    measurementId:     process.env.FIREBASE_MEASUREMENT_ID,
  });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/users',         authenticateToken, userRoutes);
app.use('/api/pharmacy',      pharmacyRoutes);
app.use('/',                   seoRoutes);
app.use('/api/orders',        authenticateToken, orderRoutes);
app.use('/api/prescriptions', authenticateToken, prescriptionRoutes);
app.use('/api/consultations', authenticateToken, consultationRoutes);
app.use('/api/delivery',      authenticateToken, deliveryRoutes);
// NOTE: paymentRoutes is mounted WITHOUT a blanket authenticateToken here
// because /api/payments/mpesa/callback must stay public — Safaricom calls it
// directly with no Authorization header. Every other route inside
// routes/payments.js (initiate, stripe/process, :orderId) applies
// authenticateToken itself, per-route.
app.use('/api/payments',      paymentRoutes);
app.use('/api/compliance',    authenticateToken, complianceRoutes);

// ── SPA fallback routes ───────────────────────────────────────
// Admin app — must come BEFORE the catch-all
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Client app catch-all (SPA routing)
app.get('*', (req, res) => {
  // Don't serve HTML for API 404s
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler (must be last) ──────────────────────────────
app.use(errorHandler);

// ── Boot ──────────────────────────────────────────────────────
// initFirebase() inside initializeServices() is fully synchronous
// internally (no real await), so by the time this call returns, Firebase
// Admin is already initialized — `module.exports = app` below is safe
// even though app.listen() itself is deferred into the .then() below.
initializeServices()
  .then(() => {
    // On Vercel, api/index.js exports this same `app` and Vercel's
    // runtime invokes it per-request — it must never call .listen()
    // itself. Everywhere else (local dev, a VM, Render, etc.) this is
    // exactly the previous unconditional behavior.
    if (process.env.VERCEL) return;

    const server = app.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║    Kerich Pharmaceuticals Server             ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  Client app : http://localhost:${PORT}         ║`);
      console.log(`║  Admin app  : http://localhost:${PORT}/admin   ║`);
      console.log(`║  API docs   : http://localhost:${PORT}/health  ║`);
      console.log(`║  Mode       : ${(process.env.NODE_ENV || 'development').padEnd(30)}║`);
      console.log('╚══════════════════════════════════════════════╝');
      console.log('');
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Change PORT in .env`);
      } else {
        console.error('❌ Server error:', err.message);
      }
      process.exit(1);
    });

    const gracefulShutdown = (signal) => {
      console.log(`\n${signal} received — shutting down gracefully...`);
      server.close(() => {
        console.log('✅ Server closed.');
        process.exit(0);
      });
      setTimeout(() => { console.error('⚠️  Forced exit.'); process.exit(1); }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      console.error('⚠️  Unhandled Rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('❌ Uncaught Exception:', err);
      process.exit(1);
    });
  })
  .catch(err => {
    console.error('❌ Failed to start server:', err.message);
    console.error('\nCommon fixes:');
    console.error('  1. Add FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY to .env, OR');
    console.error('  2. Place your service account JSON at config/serviceAccountKey.json');
    process.exit(1);
  });

module.exports = app;
