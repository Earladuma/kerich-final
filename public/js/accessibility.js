/* ═══════════════════════════════════════════════════════════
   ACCESSIBILITY WIDGET — shared across every page.
   Pairs with public/css/accessibility.css and the small inline
   FOUC-prevention snippet each page includes in <head> (see any
   page's <head> for a11yApplyStored(), which this file reuses).
   ═══════════════════════════════════════════════════════════ */
(function () {
  const STORAGE_KEYS = {
    theme:  'kerich_theme',
    scale:  'kerich_a11y_scale',
    motion: 'kerich_reduce_motion',
  };
  const SCALES = [
    { value: '0.9',  label: 'A-'  },
    { value: '1',    label: 'A'   },
    { value: '1.1',  label: 'A+'  },
    { value: '1.25', label: 'A++' },
  ];

  function getPref(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function setPref(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable — degrade silently */ }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  function applyScale(scale) {
    if (scale === '1') document.documentElement.removeAttribute('data-a11y-scale');
    else document.documentElement.setAttribute('data-a11y-scale', scale);
  }
  function applyMotion(reduced) {
    document.documentElement.classList.toggle('a11y-reduce-motion', reduced === 'true');
  }

  function buildWidget() {
    const btn = document.createElement('button');
    btn.id = 'a11y-toggle-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Accessibility settings');
    btn.setAttribute('aria-haspopup', 'true');
    btn.textContent = '♿';

    const panel = document.createElement('div');
    panel.id = 'a11y-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Accessibility settings');
    panel.innerHTML = `
      <h3>Accessibility</h3>
      <div class="a11y-row">
        <span class="a11y-label">Theme</span>
        <div class="a11y-btn-group" role="group" aria-label="Theme">
          <button type="button" class="a11y-btn" data-a11y-theme="dark">🌙 Dark</button>
          <button type="button" class="a11y-btn" data-a11y-theme="light">☀️ Light</button>
        </div>
      </div>
      <div class="a11y-row">
        <span class="a11y-label">Text &amp; UI size</span>
        <div class="a11y-btn-group" role="group" aria-label="Text and UI size">
          ${SCALES.map(s => `<button type="button" class="a11y-btn" data-a11y-scale="${s.value}">${s.label}</button>`).join('')}
        </div>
      </div>
      <div class="a11y-row a11y-toggle-row">
        <span class="a11y-label" style="margin-bottom:0;">Reduce motion</span>
        <button type="button" class="a11y-switch" id="a11y-motion-switch" role="switch" aria-checked="false" aria-label="Reduce motion"></button>
      </div>
      <button type="button" id="a11y-reset-btn">Reset to defaults</button>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    btn.addEventListener('click', () => {
      const isOpen = panel.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) syncPanelState();
    });
    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== btn && panel.classList.contains('open')) {
        panel.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && panel.classList.contains('open')) {
        panel.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });

    panel.querySelectorAll('[data-a11y-theme]').forEach(b => {
      b.addEventListener('click', () => {
        const theme = b.dataset.a11yTheme;
        applyTheme(theme);
        setPref(STORAGE_KEYS.theme, theme);
        syncPanelState();
      });
    });
    panel.querySelectorAll('[data-a11y-scale]').forEach(b => {
      b.addEventListener('click', () => {
        const scale = b.dataset.a11yScale;
        applyScale(scale);
        setPref(STORAGE_KEYS.scale, scale);
        syncPanelState();
      });
    });
    const motionSwitch = panel.querySelector('#a11y-motion-switch');
    motionSwitch.addEventListener('click', () => {
      const next = getPref(STORAGE_KEYS.motion, 'false') === 'true' ? 'false' : 'true';
      applyMotion(next);
      setPref(STORAGE_KEYS.motion, next);
      syncPanelState();
    });
    panel.querySelector('#a11y-reset-btn').addEventListener('click', () => {
      applyTheme('dark'); setPref(STORAGE_KEYS.theme, 'dark');
      applyScale('1');    setPref(STORAGE_KEYS.scale, '1');
      applyMotion('false'); setPref(STORAGE_KEYS.motion, 'false');
      syncPanelState();
    });

    function syncPanelState() {
      const theme  = getPref(STORAGE_KEYS.theme, 'dark');
      const scale  = getPref(STORAGE_KEYS.scale, '1');
      const motion = getPref(STORAGE_KEYS.motion, 'false');
      panel.querySelectorAll('[data-a11y-theme]').forEach(b => b.classList.toggle('active', b.dataset.a11yTheme === theme));
      panel.querySelectorAll('[data-a11y-scale]').forEach(b => b.classList.toggle('active', b.dataset.a11yScale === scale));
      motionSwitch.classList.toggle('on', motion === 'true');
      motionSwitch.setAttribute('aria-checked', String(motion === 'true'));
    }
    syncPanelState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }
})();
