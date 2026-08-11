// ─── Kerich Pharmaceuticals — Firebase Config ───────────────────────────────
// Firebase Admin SDK (server-side only)

const admin = require("firebase-admin");
const path = require("path");

let db, auth, storage, initialized = false;

/**
 * 🔥 Load service account JSON safely (NO PATH ISSUES)
 */
function getJsonCredential() {
  try {
    // ALWAYS resolves correctly relative to THIS file
    const sa = require(path.join(__dirname, "../serviceAccountKey.json"));

    return admin.credential.cert(sa);
  } catch (err) {
    console.log("⚠️ serviceAccountKey.json not found or invalid:", err.message);
    return null;
  }
}

/**
 * ⚠️ OPTIONAL fallback: environment variables (only if JSON fails)
 */
function getEnvCredential() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return null;
  }

  try {
    const privateKey = FIREBASE_PRIVATE_KEY
      .replace(/\\n/g, "\n")   // fix escaped newlines
      .replace(/^"|"$/g, "")   // remove accidental quotes
      .trim();

    return admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey,
    });
  } catch (err) {
    console.log("⚠️ .env Firebase credentials invalid:", err.message);
    return null;
  }
}

/**
 * 🎯 Credential resolver (JSON FIRST, ENV fallback)
 */
function getCredential() {
  const jsonCred = getJsonCredential();
  if (jsonCred) return jsonCred;

  const envCred = getEnvCredential();
  if (envCred) return envCred;

  throw new Error(
    "❌ Firebase credentials missing.\n" +
    "✔ Place serviceAccountKey.json in project root OR\n" +
    "✔ Fix .env Firebase credentials"
  );
}

/**
 * 🚀 Initialize Firebase Admin
 */
function initFirebase() {
  if (initialized) return { db, auth, storage };

  admin.initializeApp({
    credential: getCredential(),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ||
      "kerich-4aefa.firebasestorage.app",
  });

  db = admin.firestore();
  auth = admin.auth();
  storage = admin.storage();

  db.settings({
    ignoreUndefinedProperties: true,
  });

  initialized = true;

  console.log(
    "✅ Firebase Admin initialized — project:",
    process.env.FIREBASE_PROJECT_ID || "kerich-4aefa"
  );

  return { db, auth, storage };
}

module.exports = {
  initFirebase,
  getDb: () => db,
  getAuth: () => auth,
  getStorage: () => storage,
};