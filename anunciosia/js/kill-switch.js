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
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#f4f1ea;';
    overlay.innerHTML = '<div style="text-align:center;max-width:480px;padding:32px;">' +
      '<div style="font-size:48px;margin-bottom:24px;">🔧</div>' +
      '<h1 style="font-family:Impact,\'Arial Narrow Bold\',\'Helvetica Neue\',sans-serif;text-transform:uppercase;letter-spacing:.02em;font-size:40px;margin-bottom:16px;color:#141210;">Em <span style="color:#e5341f;">Manutenção</span></h1>' +
      '<p style="color:#3a352d;font-size:16px;line-height:1.6;margin-bottom:24px;">Estamos realizando melhorias nesta ferramenta. Ela estará de volta em breve.</p>' +
      '<div style="display:inline-block;background:#ffd400;color:#141210;padding:8px 20px;border-radius:100px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border:2px solid #141210;">Gênesis IA</div>' +
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
