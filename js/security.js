<script>
(function () {

  const ADMIN_EMAIL = "youradmin@email.com";

  /* ================= WAIT FOR FIREBASE ================= */
  function waitForFirebase(callback) {
    const interval = setInterval(() => {
      if (window.firebase && firebase.auth) {
        clearInterval(interval);
        callback();
      }
    }, 100);
  }

  /* ================= INIT SECURITY ================= */
  window.initSecurity = function ({ requireAuth = false, requireAdmin = false } = {}) {

    waitForFirebase(() => {

      firebase.auth().onAuthStateChanged(user => {

        if (!user) {
          if (requireAuth) {
            window.location.href = "login.html";
          }
          return;
        }

        const isAdmin = user.email === ADMIN_EMAIL;

        if (requireAdmin && !isAdmin) {
          alert("Access denied");
          window.location.href = "index.html";
          return;
        }

        applyRoleUI(isAdmin);

      });

    });
  };

  /* ================= UI CONTROL ================= */
  function applyRoleUI(isAdmin) {
    document.querySelectorAll("[data-admin]").forEach(el => {
      el.style.display = isAdmin ? "block" : "none";
    });
  }

  /* ================= SAFE UPDATE ================= */
  window.secureUpdate = async function (docRef, data) {

    const user = firebase.auth().currentUser;

    if (!user || user.email !== ADMIN_EMAIL) {
      console.error("Blocked unauthorized update");
      return;
    }

    return docRef.update(data);
  };

  /* ================= SANITIZE ================= */
  window.sanitize = function (input) {
    if (!input) return "";
    return input.toString().replace(/[<>&"']/g, "");
  };

})();
</script></script>