/**
 * Feedback Widget — floating button with bug report / feature request modal.
 * Submissions POST to the n8n /feedback webhook, which verifies membership
 * server-side and notifies the owner on WhatsApp. No Supabase in the browser.
 */
const FeedbackWidget = (function() {
  const TOOL_SLUG = 'faturas-ia';

  function getMemberEmail() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    return session ? session.email : null;
  }

  function createWidget() {
    var btn = document.createElement('button');
    btn.id = 'feedback-btn';
    btn.setAttribute('aria-label', 'Enviar feedback');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Feedback';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;align-items:center;gap:6px;padding:10px 18px;background:linear-gradient(180deg,#e7ca7e,#c8a24a);color:#0c1320;border:1px solid #9a7b32;border-radius:2px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(200,162,74,.28);transition:transform .2s,box-shadow .2s;';
    btn.addEventListener('mouseenter', function() { btn.style.transform = 'scale(1.05)'; });
    btn.addEventListener('mouseleave', function() { btn.style.transform = 'scale(1)'; });
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
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;';

    modal.innerHTML =
      '<div id="feedback-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);"></div>' +
      '<div style="position:relative;background:linear-gradient(180deg,#18263d,#131f33);border:1px solid rgba(200,162,74,.34);border-radius:2px;padding:28px;width:90%;max-width:440px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
          '<h3 style="font-family:Cormorant Garamond,Garamond,serif;font-size:22px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:#f4efe3;">Enviar Feedback</h3>' +
          '<button id="feedback-close" style="background:none;border:1px solid rgba(200,162,74,.34);border-radius:2px;color:#d6cdb8;padding:6px 10px;cursor:pointer;font-size:16px;">&times;</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
          '<button class="fb-type-btn" data-type="bug" style="flex:1;padding:10px;background:rgba(207,101,82,.1);border:1px solid rgba(207,101,82,.25);border-radius:2px;color:#cf6552;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">🐛 Bug</button>' +
          '<button class="fb-type-btn active" data-type="feature" style="flex:1;padding:10px;background:rgba(200,162,74,.14);border:1px solid rgba(200,162,74,.4);border-radius:2px;color:#e7ca7e;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">💡 Sugestão</button>' +
        '</div>' +
        '<textarea id="feedback-text" placeholder="Descreva o bug ou sua sugestão..." style="width:100%;min-height:120px;padding:14px;background:#0a111e;border:1px solid rgba(244,239,227,.1);border-radius:2px;color:#f4efe3;font-size:14px;font-family:inherit;resize:vertical;outline:none;"></textarea>' +
        '<button id="feedback-send" style="width:100%;margin-top:12px;padding:14px;background:linear-gradient(180deg,#e7ca7e,#c8a24a);color:#0c1320;border:1px solid #9a7b32;border-radius:2px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;cursor:pointer;font-family:inherit;">' +
          '<span class="fb-btn-text">Enviar</span>' +
          '<span class="fb-btn-loading" style="display:none;">Enviando...</span>' +
        '</button>' +
        '<p id="feedback-status" style="text-align:center;font-size:13px;margin-top:10px;display:none;"></p>' +
      '</div>';

    document.body.appendChild(modal);

    var selectedType = 'feature';

    modal.querySelectorAll('.fb-type-btn').forEach(function(b) {
      b.addEventListener('click', function() {
        modal.querySelectorAll('.fb-type-btn').forEach(function(x) {
          x.style.background = x.dataset.type === 'bug' ? 'rgba(207,101,82,.05)' : 'rgba(200,162,74,.05)';
          x.style.borderColor = 'rgba(244,239,227,.1)';
        });
        b.style.background = b.dataset.type === 'bug' ? 'rgba(207,101,82,.1)' : 'rgba(200,162,74,.14)';
        b.style.borderColor = b.dataset.type === 'bug' ? 'rgba(207,101,82,.25)' : 'rgba(200,162,74,.4)';
        selectedType = b.dataset.type;
      });
    });

    document.getElementById('feedback-overlay').addEventListener('click', closeModal);
    document.getElementById('feedback-close').addEventListener('click', closeModal);

    document.getElementById('feedback-send').addEventListener('click', async function() {
      var text = document.getElementById('feedback-text').value.trim();
      var statusEl = document.getElementById('feedback-status');
      var sendBtn = document.getElementById('feedback-send');

      if (!text) {
        statusEl.style.display = 'block';
        statusEl.style.color = '#ef4444';
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
        try { result = await resp.json(); } catch {}

        if (result.success) {
          statusEl.style.color = '#10b981';
          statusEl.textContent = result.message || 'Feedback enviado! Obrigado.';
          document.getElementById('feedback-text').value = '';
          setTimeout(closeModal, 2000);
        } else {
          statusEl.style.color = '#ef4444';
          statusEl.textContent = result.error || 'Erro ao enviar. Tente novamente.';
        }
      } catch {
        statusEl.style.color = '#ef4444';
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
      var observer = new MutationObserver(function() {
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

document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() { FeedbackWidget.init(); }, 300);
});
