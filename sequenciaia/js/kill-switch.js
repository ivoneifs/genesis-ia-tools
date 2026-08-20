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
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#efe6d3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    overlay.innerHTML = '<div style="text-align:center;max-width:480px;padding:32px;">' +
      '<div style="width:76px;height:76px;margin:0 auto 24px;border-radius:50%;border:2.5px solid #c8102e;color:#c8102e;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 5px rgba(200,16,46,.08);"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div>' +
      '<h1 style="font-family:\'Arial Narrow\',\'Helvetica Neue\',sans-serif;text-transform:uppercase;letter-spacing:.04em;font-size:32px;font-weight:800;margin-bottom:16px;color:#1c2b4a;">Em Manutenção</h1>' +
      '<p style="color:#46506a;font-size:16px;line-height:1.6;margin-bottom:24px;">Estamos realizando melhorias nesta ferramenta. Ela estará de volta em breve.</p>' +
      '<div style="display:inline-block;background:rgba(47,90,168,.12);color:#24467f;padding:8px 20px;border-radius:100px;font-size:13px;font-weight:700;border:1px solid rgba(47,90,168,.28);">Gênesis IA</div>' +
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
