const { initFirebase } = require('../config/firebase');

async function initializeServices() {
  // Boot Firebase Admin
  initFirebase();
  console.log('✅ Services initialised');
}

module.exports = { initializeServices };
