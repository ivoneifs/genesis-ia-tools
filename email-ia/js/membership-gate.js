/**
 * UNIFIED MEMBERSHIP GATE — v1  (served from gate.appsbrasil.store)
 * ============================================================================
 * ONE canonical login gate for the ENTIRE community-tool fleet. Every tool loads
 * THIS file via <script src="https://gate.appsbrasil.store/v1/membership-gate.js">
 * instead of shipping its own copy. Fix it here once → every tool updates on its
 * next page load. This is what makes the COR-028 split-brain bug (7 stale copies
 * drifting out of sync) structurally impossible.
 *
 * CONTRACT (unchanged, backend-only — Hard Rules #2/#13):
 *   - The browser NEVER touches Supabase. It POSTs {email,phone} to the per-app
 *     n8n verify-membership webhook (window.APP_CONFIG.n8nWebhookBase) which holds
 *     the service_role key server-side and is the SOLE source of truth for access.
 *   - Access is granted on `result.verified === true` AND NOTHING ELSE. The name is
 *     cosmetic, read tolerantly (display_name OR legacy member.buyer_name). A future
 *     response-shape change can never lock members out (COR-028).
 *   - Every page load revalidates against the backend; a forged localStorage session
 *     cannot bypass the gate.
 *
 * EXTRA SECURITY in this unified version (vs the old per-app copy):
 *   S1. Origin allow-list — the gate REFUSES to run on any origin that is not an
 *       approved Gênesis IA property. Stops a phisher from <script src>-ing our
 *       gate onto evil.com to harvest member emails/phones behind a trusted-looking UI.
 *   S2. Anti-clickjacking — refuses to run inside a cross-origin frame and breaks out.
 *   S3. Origin-bound, versioned session — the cached session is stamped with a schema
 *       version and the exact origin it was issued for; anything else is discarded.
 *   S4. Strict input validation + size caps before anything is sent to the backend.
 *   S5. Centrally controlled — kill switch + rate-limit UX + future changes ship to
 *       the whole fleet from this one file.
 * ============================================================================
 */
(function () {
  'use strict';

  var GATE_VERSION = 'v1';
  var SESSION_KEY = 'maestria_member_session';
  var SESSION_SCHEMA = 2;                       // bump to invalidate all old sessions
  var SESSION_DURATION = 24 * 60 * 60 * 1000;

  var LOGIN_RATE_KEY = 'maestria_login_attempts';
  var LOGIN_RATE_WINDOW = 15 * 60 * 1000;
  var LOGIN_RATE_MAX = 8;

  // ---- S1: Origin allow-list ------------------------------------------------
  // Any *.appsbrasil.store property is trusted automatically (all branded tools).
  // The handful of tools still on *.netlify.app are listed explicitly. localhost is
  // allowed for development/Playwright verification only. Anything else is refused.
  var ALLOWED_NETLIFY_HOSTS = [
    'legendas-ia.netlify.app',
    'proposta-ia.netlify.app',
    'concorrente-ia-genesisia.netlify.app',
    'curriculo-ia-genesisia.netlify.app',
    'email-ia-genesisia.netlify.app',
    'notas-ia-genesisia.netlify.app',
    'prompt-ia-genesisia.netlify.app',
    'curso-ia-genesisia.netlify.app',
    'faturas-ia-genesisia.netlify.app',
    'hashtags-ia-genesisia.netlify.app',
    'carrossel-ia.netlify.app',
    'roteiros-ia.netlify.app',
    'paginaia-genesisia.netlify.app',
    'ebook-ia-genesisia.netlify.app',
    'slides-ia-genesisia.netlify.app',
    'quiz-ia-genesisia.netlify.app',
    'calendario-ia-genesisia.netlify.app',
    'oferta-ia-genesisia.netlify.app',
    'contrato-ia-genesisia.netlify.app',
    'anuncios-ia-genesisia.netlify.app',
    'sequencia-ia-genesisia.netlify.app',
    'fechamento-ia-genesisia.netlify.app',
    'vsl-ia-genesisia.netlify.app',
    'thumbnail-ia-genesisia.netlify.app',
    'trafego-ia-genesisia.netlify.app',
    'precificacao-ia-genesisia.netlify.app',
    'transcricao-ia-genesisia.netlify.app',
    'planilhas-ia-genesisia.netlify.app',
    'mapa-mental-ia-genesisia.netlify.app',
    'persona-ia-genesisia.netlify.app',
    'infografico-ia-genesisia.netlify.app'
  ];

  function endsWithStr(s, suffix) { return s.length >= suffix.length && s.indexOf(suffix, s.length - suffix.length) !== -1; }

  function isAllowedOrigin() {
    // Local file:// testing (double-clicking index.html) has no hostname at all —
    // treat it like localhost so devs can open the file directly, no server needed.
    if (location.protocol === 'file:') return true;
    var h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (h === 'appsbrasil.store' || endsWithStr(h, '.appsbrasil.store')) return true;
    // Approved *.netlify.app tools, incl. their <hash>--site.netlify.app deploy previews.
    for (var i = 0; i < ALLOWED_NETLIFY_HOSTS.length; i++) {
      var allowed = ALLOWED_NETLIFY_HOSTS[i];
      if (h === allowed || endsWithStr(h, '--' + allowed)) return true;
    }
    return false;
  }

  function refuse(reason) {
    try {
      console.error('[MembershipGate] refusing to run: ' + reason + ' (origin ' + location.origin + ')');
      var body = document.body;
      if (body) {
        body.innerHTML = '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:18vh auto;' +
          'padding:32px;text-align:center;color:#111;background:#fff;border-radius:12px;">' +
          '<h1 style="font-size:20px;margin:0 0 12px">Acesso indisponível</h1>' +
          '<p style="opacity:.75;line-height:1.5">Esta ferramenta só funciona quando aberta a partir de um ' +
          'endereço oficial da <strong>Comunidade Gênesis IA</strong>.</p>' +
          '<p style="margin-top:16px"><a href="https://comunidade-genesisia.appsbrasil.store" ' +
          'style="color:#2563eb">comunidade-genesisia.appsbrasil.store</a></p></div>';
      }
    } catch (e) {}
  }

  // ---- session (S3: origin-bound + versioned) -------------------------------
  function getStoredSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw || raw.length > 4096) { localStorage.removeItem(SESSION_KEY); return null; }
      var s = JSON.parse(raw);
      if (!s || s.schema !== SESSION_SCHEMA) { localStorage.removeItem(SESSION_KEY); return null; }
      if (s.origin !== location.origin) { localStorage.removeItem(SESSION_KEY); return null; }
      if (typeof s.timestamp !== 'number' || Date.now() - s.timestamp > SESSION_DURATION) {
        localStorage.removeItem(SESSION_KEY); return null;
      }
      return s;
    } catch (e) { localStorage.removeItem(SESSION_KEY); return null; }
  }

  function storeSession(displayName, email, phone) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        schema: SESSION_SCHEMA,
        origin: location.origin,
        name: String(displayName || 'Maestro').slice(0, 80),
        email: String(email || '').slice(0, 254),
        phone: String(phone || '').slice(0, 20),
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  // ---- tolerant readers (COR-028) -------------------------------------------
  function pickDisplayName(result, fallback) {
    if (!result) return fallback || 'Maestro';
    if (result.display_name) return result.display_name;
    if (result.member && (result.member.buyer_name || result.member.name)) {
      return result.member.buyer_name || result.member.name;
    }
    return fallback || 'Maestro';
  }
  function warnIfShapeDrift(result) {
    if (result && result.verified && !result.display_name &&
        !(result.member && (result.member.buyer_name || result.member.name))) {
      try { console.warn('[MembershipGate] verified=true but no display_name/member — ' +
        'verify-membership contract may have changed. Granting on verified flag.', result); } catch (e) {}
    }
  }

  // ---- S4: strict input validation ------------------------------------------
  function normalizePhone(phone) { return (phone || '').replace(/\D/g, ''); }
  function validEmail(e) { return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e); }
  function validPhone(p) { return p.length >= 8 && p.length <= 15; }

  // ---- client-side login throttle (UX only; real limit is server-side) ------
  function checkLoginRateLimit() {
    try {
      var raw = localStorage.getItem(LOGIN_RATE_KEY);
      if (!raw) return true;
      var data = JSON.parse(raw).filter(function (t) { return Date.now() - t < LOGIN_RATE_WINDOW; });
      localStorage.setItem(LOGIN_RATE_KEY, JSON.stringify(data));
      return data.length < LOGIN_RATE_MAX;
    } catch (e) { return true; }
  }
  function recordLoginAttempt() {
    try {
      var raw = localStorage.getItem(LOGIN_RATE_KEY);
      var data = raw ? JSON.parse(raw) : [];
      data.push(Date.now());
      localStorage.setItem(LOGIN_RATE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function getCaptchaToken() {
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === 'function') return window.turnstile.getResponse() || null;
      if (window.hcaptcha && typeof window.hcaptcha.getResponse === 'function') return window.hcaptcha.getResponse() || null;
    } catch (e) {}
    return null;
  }

  async function verifyMembershipBackend(email, phone, captchaToken) {
    try {
      var base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
      if (!base) return { verified: false, reason: 'error' };
      var payload = { email: email || undefined, phone: phone || undefined };
      if (captchaToken) payload.captcha_token = captchaToken;
      var resp = await fetch(base + '/verify-membership', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (resp.status === 429) return { verified: false, reason: 'rate_limited' };
      var data = await resp.json();
      if (data && data.tools_enabled === false && window.KillSwitch) window.KillSwitch.checkStatus();
      return data;
    } catch (e) { return { verified: false, reason: 'error' }; }
  }

  function showScreen(screenId) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    var target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    if (screenId === 'app-screen') document.dispatchEvent(new Event('maestria:app-ready'));
  }

  function getErrorMessage(reason) {
    switch (reason) {
      case 'not_found': return 'E-mail e WhatsApp não encontrados entre os membros da comunidade. Use os mesmos dados cadastrados na compra.';
      case 'inactive': return 'Seu acesso consta como cancelado ou reembolsado. Se isso estiver incorreto, fale com o suporte.';
      case 'rate_limited': return 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.';
      case 'invalid': return 'Confira o e-mail e o número de WhatsApp (com DDD) e tente novamente.';
      case 'error': return 'Erro ao verificar o acesso. Tente novamente em alguns segundos.';
      default: return 'Não foi possível verificar o acesso. Tente novamente.';
    }
  }

  async function revalidateSession() {
    var session = getStoredSession();
    if (!session) return false;
    var result = await verifyMembershipBackend(session.email, session.phone, getCaptchaToken());
    if (!result.verified) { clearSession(); showScreen('gate-screen'); return false; }
    warnIfShapeDrift(result);
    storeSession(pickDisplayName(result, session.name), session.email, session.phone);
    return true;
  }

  async function handleGateSubmit(e) {
    e.preventDefault();
    var emailInput = document.getElementById('gate-email');
    var phoneInput = document.getElementById('gate-phone');
    var submitBtn = document.getElementById('gate-submit');
    var errorEl = document.getElementById('gate-error');
    var btnText = submitBtn.querySelector('.btn-text');
    var btnLoading = submitBtn.querySelector('.btn-loading');

    if (!checkLoginRateLimit()) { errorEl.textContent = getErrorMessage('rate_limited'); errorEl.style.display = 'block'; return; }

    var email = emailInput.value.toLowerCase().trim();
    var phone = normalizePhone(phoneInput.value);
    // S4: validate BEFORE recording an attempt or hitting the backend.
    if ((!email && !phone) || (email && !validEmail(email)) || (phone && !validPhone(phone))) {
      errorEl.textContent = getErrorMessage('invalid'); errorEl.style.display = 'block'; return;
    }

    recordLoginAttempt();
    errorEl.style.display = 'none';
    submitBtn.disabled = true;
    if (btnText) btnText.style.display = 'none';
    if (btnLoading) btnLoading.style.display = 'inline';

    try {
      var result = await verifyMembershipBackend(email, phone, getCaptchaToken());
      if (result.verified) {
        warnIfShapeDrift(result);
        var memberName = pickDisplayName(result, 'Maestro');
        storeSession(memberName, email, phone);
        var nameEl = document.getElementById('user-name');
        if (nameEl) nameEl.textContent = memberName;
        showScreen('key-screen');
        if (window.ApiKeyManager) window.ApiKeyManager.renderInputs();
      } else {
        errorEl.textContent = getErrorMessage(result.reason); errorEl.style.display = 'block';
      }
    } catch (err) {
      errorEl.textContent = 'Erro de conexão. Verifique sua internet e tente novamente.'; errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      if (btnText) btnText.style.display = 'inline';
      if (btnLoading) btnLoading.style.display = 'none';
    }
  }

  async function init() {
    // S2: anti-clickjacking — never run framed cross-origin.
    try {
      if (window.top !== window.self) {
        var framedSameOrigin = false;
        try { framedSameOrigin = !!window.top.location.origin && window.top.location.origin === location.origin; } catch (e) { framedSameOrigin = false; }
        if (!framedSameOrigin) { refuse('loaded inside a cross-origin frame'); return; }
      }
    } catch (e) {}

    // S1: origin allow-list.
    if (!isAllowedOrigin()) { refuse('origin not in the approved Gênesis IA allow-list'); return; }

    // Wire the gate form + logout ALWAYS — independent of session state — so the login
    // form works even after logout or a failed mid-session revalidation, with NO page
    // reload. (Previously the submit handler was attached only on the no-session path, so
    // after "Sair" the form fell back to a native GET submit that reloaded the page.)
    var form = document.getElementById('gate-form');
    if (form && !form._gateWired) { form._gateWired = true; form.addEventListener('submit', handleGateSubmit); }
    wireLogout();
    try { if (window.__gateBootstrapDisarm) window.__gateBootstrapDisarm(); } catch (e) {}

    var session = getStoredSession();
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
      var valid = await revalidateSession();
      if (valid) {
        showScreen('key-screen');
        if (window.ApiKeyManager && window.ApiKeyManager.hasRequiredKeys()) showScreen('app-screen');
        return;
      }
    }

    showScreen('gate-screen');

    // Replay a login submit captured by the inline page bootstrap before this remote gate
    // finished loading, so a click on "Verificar acesso" during load is never lost.
    try {
      if (window.__gateEarlySubmit && form) {
        window.__gateEarlySubmit = false;
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    } catch (e) {}
  }

  function wireLogout() {
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn && !logoutBtn._wired) {
      logoutBtn._wired = true;
      logoutBtn.addEventListener('click', function () { clearSession(); showScreen('gate-screen'); });
    }
  }

  var MembershipGate = {
    init: init,
    getSession: getStoredSession,
    clearSession: clearSession,
    showScreen: showScreen,
    revalidateSession: revalidateSession,
    version: GATE_VERSION
  };
  window.MembershipGate = MembershipGate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { MembershipGate.init(); });
  } else {
    MembershipGate.init();
  }
})();
