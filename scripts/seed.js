// scripts/seed.js
// Run ONCE to populate Firestore: node scripts/seed.js
// Seeds: all 9,032 catalog products (from data/products.json), 6 doctors,
// admin user, pharmacy config, riders.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { initFirebase, getDb, getAuth } = require('../config/firebase');

initFirebase();
const db   = getDb();
const auth = getAuth();

const PRODUCTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/products.json'), 'utf8')
);

const DOCTORS = [
  { name:'Dr. Fatuma Mwangi', speciality:'General Practitioner', licence:'KMPDC-5510', fee:800,  available:true,  rating:4.9, reviews:312, email:'fatuma.mwangi@kerichpharma.co.ke' },
  { name:'Dr. Kevin Ochieng', speciality:'Cardiologist',         licence:'KMPDC-3892', fee:1500, available:true,  rating:5.0, reviews:198, email:'kevin.ochieng@kerichpharma.co.ke' },
  { name:'Dr. Aisha Njeri',   speciality:'Dermatologist',        licence:'KMPDC-6712', fee:1200, available:false, rating:4.7, reviews:256, email:'aisha.njeri@kerichpharma.co.ke' },
  { name:'Dr. James Kariuki', speciality:'Pediatrician',         licence:'KMPDC-2201', fee:1000, available:true,  rating:4.8, reviews:441, email:'james.kariuki@kerichpharma.co.ke' },
  { name:'Dr. Sarah Wambui',  speciality:'Endocrinologist',      licence:'KMPDC-4418', fee:1800, available:false, rating:4.6, reviews:187, email:'sarah.wambui@kerichpharma.co.ke' },
  { name:'Dr. Moses Kamau',   speciality:'Psychiatrist',         licence:'KMPDC-3301', fee:2000, available:true,  rating:4.9, reviews:503, email:'moses.kamau@kerichpharma.co.ke' },
];
const DOCTOR_DEFAULT_PASSWORD = 'KerichDoctor2025!';

const RIDERS = [
  { name: 'Brian Otieno',  email: 'brian.otieno@kerichpharma.co.ke',  phoneNumber: '+254711000001' },
  { name: 'Grace Achieng', email: 'grace.achieng@kerichpharma.co.ke', phoneNumber: '+254711000002' },
];
const RIDER_DEFAULT_PASSWORD = 'KerichRider2025!';

async function seed() {
  console.log('\n🌱 Seeding Firestore — project: kerich-4aefa');

  // ── Products in batches ──────────────────────────────────
  console.log(`\n📦 Seeding ${PRODUCTS.length} products…`);
  const BATCH_SIZE = 400;
  for (let i = 0; i < PRODUCTS.length; i += BATCH_SIZE) {
    const chunk = PRODUCTS.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(p => {
      batch.set(db.collection('products').doc(), {
        sku:         p.sku,
        name:        p.name,
        price:       p.price,
        category:    p.category,
        rawCategory: p.rawCategory,
        type:        p.type,
        icon:        p.icon,
        image:       p.image || null,
        description: p.description || null,
        active:      p.active,
        stock:       p.stock,
        unitCost:    p.unitCost,
        createdAt:   new Date(),
        updatedAt:   new Date(),
      });
    });
    await batch.commit();
    process.stdout.write(`   ✓ Batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(PRODUCTS.length/BATCH_SIZE)} done\n`);
  }
  console.log(`   ✅ ${PRODUCTS.length} products seeded`);

  // ── Doctors ──────────────────────────────────────────────
  // Each doctor gets a real Firebase Auth account (kerich_role: 'doctor')
  // so they can log in to the doctor portal and manage their own
  // consultation queue. The doctors/{id} doc stores `uid` linking back to
  // that account — that's how routes/consultations.js resolves "my queue".
  console.log('\n👨‍⚕️  Seeding doctors + doctor accounts…');
  for (const d of DOCTORS) {
    let uid;
    try {
      const existing = await auth.getUserByEmail(d.email);
      uid = existing.uid;
      console.log(`   ℹ️  ${d.name}: account already exists (${d.email})`);
    } catch {
      const created = await auth.createUser({
        email: d.email, password: DOCTOR_DEFAULT_PASSWORD,
        displayName: d.name, emailVerified: true,
      });
      uid = created.uid;
      console.log(`   ✅ ${d.name}: account created (${d.email})`);
    }
    await auth.setCustomUserClaims(uid, { kerich_role: 'doctor' });

    const { email, ...doctorFields } = d;
    await db.collection('doctors').doc(uid).set({ ...doctorFields, email, uid, createdAt: new Date() }, { merge: true });

    await db.collection('users').doc(uid).set({
      uid, email, displayName: d.name, role: 'doctor', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    }, { merge: true });
  }
  console.log(`   ✅ ${DOCTORS.length} doctors + accounts seeded`);

  // ── Riders ───────────────────────────────────────────────
  // Unlike doctors, riders have no separate collection — just a real
  // Firebase Auth account (kerich_role: 'rider') and a users/{uid} doc.
  console.log('\n🏍️  Seeding riders…');
  for (const r of RIDERS) {
    let uid;
    try {
      const existing = await auth.getUserByEmail(r.email);
      uid = existing.uid;
      console.log(`   ℹ️  ${r.name}: account already exists (${r.email})`);
    } catch {
      const created = await auth.createUser({
        email: r.email, password: RIDER_DEFAULT_PASSWORD,
        displayName: r.name, emailVerified: true,
      });
      uid = created.uid;
      console.log(`   ✅ ${r.name}: account created (${r.email})`);
    }
    await auth.setCustomUserClaims(uid, { kerich_role: 'rider' });

    await db.collection('users').doc(uid).set({
      uid, email: r.email, displayName: r.name, phoneNumber: r.phoneNumber,
      role: 'rider', status: 'active',
      createdAt: new Date(), updatedAt: new Date(),
    }, { merge: true });
  }
  console.log(`   ✅ ${RIDERS.length} riders + accounts seeded`);

  // ── Admin user ───────────────────────────────────────────
  console.log('\n🔑 Creating admin user…');
  const adminEmail    = 'admin@kerichpharma.co.ke';
  const adminPassword = 'KerichAdmin2025!';
  let adminUid;
  try {
    const ex = await auth.getUserByEmail(adminEmail);
    adminUid  = ex.uid;
    console.log(`   ℹ️  Admin already exists: ${adminEmail}`);
  } catch {
    const nu  = await auth.createUser({ email:adminEmail, password:adminPassword, displayName:'Admin Ochieng', emailVerified:true });
    adminUid  = nu.uid;
    console.log(`   ✅ Admin created: ${adminEmail} / ${adminPassword}`);
  }
  await auth.setCustomUserClaims(adminUid, { kerich_role:'admin' });
  await db.collection('users').doc(adminUid).set({
    uid:adminUid, email:adminEmail, displayName:'Admin Ochieng',
    role:'admin', status:'active', createdAt:new Date(), updatedAt:new Date()
  }, { merge:true });

  // ── Pharmacy config ──────────────────────────────────────
  // latitude/longitude are optional (used only to drop a precise pin on the
  // admin map link); the "open in Google Maps" link itself works from the
  // address text alone, so this is a nice-to-have, not a requirement.
  await db.collection('config').doc('pharmacy').set({
    name:'Kerich Pharmaceuticals Ltd', ppbLicence:'PPB/2025/NBI/0142',
    address:'Kilimani, Nairobi, Kenya', phone:'+254 700 000 000',
    latitude: -1.2864, longitude: 36.7873,
    email:'hello@kerichpharma.co.ke', website:'https://kerichpharma.co.ke',
    openingHours:'24/7', deliveryRadius:50, deliveryFee:150, freeDeliveryAbove:2000,
    updatedAt:new Date()
  });

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  🎉 Seed complete!                                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Admin: ${adminEmail.padEnd(41)}║`);
  console.log(`║  Pass:  ${adminPassword.padEnd(41)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Doctor accounts (all use the same password):     ║`);
  console.log(`║  Pass:  ${DOCTOR_DEFAULT_PASSWORD.padEnd(41)}║`);
  DOCTORS.forEach(d => console.log(`║   - ${d.email.padEnd(45)}║`));
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Rider accounts (all use the same password):      ║`);
  console.log(`║  Pass:  ${RIDER_DEFAULT_PASSWORD.padEnd(41)}║`);
  RIDERS.forEach(r => console.log(`║   - ${r.email.padEnd(45)}║`));
  console.log('║  ⚠️  Change admin password after first login!    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  process.exit(0);
}

seed().catch(err => { console.error('❌ Seed failed:', err.message); process.exit(1); });
