/**
 * Feedback Widget — floating button with bug report / feature request modal.
 * Submissions POST to the n8n /feedback webhook, which verifies membership
 * server-side and notifies the owner on WhatsApp. No Supabase in the browser.
 * Themed to Billboard Spectacular (signal red + ink + safety yellow on paper).
 */
const FeedbackWidget = (function () {
  const TOOL_SLUG = 'anuncios-ia';

  function getMemberEmail() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    return session ? session.email : null;
  }

  function createWidget() {
    if (document.getElementById('feedback-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'feedback-btn';
    btn.setAttribute('aria-label', 'Enviar feedback');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Feedback';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;align-items:center;gap:6px;padding:11px 18px;background:#e5341f;color:#fff;border:2px solid #141210;border-radius:100px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;font-family:inherit;cursor:pointer;box-shadow:3px 3px 0 #141210;transition:transform .12s;';
    btn.addEventListener('mouseenter', function () { btn.style.transform = 'translateY(-2px)'; });
    btn.addEventListener('mouseleave', function () { btn.style.transform = 'translateY(0)'; });
    btn.addEventListener('click', showModal);
    document.body.appendChild(btn);
  }

  function showModal() {
    if (document.getElementById('feedback-modal')) {
      document.getElementById('feedback-modal').style.display = 'flex';
      return;
    }

    var modal = document.createElement('div');
    modal.id = 'feedback-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';

    modal.innerHTML =
      '<div id="feedback-overlay" style="position:absolute;inset:0;background:rgba(20,18,16,.55);"></div>' +
      '<div style="position:relative;background:#f4f1ea;border:3px solid #141210;border-radius:5px;padding:28px;width:100%;max-width:440px;box-shadow:10px 10px 0 rgba(20,18,16,.2);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
          '<h3 style="font-family:Impact,\'Arial Narrow Bold\',\'Helvetica Neue\',sans-serif;text-transform:uppercase;letter-spacing:.02em;font-size:24px;color:#141210;">Enviar Feedback</h3>' +
          '<button id="feedback-close" style="background:#fff;border:2px solid #141210;border-radius:4px;color:#141210;padding:4px 11px;cursor:pointer;font-size:18px;line-height:1;">&times;</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
          '<button class="fb-type-btn" data-type="bug" style="flex:1;padding:11px;background:#fff;border:2px solid #141210;border-radius:4px;color:#141210;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;text-transform:uppercase;">🐛 Bug</button>' +
          '<button class="fb-type-btn active" data-type="feature" style="flex:1;padding:11px;background:#ffd400;border:2px solid #141210;border-radius:4px;color:#141210;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;text-transform:uppercase;">💡 Sugestão</button>' +
        '</div>' +
        '<textarea id="feedback-text" placeholder="Descreva o bug ou sua sugestão..." style="width:100%;min-height:120px;padding:14px;background:#fff;border:2px solid #141210;border-radius:4px;color:#141210;font-size:14px;font-family:inherit;resize:vertical;outline:none;"></textarea>' +
        '<button id="feedback-send" style="width:100%;margin-top:14px;padding:14px;background:#e5341f;color:#fff;border:2px solid #141210;border-radius:4px;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;font-family:inherit;box-shadow:3px 3px 0 #141210;">' +
          '<span class="fb-btn-text">Enviar</span>' +
          '<span class="fb-btn-loading" style="display:none;">Enviando...</span>' +
        '</button>' +
        '<p id="feedback-status" style="text-align:center;font-size:13px;margin-top:10px;display:none;font-weight:600;"></p>' +
      '</div>';

    document.body.appendChild(modal);

    var selectedType = 'feature';

    modal.querySelectorAll('.fb-type-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        modal.querySelectorAll('.fb-type-btn').forEach(function (x) { x.style.background = '#fff'; });
        b.style.background = b.dataset.type === 'bug' ? '#ffd9d3' : '#ffd400';
        selectedType = b.dataset.type;
      });
    });

    document.getElementById('feedback-overlay').addEventListener('click', closeModal);
    document.getElementById('feedback-close').addEventListener('click', closeModal);

    document.getElementById('feedback-send').addEventListener('click', async function () {
      var text = document.getElementById('feedback-text').value.trim();
      var statusEl = document.getElementById('feedback-status');
      var sendBtn = document.getElementById('feedback-send');

      if (!text) {
        statusEl.style.display = 'block';
        statusEl.style.color = '#c1240f';
        statusEl.textContent = 'Por favor, escreva sua mensagem.';
        return;
      }

      sendBtn.disabled = true;
      sendBtn.querySelector('.fb-btn-text').style.display = 'none';
      sendBtn.querySelector('.fb-btn-loading').style.display = 'inline';

      try {
        var base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
        var resp = await fetch(base + '/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_slug: TOOL_SLUG,
            member_email: getMemberEmail(),
            type: selectedType,
            message: text
          })
        });

        var result = {};
        try { result = await resp.json(); } catch (e) {}

        if (result.success) {
          statusEl.style.color = '#1f7a3f';
          statusEl.textContent = result.message || 'Feedback enviado! Obrigado.';
          document.getElementById('feedback-text').value = '';
          setTimeout(closeModal, 2000);
        } else {
          statusEl.style.color = '#c1240f';
          statusEl.textContent = result.error || 'Erro ao enviar. Tente novamente.';
        }
      } catch (e) {
        statusEl.style.color = '#c1240f';
        statusEl.textContent = 'Erro ao enviar. Tente novamente.';
      } finally {
        statusEl.style.display = 'block';
        sendBtn.disabled = false;
        sendBtn.querySelector('.fb-btn-text').style.display = 'inline';
        sendBtn.querySelector('.fb-btn-loading').style.display = 'none';
      }
    });
  }

  function closeModal() {
    var modal = document.getElementById('feedback-modal');
    if (modal) modal.style.display = 'none';
  }

  function init() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) {
      createWidget();
    } else {
      var observer = new MutationObserver(function () {
        if (document.getElementById('app-screen') &&
            document.getElementById('app-screen').classList.contains('active')) {
          createWidget();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }

  return { init: init };
})();

window.FeedbackWidget = FeedbackWidget;

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () { FeedbackWidget.init(); }, 300);
});
