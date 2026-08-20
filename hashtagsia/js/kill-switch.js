/**
 * Kill Switch — reads the tools_enabled flag from the n8n verify-membership
 * webhook (which the backend returns on every call). If disabled, shows a
 * branded maintenance message and blocks the app. Load BEFORE membership-gate.js.
 *
 * The flag lives in Supabase app_config, but only n8n ever reads it — the
 * browser sees only the webhook response. To toggle:
 *   UPDATE app_config SET value='false' WHERE key='tools_enabled';  -- disable
 *   UPDATE app_config SET value='true'  WHERE key='tools_enabled';  -- enable
 */
const KillSwitch = (function() {
  const CHECK_INTERVAL = 5 * 60 * 1000; // re-check every 5 minutes
  let _isEnabled = true;
  let _checkTimer = null;

  async function checkStatus() {
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
      const resp = await fetch(base + '/verify-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await resp.json();

      _isEnabled = data.tools_enabled !== false;

      if (!_isEnabled) {
        showMaintenancePage();
      }

      return _isEnabled;
    } catch {
      return true;
    }
  }

  function showMaintenancePage() {
    document.querySelectorAll('.screen').forEach(function(s) {
      s.classList.remove('active');
      s.style.display = 'none';
    });

    let overlay = document.getElementById('killswitch-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'killswitch-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#fffdf7;';
    overlay.innerHTML = '<div style="text-align:center;max-width:480px;padding:32px;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;">' +
      '<div style="font-family:\'Arial Black\',sans-serif;font-weight:900;font-size:96px;line-height:1;color:#ff2e7e;-webkit-text-stroke:3px #0d0d0d;margin-bottom:16px;">#</div>' +
      '<h1 style="font-size:30px;font-weight:900;text-transform:uppercase;letter-spacing:-.02em;color:#0d0d0d;margin-bottom:16px;">Em Manutenção</h1>' +
      '<p style="color:#6b6b6b;font-size:16px;line-height:1.6;margin-bottom:24px;">Estamos realizando melhorias nesta ferramenta. Ela estará de volta em breve.</p>' +
      '<div style="display:inline-block;background:#2b34ff;color:#fff;padding:8px 20px;border-radius:100px;font-size:13px;font-weight:800;border:3px solid #0d0d0d;box-shadow:4px 4px 0 #0d0d0d;">Gênesis IA</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function startPeriodicCheck() {
    if (_checkTimer) clearInterval(_checkTimer);
    _checkTimer = setInterval(checkStatus, CHECK_INTERVAL);
  }

  async function init() {
    const enabled = await checkStatus();
    if (enabled) {
      startPeriodicCheck();
    }
    return enabled;
  }

  return {
    init: init,
    checkStatus: checkStatus,
    isEnabled: function() { return _isEnabled; }
  };
})();

window.KillSwitch = KillSwitch;
