/**
 * Análise de Concorrentes IA — Main Application Logic
 *
 * Flow: the member gives a competitor URL (read client-side via the keyless,
 * CORS-open r.jina.ai reader) OR pastes the page content; the content is sent
 * to the member's OWN AI key (BYOK — OpenAI / OpenRouter) which returns a
 * structured competitive analysis in pt-BR, rendered as a Swiss ruled ledger.
 *
 * No backend of ours is involved in the analysis. Membership/feedback/deletion
 * go through n8n (standard modules). The AI call goes straight to the provider
 * with the user's key, which never leaves the browser.
 */

const App = (function() {
  var _wired = false;
  var _lastResult = null;     // parsed analysis object
  var _lastMeta = null;       // { source, label }

  var MAX_CONTENT_CHARS = 14000;

  // ---- COR-015: LLM "optional" fields can come back as the literal string "null" ----
  function cleanField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    var low = s.toLowerCase();
    if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' ||
        low === '-' || low === '—' || low === '') return '';
    return s;
  }
  function cleanList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(cleanField).filter(function(x) { return x !== ''; });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function setStatus(html) {
    var el = $('analyze-status');
    if (!el) return;
    if (html) { el.innerHTML = html; el.classList.add('active'); }
    else { el.innerHTML = ''; el.classList.remove('active'); }
  }
  function showError(msg) {
    var el = $('analyze-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }
  function setLoading(on) {
    var btn = $('analyze-btn');
    if (!btn) return;
    btn.disabled = on;
    btn.querySelector('.btn-text').style.display = on ? 'none' : 'inline';
    btn.querySelector('.btn-loading').style.display = on ? 'inline' : 'none';
  }

  function currentMode() {
    var t = document.querySelector('.mode-tab[aria-selected="true"]');
    return t ? t.getAttribute('data-mode') : 'url';
  }

  function switchMode(mode) {
    document.querySelectorAll('.mode-tab').forEach(function(t) {
      t.setAttribute('aria-selected', t.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    document.querySelectorAll('.mode-panel').forEach(function(p) { p.classList.remove('active'); });
    var panel = $('panel-' + mode);
    if (panel) panel.classList.add('active');
  }

  // ---- fetch the competitor page via r.jina.ai (keyless, CORS-open reader) ----
  async function fetchPageText(rawUrl) {
    var url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    var readerUrl = 'https://r.jina.ai/' + url;
    var resp = await fetch(readerUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' }
    });
    if (!resp.ok) {
      throw new Error('reader_' + resp.status);
    }
    var text = await resp.text();
    return { text: text, finalUrl: url };
  }

  // ---- BYOK AI call (OpenAI-compatible chat completions) ----
  async function callAI(active, depth, pageText, myContext, sourceLabel) {
    var model, endpoint, headers = { 'Content-Type': 'application/json' };

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Analise de Concorrentes IA';
      model = depth === 'deep' ? 'openai/gpt-4o' : 'openai/gpt-4o-mini';
    } else { // openai
      endpoint = 'https://api.openai.com/v1/chat/completions';
      headers['Authorization'] = 'Bearer ' + active.key;
      model = depth === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    }

    var sys = [
      'Você é um analista de inteligência competitiva sênior, em português do Brasil.',
      'Recebe o conteúdo do site/página de um CONCORRENTE e produz um dossiê competitivo objetivo e acionável.',
      'Regras: baseie-se SOMENTE no conteúdo fornecido e em inferências razoáveis; NUNCA invente preços, números ou fatos.',
      'Quando uma informação (ex.: preço) não estiver explícita, retorne o campo como string vazia "" — não escreva "null" nem invente.',
      'Seja específico e concreto; evite generalidades de consultor. Responda ESTRITAMENTE em JSON válido no schema pedido.'
    ].join(' ');

    var schema = [
      'Schema JSON (todas as chaves obrigatórias; listas podem ser vazias):',
      '{',
      '  "empresa": "nome/identificação do concorrente inferido do conteúdo",',
      '  "resumo": "1-2 frases: o que é e o que vende",',
      '  "proposta_valor": "a promessa central / proposta de valor",',
      '  "publico_alvo": "para quem é (perfil de cliente)",',
      '  "posicionamento": "como se posiciona no mercado (preço, autoridade, nicho, etc.)",',
      '  "ofertas": [ { "nome": "produto/plano", "preco": "preço se explícito, senão \\"\\"", "detalhe": "o que inclui" } ],',
      '  "forcas": ["pontos fortes concretos"],',
      '  "fraquezas": ["pontos fracos / lacunas visíveis"],',
      '  "oportunidades": ["brechas que VOCÊ pode explorar para ganhar deste concorrente"],',
      '  "diferenciacao": ["ângulos concretos de diferenciação / posicionamento contra ele"],',
      '  "proximos_passos": ["ações práticas e imediatas"]',
      '}'
    ].join('\n');

    var userParts = [];
    if (myContext) userParts.push('MEU NEGÓCIO/CONTEXTO (use para deixar oportunidades e diferenciação sob medida): ' + myContext);
    userParts.push('FONTE: ' + sourceLabel);
    userParts.push('CONTEÚDO DO CONCORRENTE:\n"""\n' + pageText.slice(0, MAX_CONTENT_CHARS) + '\n"""');
    userParts.push(schema);

    var body = {
      model: model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userParts.join('\n\n') }
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' }
    };

    var resp = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var detail = '';
      try { var ej = await resp.json(); detail = (ej.error && ej.error.message) || ''; } catch (e) {}
      var err = new Error('ai_' + resp.status);
      err.detail = detail;
      err.httpStatus = resp.status;
      throw err;
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('ai_empty');
    var parsed;
    try { parsed = JSON.parse(content); }
    catch (e) {
      var m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('ai_parse');
      parsed = JSON.parse(m[0]);
    }
    return parsed;
  }

  // ---- main action ----
  async function analyze() {
    showError('');
    var mode = currentMode();
    var depth = $('model-select') ? $('model-select').value : 'balanced';
    var myContext = cleanField($('my-context') ? $('my-context').value : '');

    var active = window.ApiKeyManager ? window.ApiKeyManager.getActiveKey() : null;
    if (!active) {
      showError('Configure sua chave de API (OpenAI ou OpenRouter) no ícone de chave no topo para analisar.');
      return;
    }

    var pageText = '';
    var sourceLabel = '';

    setLoading(true);

    try {
      if (mode === 'url') {
        var url = ($('comp-url') ? $('comp-url').value : '').trim();
        if (!url) { showError('Informe a URL do concorrente.'); setLoading(false); return; }
        setStatus('Lendo a página do concorrente<span class="blink">_</span>');
        try {
          var fetched = await fetchPageText(url);
          pageText = (fetched.text || '').trim();
          sourceLabel = fetched.finalUrl;
        } catch (e) {
          setLoading(false); setStatus('');
          showError('Não consegui ler essa página automaticamente. Abra o site, copie o texto e use a aba “Colar conteúdo”.');
          return;
        }
        if (pageText.length < 200) {
          setLoading(false); setStatus('');
          showError('A página retornou pouco conteúdo legível. Use a aba “Colar conteúdo” e cole o texto manualmente.');
          return;
        }
      } else {
        pageText = ($('comp-content') ? $('comp-content').value : '').trim();
        sourceLabel = 'conteúdo colado manualmente';
        if (pageText.length < 80) { showError('Cole o conteúdo da página do concorrente (texto muito curto).'); setLoading(false); return; }
      }

      setStatus('A IA está montando o dossiê competitivo<span class="blink">_</span>');

      var run = function() { return callAI(active, depth, pageText, myContext, sourceLabel); };
      var result = window.RateLimiter
        ? await window.RateLimiter.executeWithLimit('analyze', run)
        : await run();

      _lastResult = result;
      _lastMeta = { source: sourceLabel };
      render(result, sourceLabel);
      setStatus('');
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setStatus('');
      handleAIError(err);
    }
  }

  function handleAIError(err) {
    var msg = String(err && err.message || '');
    if (err && err.isRateLimit) {
      showError('Você atingiu o limite de uso por minuto/hora. Aguarde um pouco e tente novamente.');
      return;
    }
    if (msg.indexOf('ai_401') === 0 || err.httpStatus === 401) {
      showError('Chave de API inválida ou sem permissão. Confira sua chave no ícone de chave no topo.');
      return;
    }
    if (msg.indexOf('ai_429') === 0 || err.httpStatus === 429) {
      showError('O provedor de IA recusou por excesso de requisições ou saldo insuficiente. Tente novamente em instantes.');
      return;
    }
    if (msg.indexOf('ai_') === 0) {
      showError('A IA retornou um erro' + (err.detail ? ': ' + err.detail : '') + '. Tente novamente.');
      return;
    }
    showError('Não foi possível concluir a análise. Verifique sua conexão e tente novamente.');
  }

  // ---- rendering: Swiss ruled ledger ----
  function listHtml(items, coordPrefix) {
    var arr = cleanList(items);
    if (!arr.length) return '<p class="empty-note">Sem dados suficientes na página para esta seção.</p>';
    return '<ul class="ruled-list">' + arr.map(function(it, i) {
      return '<li><span class="coord">' + coordPrefix + '.' + (i + 1) + '</span><span>' + esc(it) + '</span></li>';
    }).join('') + '</ul>';
  }

  function offersHtml(offers) {
    if (!Array.isArray(offers) || !offers.length) return '<p class="empty-note">Nenhuma oferta/preço explícito identificado na página.</p>';
    var rows = offers.map(function(o) {
      var nome = esc(cleanField(o && o.nome)) || '—';
      var preco = esc(cleanField(o && o.preco));
      var det = esc(cleanField(o && o.detalhe));
      return '<tr>' +
        '<td>' + nome + '</td>' +
        '<td class="price">' + (preco || '—') + '</td>' +
        '<td>' + (det || '') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="offers-table"><thead><tr><th>Oferta</th><th>Preço</th><th>Detalhe</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function section(num, title, innerHtml) {
    return '<div class="section">' +
      '<div class="section-num">' + num + '</div>' +
      '<div class="section-body"><h3>' + esc(title) + '</h3>' + innerHtml + '</div>' +
      '</div>';
  }

  function render(r, sourceLabel) {
    var empresa = cleanField(r.empresa) || 'Concorrente';
    var html = '';

    html += section('01', 'Identificação',
      '<p class="lede">' + esc(empresa) + '</p>' +
      (cleanField(r.resumo) ? '<p style="margin-top:var(--space-sm)">' + esc(r.resumo) + '</p>' : ''));

    html += section('02', 'Proposta de valor',
      cleanField(r.proposta_valor) ? '<p>' + esc(r.proposta_valor) + '</p>' : '<p class="empty-note">Não identificada com clareza.</p>');

    html += section('03', 'Público-alvo',
      cleanField(r.publico_alvo) ? '<p>' + esc(r.publico_alvo) + '</p>' : '<p class="empty-note">Não identificado com clareza.</p>');

    html += section('04', 'Posicionamento',
      cleanField(r.posicionamento) ? '<p>' + esc(r.posicionamento) + '</p>' : '<p class="empty-note">Não identificado com clareza.</p>');

    html += section('05', 'Ofertas & sinais de preço', offersHtml(r.ofertas));

    html += section('06', 'Forças & fraquezas',
      '<div class="split">' +
        '<div class="col"><h4>Forças</h4>' + listHtml(r.forcas, '06A') + '</div>' +
        '<div class="col is-accent"><h4>Fraquezas</h4>' + listHtml(r.fraquezas, '06B') + '</div>' +
      '</div>');

    html += section('07', 'Onde você ganha',
      '<div class="split">' +
        '<div class="col"><h4>Oportunidades</h4>' + listHtml(r.oportunidades, '07A') + '</div>' +
        '<div class="col is-accent"><h4>Diferenciação</h4>' + listHtml(r.diferenciacao, '07B') + '</div>' +
      '</div>');

    html += section('08', 'Próximos passos', listHtml(r.proximos_passos, '08'));

    $('result-body').innerHTML = html;
    var meta = $('result-meta');
    if (meta) meta.textContent = 'Dossiê — ' + empresa;
    var res = $('result');
    res.classList.add('active');
    res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- export (markdown) ----
  function toMarkdown(r, sourceLabel) {
    function bullets(arr) {
      var a = cleanList(arr);
      return a.length ? a.map(function(x) { return '- ' + x; }).join('\n') : '_sem dados_';
    }
    var lines = [];
    var empresa = cleanField(r.empresa) || 'Concorrente';
    lines.push('# Dossiê competitivo — ' + empresa);
    lines.push('');
    lines.push('> Fonte: ' + (sourceLabel || '') + '  ·  Gerado com Análise de Concorrentes IA (Gênesis IA)');
    lines.push('');
    lines.push('## 01 Identificação'); lines.push(empresa); if (cleanField(r.resumo)) lines.push('', cleanField(r.resumo));
    lines.push(''); lines.push('## 02 Proposta de valor'); lines.push(cleanField(r.proposta_valor) || '_não identificada_');
    lines.push(''); lines.push('## 03 Público-alvo'); lines.push(cleanField(r.publico_alvo) || '_não identificado_');
    lines.push(''); lines.push('## 04 Posicionamento'); lines.push(cleanField(r.posicionamento) || '_não identificado_');
    lines.push(''); lines.push('## 05 Ofertas & sinais de preço');
    if (Array.isArray(r.ofertas) && r.ofertas.length) {
      r.ofertas.forEach(function(o) {
        var nome = cleanField(o && o.nome) || '—';
        var preco = cleanField(o && o.preco);
        var det = cleanField(o && o.detalhe);
        lines.push('- **' + nome + '**' + (preco ? ' — ' + preco : '') + (det ? ': ' + det : ''));
      });
    } else { lines.push('_nenhuma oferta/preço explícito_'); }
    lines.push(''); lines.push('## 06 Forças'); lines.push(bullets(r.forcas));
    lines.push(''); lines.push('## 06 Fraquezas'); lines.push(bullets(r.fraquezas));
    lines.push(''); lines.push('## 07 Oportunidades'); lines.push(bullets(r.oportunidades));
    lines.push(''); lines.push('## 07 Diferenciação'); lines.push(bullets(r.diferenciacao));
    lines.push(''); lines.push('## 08 Próximos passos'); lines.push(bullets(r.proximos_passos));
    lines.push('');
    return lines.join('\n');
  }

  function copyResult() {
    if (!_lastResult) return;
    var md = toMarkdown(_lastResult, _lastMeta ? _lastMeta.source : '');
    navigator.clipboard.writeText(md).then(function() {
      var btn = $('copy-btn'); if (!btn) return;
      var old = btn.textContent; btn.textContent = 'Copiado!';
      setTimeout(function() { btn.textContent = old; }, 1600);
    });
  }

  function downloadResult() {
    if (!_lastResult) return;
    var md = toMarkdown(_lastResult, _lastMeta ? _lastMeta.source : '');
    var empresa = (cleanField(_lastResult.empresa) || 'concorrente').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'analise-' + (empresa || 'concorrente') + '.md';
    document.body.appendChild(a); a.click();
    setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function resetForm() {
    _lastResult = null; _lastMeta = null;
    $('result').classList.remove('active');
    $('result-body').innerHTML = '';
    if ($('comp-url')) $('comp-url').value = '';
    if ($('comp-content')) $('comp-content').value = '';
    showError(''); setStatus('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wire() {
    if (_wired) return;
    _wired = true;

    document.querySelectorAll('.mode-tab').forEach(function(t) {
      t.addEventListener('click', function() { switchMode(t.getAttribute('data-mode')); });
    });
    var ab = $('analyze-btn'); if (ab) ab.addEventListener('click', analyze);
    var cb = $('copy-btn'); if (cb) cb.addEventListener('click', copyResult);
    var db = $('download-btn'); if (db) db.addEventListener('click', downloadResult);
    var pb = $('print-btn'); if (pb) pb.addEventListener('click', function() { window.print(); });
    var rb = $('reset-btn'); if (rb) rb.addEventListener('click', resetForm);
  }

  function init() { wire(); }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
