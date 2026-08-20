/**
 * Faturas IA — Main Application Logic
 *
 * Invoice / receipt / quote builder with live Art Deco preview, PDF export via
 * window.print(), and an optional BYOK AI assistant (writes professional pt-BR
 * service descriptions + payment terms). All AI calls use the END-USER's own key
 * (Hard Rule #1 BYOK) and run through OpenRouter (or native OpenAI). There is NO
 * Supabase client in the browser; nothing here persists to a backend.
 */

const App = (function() {
  var STORAGE_KEY = 'faturas-ia_draft_v1';

  var DOC_LABELS = {
    fatura:    { badge: 'Fatura',    party: 'Faturar para', foot: 'Documento gerado com Faturas IA — Gênesis IA' },
    recibo:    { badge: 'Recibo',    party: 'Recebido de',  foot: 'Recibo gerado com Faturas IA — Gênesis IA' },
    orcamento: { badge: 'Orçamento', party: 'Orçamento para', foot: 'Orçamento gerado com Faturas IA — Gênesis IA' }
  };

  var CURRENCY = {
    BRL: { locale: 'pt-BR', code: 'BRL' },
    USD: { locale: 'en-US', code: 'USD' },
    EUR: { locale: 'de-DE', code: 'EUR' }
  };

  var state = defaultState();

  function defaultState() {
    return {
      type: 'fatura',
      issuerName: '', issuerDoc: '', issuerPhone: '', issuerEmail: '', issuerAddress: '',
      clientName: '', clientDoc: '', clientEmail: '', clientAddress: '',
      number: '0001', currency: 'BRL', date: todayISO(), due: '',
      items: [ { desc: '', qty: 1, price: 0 } ],
      discount: 0, discountType: 'value', tax: 0,
      payment: '', notes: ''
    };
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // ---------- persistence ----------
  function saveDraft() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = Object.assign(defaultState(), parsed);
        if (!Array.isArray(state.items) || state.items.length === 0) state.items = [{ desc: '', qty: 1, price: 0 }];
      }
    } catch (e) {}
  }

  // ---------- numbers ----------
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function fmt(value) {
    var c = CURRENCY[state.currency] || CURRENCY.BRL;
    try {
      return new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.code }).format(value || 0);
    } catch (e) {
      return (value || 0).toFixed(2);
    }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function computeTotals() {
    var subtotal = state.items.reduce(function(s, it) { return s + num(it.qty) * num(it.price); }, 0);
    var discount = state.discountType === 'percent'
      ? subtotal * (num(state.discount) / 100)
      : num(state.discount);
    if (discount > subtotal) discount = subtotal;
    var taxable = subtotal - discount;
    var tax = taxable * (num(state.tax) / 100);
    var total = taxable + tax;
    return { subtotal: subtotal, discount: discount, tax: tax, total: total };
  }

  // ---------- escaping ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '✦';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ---------- editor: items ----------
  function renderItems() {
    var list = document.getElementById('items-list');
    if (!list) return;
    list.innerHTML = '';
    state.items.forEach(function(it, i) {
      var row = document.createElement('div');
      row.className = 'item-row';
      var lineTotal = num(it.qty) * num(it.price);
      row.innerHTML =
        '<div class="desc-cell"><input type="text" data-i="' + i + '" data-k="desc" placeholder="Descrição do serviço ou produto" value="' + esc(it.desc) + '"></div>' +
        '<input type="number" data-i="' + i + '" data-k="qty" min="0" step="1" value="' + esc(it.qty) + '">' +
        '<input type="number" data-i="' + i + '" data-k="price" min="0" step="0.01" value="' + esc(it.price) + '">' +
        '<div class="line-total">' + fmt(lineTotal) + '</div>' +
        '<button type="button" class="row-del" data-del="' + i + '" aria-label="Remover item">&times;</button>';
      list.appendChild(row);
    });

    list.querySelectorAll('input').forEach(function(inp) {
      inp.addEventListener('input', function() {
        var i = +inp.dataset.i, k = inp.dataset.k;
        state.items[i][k] = (k === 'desc') ? inp.value : num(inp.value);
        saveDraft();
        // update only the line total + preview, keep input focus
        var row = inp.closest('.item-row');
        if (row) row.querySelector('.line-total').textContent = fmt(num(state.items[i].qty) * num(state.items[i].price));
        renderPreview();
      });
    });
    list.querySelectorAll('.row-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var i = +btn.dataset.del;
        state.items.splice(i, 1);
        if (state.items.length === 0) state.items.push({ desc: '', qty: 1, price: 0 });
        saveDraft(); renderItems(); renderPreview();
      });
    });
  }

  // ---------- editor: bindings ----------
  function bindFields() {
    document.querySelectorAll('[data-bind]').forEach(function(el) {
      var key = el.getAttribute('data-bind');
      if (key in state) el.value = state[key];
      el.addEventListener('input', function() {
        state[key] = el.value;
        saveDraft();
        renderPreview();
      });
    });

    // document-type toggle
    document.querySelectorAll('#doc-type button').forEach(function(b) {
      b.classList.toggle('active', b.dataset.type === state.type);
      b.addEventListener('click', function() {
        state.type = b.dataset.type;
        document.querySelectorAll('#doc-type button').forEach(function(x) { x.classList.toggle('active', x === b); });
        saveDraft(); renderPreview();
      });
    });

    var addBtn = document.getElementById('add-item');
    if (addBtn) addBtn.addEventListener('click', function() {
      state.items.push({ desc: '', qty: 1, price: 0 });
      saveDraft(); renderItems(); renderPreview();
    });

    var printBtn = document.getElementById('print-btn');
    if (printBtn) printBtn.addEventListener('click', function() { window.print(); });

    var resetBtn = document.getElementById('reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', function() {
      if (!confirm('Limpar todos os campos e começar um novo documento?')) return;
      state = defaultState();
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      syncFieldsFromState();
      renderItems(); renderPreview();
    });
  }

  function syncFieldsFromState() {
    document.querySelectorAll('[data-bind]').forEach(function(el) {
      var key = el.getAttribute('data-bind');
      if (key in state) el.value = state[key];
    });
    document.querySelectorAll('#doc-type button').forEach(function(b) {
      b.classList.toggle('active', b.dataset.type === state.type);
    });
  }

  // ---------- preview ----------
  function renderPreview() {
    var host = document.getElementById('doc-inner');
    if (!host) return;
    var t = computeTotals();
    var L = DOC_LABELS[state.type] || DOC_LABELS.fatura;

    var issuerMeta = [state.issuerDoc, state.issuerPhone, state.issuerEmail, state.issuerAddress]
      .filter(Boolean).map(esc).join('\n');

    var clientLines = [
      state.clientName ? '<strong>' + esc(state.clientName) + '</strong>' : '<span class="muted">Nome do cliente</span>',
      esc(state.clientDoc), esc(state.clientEmail), esc(state.clientAddress)
    ].filter(function(x) { return x && x !== ''; }).join('<br>');

    var metaRows = [];
    if (state.number) metaRows.push('Nº ' + esc(state.number));
    if (state.date) metaRows.push('Emissão: ' + fmtDate(state.date));
    if (state.due) metaRows.push((state.type === 'orcamento' ? 'Válido até: ' : 'Vencimento: ') + fmtDate(state.due));

    var rowsHtml = state.items.filter(function(it) { return it.desc || num(it.qty) || num(it.price); }).map(function(it) {
      return '<tr>' +
        '<td class="desc">' + (esc(it.desc) || '<span style="color:#aaa">—</span>') + '</td>' +
        '<td class="num">' + esc(it.qty) + '</td>' +
        '<td class="num">' + fmt(num(it.price)) + '</td>' +
        '<td class="num">' + fmt(num(it.qty) * num(it.price)) + '</td>' +
      '</tr>';
    }).join('');
    if (!rowsHtml) rowsHtml = '<tr><td class="desc" colspan="4" style="color:#aaa;text-align:center;padding:18px;">Adicione itens para vê-los aqui</td></tr>';

    var totalsHtml = '<div class="row"><span>Subtotal</span><span>' + fmt(t.subtotal) + '</span></div>';
    if (t.discount > 0) totalsHtml += '<div class="row"><span>Desconto</span><span>− ' + fmt(t.discount) + '</span></div>';
    if (t.tax > 0) totalsHtml += '<div class="row"><span>Imposto / taxa (' + esc(state.tax) + '%)</span><span>' + fmt(t.tax) + '</span></div>';
    totalsHtml += '<div class="row grand"><span>Total</span><span>' + fmt(t.total) + '</span></div>';

    host.innerHTML =
      '<div class="doc-head">' +
        '<div class="doc-monogram"><span>' + esc(initials(state.issuerName)) + '</span></div>' +
        '<div class="doc-issuer-name">' + (esc(state.issuerName) || 'Seu Nome / Empresa') + '</div>' +
        (issuerMeta ? '<div class="doc-issuer-meta">' + issuerMeta + '</div>' : '') +
        '<div class="doc-type-badge">' + esc(L.badge) + '</div>' +
      '</div>' +

      '<div class="doc-meta-grid">' +
        '<div class="doc-block"><h5>' + esc(L.party) + '</h5><p>' + (clientLines || '<span class="muted">—</span>') + '</p></div>' +
        '<div class="doc-block"><h5>Detalhes</h5><p>' + (metaRows.length ? metaRows.map(esc).join('<br>') : '<span class="muted">—</span>') + '</p></div>' +
      '</div>' +

      '<table class="doc-table">' +
        '<thead><tr><th>Descrição</th><th class="num">Qtd</th><th class="num">Valor unit.</th><th class="num">Total</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +

      '<div class="doc-totals">' + totalsHtml + '</div>' +

      (state.payment ? '<div class="doc-pay"><h5>Pagamento</h5><p>' + esc(state.payment) + '</p></div>' : '') +
      (state.notes ? '<div class="doc-pay"><h5>Observações</h5><p>' + esc(state.notes) + '</p></div>' : '') +

      '<div class="doc-foot">' + esc(L.foot) + '</div>';
  }

  // ============================================================
  // AI assistant (BYOK — user's own key, routed via OpenRouter/OpenAI)
  // ============================================================
  function endpointFor(service) {
    if (service === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
  }
  function modelFor(service) {
    if (service === 'openrouter') return (window.ApiKeyManager ? ApiKeyManager.getModel() : 'google/gemini-2.5-flash');
    return 'gpt-4o-mini';
  }

  function aiSystemPrompt() {
    return [
      'Você é um redator comercial brasileiro especializado em documentos de cobrança (faturas, recibos e orçamentos).',
      'A partir de uma descrição informal do serviço, você escreve textos profissionais, claros e prontos para um documento financeiro, em português do Brasil.',
      '',
      'Regras OBRIGATÓRIAS:',
      '1. NÃO INVENTE valores, preços, datas ou dados que não foram informados. O texto descreve o serviço — nunca cite números que o usuário não deu.',
      '2. A "description" é uma linha de item de fatura: objetiva, profissional, 1 frase (máx ~140 caracteres).',
      '3. "payment_terms" são condições de pagamento padrão e profissionais (ex: prazo, forma de pagamento, multa por atraso) — genéricas, sem inventar chaves PIX ou contas.',
      '4. "notes" é uma observação curta e cordial (garantia, agradecimento ou validade).',
      '5. Gramática e pontuação impecáveis.',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes/depois, sem cercas markdown):',
      '{ "description": "...", "payment_terms": "...", "notes": "..." }'
    ].join('\n');
  }

  async function doAICall(activeKey, brief) {
    var body = {
      model: modelFor(activeKey.service),
      messages: [
        { role: 'system', content: aiSystemPrompt() },
        { role: 'user', content: 'Tipo de documento: ' + (DOC_LABELS[state.type] || DOC_LABELS.fatura).badge + '.\nServiço prestado: ' + brief }
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' }
    };
    var headers = { 'Authorization': 'Bearer ' + activeKey.key, 'Content-Type': 'application/json' };
    if (activeKey.service === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'Faturas IA - Gênesis IA';
    }
    var resp = await fetch(endpointFor(activeKey.service), { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var errText = ''; try { errText = await resp.text(); } catch (e) {}
      var msg = 'Falha na API (' + resp.status + ').';
      try { var p = JSON.parse(errText); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
      throw new Error(msg);
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!content) throw new Error('Resposta vazia da API.');
    var cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error('A IA retornou um formato inválido. Tente novamente.'); }
  }

  function setupAI() {
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    var genBtn = document.getElementById('ai-generate');
    var statusEl = document.getElementById('ai-status');
    var out = document.getElementById('ai-out');
    if (!genBtn) return;

    var last = { description: '', payment_terms: '', notes: '' };

    genBtn.addEventListener('click', async function() {
      var brief = (document.getElementById('ai-brief').value || '').trim();
      if (!brief) { showStatus('Descreva o serviço primeiro.', 'err'); return; }

      var active = window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null;
      if (!active) { showStatus('Configure sua chave de API (botão da chave no topo) para usar o assistente.', 'err'); return; }

      genBtn.disabled = true;
      showStatus('Gerando com IA...', 'info');
      try {
        var result = await RateLimiter.executeWithLimit('ai-assist', function() { return doAICall(active, brief); });
        if (!result) { showStatus('Limite de uso atingido. Aguarde um instante.', 'err'); genBtn.disabled = false; return; }
        last = {
          description: result.description || '',
          payment_terms: result.payment_terms || '',
          notes: result.notes || ''
        };
        document.getElementById('ai-desc').textContent = last.description || '—';
        document.getElementById('ai-terms').textContent = last.payment_terms || '—';
        document.getElementById('ai-notes').textContent = last.notes || '—';
        if (out) out.classList.add('active');
        showStatus('Pronto! Use os botões abaixo para inserir no documento.', 'ok');
      } catch (e) {
        showStatus(e.message || 'Erro ao gerar.', 'err');
      } finally {
        genBtn.disabled = false;
      }
    });

    document.getElementById('ai-use-desc').addEventListener('click', function() {
      if (!last.description) return;
      var empty = state.items.find(function(it) { return !it.desc; });
      if (empty) { empty.desc = last.description; }
      else { state.items.push({ desc: last.description, qty: 1, price: 0 }); }
      saveDraft(); renderItems(); renderPreview();
      showStatus('Descrição adicionada aos itens.', 'ok');
    });
    document.getElementById('ai-use-terms').addEventListener('click', function() {
      if (!last.payment_terms) return;
      state.payment = state.payment ? (state.payment + '\n' + last.payment_terms) : last.payment_terms;
      var el = document.querySelector('[data-bind="payment"]'); if (el) el.value = state.payment;
      saveDraft(); renderPreview();
      showStatus('Termos inseridos em Pagamento.', 'ok');
    });
    document.getElementById('ai-use-notes').addEventListener('click', function() {
      if (!last.notes) return;
      state.notes = last.notes;
      var el = document.querySelector('[data-bind="notes"]'); if (el) el.value = state.notes;
      saveDraft(); renderPreview();
      showStatus('Observação inserida.', 'ok');
    });

    function showStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = kind === 'err' ? 'var(--danger)' : (kind === 'ok' ? 'var(--good)' : 'var(--ivory-3)');
    }
  }

  // ---------- init ----------
  function init() {
    var session = MembershipGate.getSession();
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
      // Pre-fill issuer name from member name if empty
      if (!state.issuerName && session.name) {
        state.issuerName = session.name;
        var el = document.querySelector('[data-bind="issuerName"]');
        if (el) el.value = state.issuerName;
      }
    }
    bindFields();
    renderItems();
    renderPreview();
    setupAI();
  }

  return { init: init, _load: loadDraft };
})();

App._load();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = MembershipGate.getSession();
    if (session) {
      _appInitialized = true;
      App.init();
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(tryAppInit, 150);
  });
})();
