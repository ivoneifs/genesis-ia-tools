/**
 * Tráfego IA — Main Application Logic
 * Planejador de mídia + projeção de resultados para tráfego pago.
 * A IA (BYOK) preenche benchmarks por nicho/plataforma e escreve o plano de campanha;
 * um motor determinístico client-side calcula a projeção em 3 cenários (edição → recálculo ao vivo).
 *
 * BYOK: toda geração roda na chave do próprio usuário (Hard Rule #1).
 * LLM plumbing: COR-032 (reroll) / COR-034-035 (reasoning/deepseek) / COR-015 (null-strings).
 */
(function () {
  'use strict';

  // ── scenarios (deterministic multipliers over the realista premissas) ──
  var SCENARIOS = [
    { key: 'conservador', name: 'Conservador', f: { cpm: 1.15, ctr: 0.70, cpg: 0.75, cvd: 0.80 } },
    { key: 'realista',    name: 'Realista',    f: { cpm: 1.00, ctr: 1.00, cpg: 1.00, cvd: 1.00 } },
    { key: 'otimista',    name: 'Otimista',    f: { cpm: 0.90, ctr: 1.30, cpg: 1.25, cvd: 1.20 } }
  ];

  var OBJ_LABELS = { vendas: 'Vendas diretas', leads: 'Geração de leads', agendamentos: 'Agendamentos' };
  var PLAT_LABELS = { meta: 'Meta Ads', google: 'Google Ads', tiktok: 'TikTok Ads' };
  // topo-do-funil label per objective (what a "click that converts on the page" becomes)
  var TOPO = {
    vendas:       { label: 'Vendas',       cpLabel: 'CPV (custo/venda)' },
    leads:        { label: 'Leads',        cpLabel: 'CPL (custo/lead)' },
    agendamentos: { label: 'Agendamentos', cpLabel: 'Custo/agendamento' }
  };

  var MAXTOK = 9000; // generous — reasoning + content must both fit (COR-034)

  // ── state ──
  var DATA = null;   // { brief, premissas:{cpm,ctr,conv_pagina,conv_venda}, plano:{...} }
  var busy = false;

  // ── tiny helpers ──
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(v) { // COR-015 — normalize LLM null-like strings to ''
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }
  var nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  function num(v, dflt) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : (dflt == null ? 0 : dflt); }
  function money(n, d) { if (!isFinite(n)) n = 0; return 'R$ ' + new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n); }
  function moneyAuto(n) { return money(n, Math.abs(n) < 100 ? 2 : 0); }
  function intf(n) { if (!isFinite(n)) n = 0; return nfInt.format(Math.round(n)); }
  function pctf(n, d) { d = (d == null ? 1 : d); return (isFinite(n) ? n : 0).toFixed(d).replace('.', ',') + '%'; }
  function xf(n) { return (isFinite(n) ? n : 0).toFixed(1).replace('.', ',') + 'x'; }

  function toast(msg, isErr) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = 'toast' + (isErr ? ' error' : ''); }, 2800);
  }
  function copyText(str, done) {
    function ok() { if (done) done(true); } function fail() { if (done) done(false); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(str).then(ok).catch(legacy); return; }
    } catch (e) {}
    legacy();
    function legacy() {
      try {
        var ta = document.createElement('textarea'); ta.value = str;
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta); ok();
      } catch (e) { fail(); }
    }
  }

  // ============================================================ LLM (proven plumbing — vsl-ia)
  function fetchContent(messages, active, temperature, noReasoning, maxTokens) {
    var model = ApiKeyManager.getModel();

    // ---- native Google Gemini (AI Studio) path ----
    if (active.service === 'gemini') {
      var gModel = model.indexOf('google/') === 0 ? model.slice(7) : 'gemini-3.5-flash';
      var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + gModel + ':generateContent';
      var sysText = ''; var contents = [];
      messages.forEach(function (m) {
        if (m.role === 'system') { sysText += (sysText ? '\n\n' : '') + m.content; }
        else { contents.push({ role: (m.role === 'assistant' ? 'model' : 'user'), parts: [{ text: String(m.content) }] }); }
      });
      var gBody = { contents: contents, generationConfig: { temperature: temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } };
      if (sysText) gBody.systemInstruction = { parts: [{ text: sysText }] };
      return fetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': active.key }, body: JSON.stringify(gBody) })
        .then(function (resp) {
          return resp.text().then(function (txt) {
            if (!resp.ok) {
              var gmsg = 'Erro ' + resp.status;
              try { var gej = JSON.parse(txt); gmsg = (gej.error && (gej.error.message || gej.error)) || gmsg; } catch (e) {}
              var ger = new Error(typeof gmsg === 'string' ? gmsg : ('Erro ' + resp.status)); ger.status = resp.status; throw ger;
            }
            var gdata = {}; try { gdata = JSON.parse(txt); } catch (e) { throw new Error('Resposta ilegível do provedor.'); }
            if (gdata.promptFeedback && gdata.promptFeedback.blockReason) throw new Error('O provedor bloqueou o pedido (' + gdata.promptFeedback.blockReason + '). Ajuste o texto e tente de novo.');
            var gcand = gdata.candidates && gdata.candidates[0];
            var gparts = gcand && gcand.content && gcand.content.parts;
            var gcontent = gparts ? gparts.map(function (p) { return p.text || ''; }).join('') : '';
            if (!gcontent || !String(gcontent).trim()) { var gee = new Error('Resposta vazia do modelo'); gee.emptyContent = true; throw gee; }
            return gcontent;
          });
        });
    }

    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var url, headers, body;

    if (active.service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + active.key,
        'HTTP-Referer': 'https://trafegoia.appsbrasil.store',
        'X-Title': 'Trafego IA'
      };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: maxTokens };
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034/035
    } else {
      // native OpenAI
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + active.key };
      var oa = model.indexOf('openai/') === 0 ? model.slice(7) : 'gpt-5.5';
      body = { model: oa, messages: messages, max_completion_tokens: maxTokens };
      // omit temperature on native path — gpt-5.x reasoning models reject non-default temps
    }

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (resp) {
      return resp.text().then(function (txt) {
        if (!resp.ok) {
          var msg = 'Erro ' + resp.status;
          try { var ej = JSON.parse(txt); msg = (ej.error && (ej.error.message || ej.error)) || msg; } catch (e) {}
          var er = new Error(typeof msg === 'string' ? msg : ('Erro ' + resp.status)); er.status = resp.status; throw er;
        }
        var data = {}; try { data = JSON.parse(txt); } catch (e) { throw new Error('Resposta ilegível do provedor.'); }
        var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content || !String(content).trim()) { var ee = new Error('Resposta vazia do modelo'); ee.emptyContent = true; throw ee; }
        return content;
      });
    });
  }

  // COR-035 — retry once WITHOUT reasoning if a model answered in the reasoning channel
  function fetchResilient(messages, temperature, maxTokens) {
    var active = ApiKeyManager.getActiveKey();
    if (!active) return Promise.reject(new Error('Nenhuma chave de API configurada.'));
    var model = ApiKeyManager.getModel();
    if (active.service === 'openai' && model.indexOf('openai/') !== 0)
      return Promise.reject(new Error('O modelo selecionado exige uma chave OpenRouter. Escolha um modelo OpenAI ou cole sua chave OpenRouter em "Chaves".'));
    if (active.service === 'gemini' && model.indexOf('google/') !== 0)
      return Promise.reject(new Error('O modelo selecionado exige uma chave OpenRouter. Escolha um modelo Google (Gemini) ou cole sua chave OpenRouter em "Chaves".'));
    if (active.service === 'anthropic')
      return Promise.reject(new Error('A chave Anthropic direta não é chamada pelo navegador. Cole uma chave OpenRouter (acessa a Claude) ou selecione um modelo Google/OpenAI.'));
    return fetchContent(messages, active, temperature, false, maxTokens).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') return fetchContent(messages, active, temperature, true, maxTokens);
      throw e;
    });
  }

  // repair ladder (fences → first{..last} → trailing commas → stray control chars)
  function tryParse(raw) {
    if (!raw) return null;
    var s = String(raw).trim(); var attempts = [s];
    var fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (fenced !== s) attempts.push(fenced);
    var a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) attempts.push(s.slice(a, b + 1));
    var af = fenced.indexOf('{'), bf = fenced.lastIndexOf('}'); if (af >= 0 && bf > af) attempts.push(fenced.slice(af, bf + 1));
    for (var i = 0; i < attempts.length; i++) {
      var cand = attempts[i];
      var variants = [cand, cand.replace(/,\s*([}\]])/g, '$1'), cand.replace(/[\x00-\x1f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')];
      for (var j = 0; j < variants.length; j++) {
        try { var o = JSON.parse(variants[j]); if (o && typeof o === 'object') return o; } catch (e) {}
      }
    }
    return null;
  }

  function generateJSON(messages) {
    return fetchResilient(messages, 0.7, MAXTOK).then(function (raw) {
      var obj = tryParse(raw); if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NAO era um JSON valido. Responda AGORA com APENAS o objeto JSON pedido — sem texto fora do JSON, sem markdown, sem crases. Use aspas retas.' }]);
      return fetchResilient(strict, 0.4, MAXTOK).then(function (raw2) {
        var obj2 = tryParse(raw2); if (obj2) return obj2;
        throw new Error('O modelo nao devolveu um JSON valido. Tente gerar novamente ou troque de modelo.');
      });
    });
  }

  // ============================================================ brief
  function chipVal(groupId) { var g = $(groupId); return g ? (g.getAttribute('data-value') || '') : ''; }
  function readBrief() {
    var modo = chipVal('chips-modo') || 'diario';
    var verba = num($('in-verba').value, 0);
    var dias = Math.max(1, Math.round(num($('in-dias').value, 1)));
    return {
      objetivo: chipVal('chips-objetivo') || 'vendas',
      plataforma: chipVal('chips-plataforma') || 'meta',
      nicho: $('in-nicho').value.trim(),
      produto: $('in-produto').value.trim(),
      ticket: Math.max(0, num($('in-ticket').value, 0)),
      margem: Math.min(100, Math.max(1, num($('in-margem').value, 80))),
      modo: modo,
      verbaDiaria: verba,
      dias: dias,
      verbaTotal: modo === 'diario' ? verba * dias : verba
    };
  }
  function updateVerbaHint() {
    var modo = chipVal('chips-modo') || 'diario';
    var verba = num($('in-verba').value, 0);
    var dias = Math.max(1, Math.round(num($('in-dias').value, 1)));
    var total = modo === 'diario' ? verba * dias : verba;
    var el = $('verba-total'); if (el) el.textContent = money(total, 0);
    var affix = $('dias-affix'); if (affix) affix.textContent = 'dias';
    var diasWrap = $('in-dias'); if (diasWrap) diasWrap.parentElement.style.opacity = modo === 'diario' ? '1' : '.4';
    if (diasWrap) diasWrap.disabled = (modo !== 'diario');
  }

  // ============================================================ prompts
  function systemPrompt() {
    return [
      'Você é um gestor de tráfego pago sênior e planejador de mídia para o mercado brasileiro (infoprodutos, agências, e-commerce e serviços).',
      'Sua função tem DUAS partes: (1) estimar BENCHMARKS realistas de mídia paga para o nicho e a plataforma informados (CPM, CTR, taxa de conversão da página e taxa de conversão em venda), com base na sua experiência de mercado no Brasil; (2) escrever um PLANO DE MÍDIA acionável (estrutura de campanha, verba por conjunto, públicos, ângulos de criativo, cronograma de otimização e um diagnóstico honesto).',
      'Seja realista e conservador nos benchmarks — nada de números fantasiosos. Os valores são premissas de PLANEJAMENTO, não garantias.',
      'Escreva em português do Brasil, linguagem de quem opera campanha de verdade, direto e sem encher linguiça.',
      'Responda EXCLUSIVAMENTE com um objeto JSON válido (aspas retas, sem markdown, sem comentários, sem texto fora do JSON).'
    ].join(' ');
  }

  function userPrompt(b) {
    var isVenda = b.objetivo === 'vendas';
    var topoNome = TOPO[b.objetivo].label.toLowerCase();
    return [
      'Monte o planejamento de uma campanha de tráfego pago com base neste briefing:',
      '',
      'OBJETIVO: ' + OBJ_LABELS[b.objetivo],
      'PLATAFORMA: ' + PLAT_LABELS[b.plataforma],
      'NICHO/SEGMENTO: ' + (b.nicho || '(não informado)'),
      'PRODUTO/OFERTA: ' + (b.produto || '(não informado)'),
      'TICKET MÉDIO: R$ ' + b.ticket,
      'ORÇAMENTO TOTAL DO PERÍODO: R$ ' + Math.round(b.verbaTotal) + (b.modo === 'diario' ? (' (R$ ' + b.verbaDiaria + '/dia por ' + b.dias + ' dias)') : ''),
      'MARGEM DE CONTRIBUIÇÃO: ' + b.margem + '% (quanto sobra do faturamento antes do custo de tráfego)',
      '',
      'Retorne o JSON EXATAMENTE neste formato:',
      '{',
      '  "premissas": {',
      '    "cpm": <número, CPM médio realista em R$ para esse nicho+plataforma no Brasil>,',
      '    "ctr": <número, CTR médio realista em %, ex: 1.2>,',
      '    "conv_pagina": <número, % dos CLIQUES que viram ' + topoNome + ' (conversão da página/anúncio)>,',
      '    "conv_venda": <número, % de ' + topoNome + ' que viram VENDA' + (isVenda ? '; use 100 pois o objetivo já é venda direta' : '') + '>,',
      '    "racional": "<1-2 frases explicando de onde vêm esses benchmarks>"',
      '  },',
      '  "plano": {',
      '    "resumo": "<1 parágrafo: a estratégia geral em linguagem de gestor>",',
      '    "estrutura": [',
      '      { "campanha": "<nome/objetivo da campanha>", "verba_pct": <número, % da verba>, "objetivo_meta": "<objetivo de otimização, ex: Conversões - Compra>", "conjuntos": ["<conjunto/público 1>", "<conjunto 2>"] }',
      '    ],',
      '    "publicos": ["<público/segmentação 1>", "<público 2>", "..."],',
      '    "angulos": [ { "angulo": "<nome do ângulo>", "hook": "<gancho de criativo, 1 frase>", "formato": "<Reels/Imagem/Carrossel/Vídeo>" } ],',
      '    "cronograma": [ { "quando": "Dia 1", "acao": "<o que fazer/checar>" }, { "quando": "Dia 3", "acao": "..." }, { "quando": "Dia 7", "acao": "..." } ],',
      '    "diagnostico": "<parágrafo honesto: o plano é viável com essa verba e esse ticket? o que precisa dar certo (CTR, conversão)? principais riscos?>"',
      '  }',
      '}',
      '',
      'Regras: "estrutura" com 2 a 4 campanhas cujas verba_pct somem ~100. "publicos" com 4 a 7 itens. "angulos" com 3 a 5. "cronograma" com 4 a 6 marcos (Dia 1, Dia 3, Dia 7, Dia 14...). Todos os números são apenas números (sem "R$", sem "%").'
    ].join('\n');
  }

  // ============================================================ engine (deterministic)
  function computeOne(budget, ticket, margem, obj, pr, f) {
    var cpm = Math.max(0.01, pr.cpm * f.cpm);
    var ctr = Math.max(0, pr.ctr * f.ctr);
    var cpg = Math.max(0, pr.conv_pagina * f.cpg);
    var cvd = Math.max(0, pr.conv_venda * f.cvd);
    var impressoes = budget / cpm * 1000;
    var cliques = impressoes * ctr / 100;
    var cpc = cliques > 0 ? budget / cliques : 0;
    var topo = cliques * cpg / 100;
    var vendas = obj === 'vendas' ? topo : topo * cvd / 100;
    var faturamento = vendas * ticket;
    var cpl = topo > 0 ? budget / topo : 0;
    var cac = vendas > 0 ? budget / vendas : 0;
    var roas = budget > 0 ? faturamento / budget : 0;
    var lucro = faturamento * margem / 100 - budget;
    return { impressoes: impressoes, cliques: cliques, cpc: cpc, topo: topo, vendas: vendas, faturamento: faturamento, cpl: cpl, cac: cac, roas: roas, lucro: lucro };
  }
  function computeAll(b, pr) {
    var out = {};
    SCENARIOS.forEach(function (s) { out[s.key] = computeOne(b.verbaTotal, b.ticket, b.margem, b.objetivo, pr, s.f); });
    out.roas_be = b.margem > 0 ? 100 / b.margem : 0;
    return out;
  }

  // ============================================================ render
  function generate() {
    if (busy) return;
    var b = readBrief();
    if (!b.nicho) { toast('Informe o nicho/segmento da campanha.', true); $('in-nicho').focus(); return; }
    if (b.ticket <= 0) { toast('Informe o ticket médio (R$).', true); $('in-ticket').focus(); return; }
    if (b.verbaTotal <= 0) { toast('Informe o orçamento (R$).', true); $('in-verba').focus(); return; }
    if (!ApiKeyManager.hasRequiredKeys()) { toast('Configure sua chave de IA (ícone de chave no topo).', true); flagKey(); return; }

    if (typeof RateLimiter !== 'undefined' && RateLimiter.executeWithLimit) {
      busy = true; renderLoading();
      RateLimiter.executeWithLimit('gerar-plano', function () { return runGen(b); })
        .then(function () {}).catch(function (e) { showError(e); })
        .then(function () { busy = false; });
    } else {
      busy = true; renderLoading();
      runGen(b).catch(function (e) { showError(e); }).then(function () { busy = false; });
    }
  }
  function runGen(b) {
    return generateJSON([{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(b) }])
      .then(function (obj) {
        var pr = normalizePremissas(obj.premissas, b);
        var plano = obj.plano || {};
        DATA = { brief: b, premissas: pr, plano: plano, racional: clean(obj.premissas && obj.premissas.racional) };
        renderResults();
        toast('Plano gerado.');
      });
  }
  function normalizePremissas(p, b) {
    p = p || {};
    var pr = {
      cpm: num(p.cpm, b.plataforma === 'google' ? 18 : 22),
      ctr: num(p.ctr, 1.2),
      conv_pagina: num(p.conv_pagina, b.objetivo === 'leads' ? 20 : 3),
      conv_venda: b.objetivo === 'vendas' ? 100 : num(p.conv_venda, 15)
    };
    // guard rails so a wild LLM number never breaks the math
    pr.cpm = Math.min(500, Math.max(0.5, pr.cpm));
    pr.ctr = Math.min(30, Math.max(0.05, pr.ctr));
    pr.conv_pagina = Math.min(100, Math.max(0.05, pr.conv_pagina));
    pr.conv_venda = Math.min(100, Math.max(0.1, pr.conv_venda));
    return pr;
  }

  function renderLoading() {
    $('results').innerHTML =
      '<div class="state"><div class="spinner"></div>' +
      '<h3>Montando seu plano de mídia…</h3>' +
      '<p>A IA está estimando os benchmarks do nicho e escrevendo a estrutura da campanha.</p>' +
      '<div class="subnote">BENCHMARKS · ESTRUTURA · PROJEÇÃO</div></div>';
  }
  function showError(e) {
    var msg = (e && e.message) ? e.message : 'Falha ao gerar o plano.';
    if (/401|invalid|unauthor/i.test(msg)) msg = 'Chave de API inválida ou sem permissão. Verifique sua chave.';
    else if (/429|rate|limit/i.test(msg)) msg = 'Muitas requisições ou créditos esgotados na sua conta de IA. Aguarde e tente de novo.';
    $('results').innerHTML =
      '<div class="state"><div class="state-glyph"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<h3>Não foi possível gerar</h3><p>' + esc(msg) + '</p></div>';
    toast(msg, true);
  }

  function scenarioRows(b, C) {
    var isVenda = b.objetivo === 'vendas';
    var topoLbl = TOPO[b.objetivo].label;
    var cpLbl = TOPO[b.objetivo].cpLabel;
    var rows = [
      { label: 'Impressões', get: function (x) { return intf(x.impressoes); } },
      { label: 'Cliques', get: function (x) { return intf(x.cliques); } },
      { label: 'CPC', get: function (x) { return money(x.cpc, 2); } }
    ];
    if (!isVenda) {
      rows.push({ label: topoLbl, get: function (x) { return intf(x.topo); } });
      rows.push({ label: cpLbl, get: function (x) { return moneyAuto(x.cpl); } });
    }
    rows.push({ label: 'Vendas', get: function (x) { return intf(x.vendas); } });
    rows.push({ label: 'Faturamento', get: function (x) { return money(x.faturamento, 0); }, strong: true });
    rows.push({ label: 'ROAS', get: function (x) { return xf(x.roas); }, strong: true });
    rows.push({ label: 'CAC', get: function (x) { return moneyAuto(x.cac); } });
    rows.push({ label: 'Lucro projetado', get: function (x) { return (x.lucro >= 0 ? '' : '−') + money(Math.abs(x.lucro), 0).replace('R$ ', 'R$ '); }, sign: true });
    return rows;
  }

  function renderProjection() {
    var b = DATA.brief, pr = DATA.premissas;
    var C = computeAll(b, pr);
    var r = C.realista;
    var beOk = r.roas >= C.roas_be;
    var deltaBe = C.roas_be > 0 ? ((r.roas - C.roas_be) / C.roas_be) * 100 : 0;

    // KPI cards (realista scenario)
    var kpis =
      '<div class="kpi-grid">' +
        '<div class="kpi hero"><div class="kpi-label">ROAS projetado</div><div class="kpi-value">' + xf(r.roas) + '</div>' +
          '<div class="kpi-foot"><span class="delta ' + (beOk ? 'up' : 'down') + '">' + (beOk ? '▲' : '▼') + ' ' + (deltaBe >= 0 ? '+' : '') + Math.round(deltaBe) + '%</span> vs equilíbrio (' + xf(C.roas_be) + ')</div></div>' +
        '<div class="kpi"><div class="kpi-label">Faturamento</div><div class="kpi-value">' + money(r.faturamento, 0) + '</div><div class="kpi-foot">' + intf(r.vendas) + ' vendas · ticket ' + money(b.ticket, 0) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">CAC</div><div class="kpi-value">' + moneyAuto(r.cac) + '</div><div class="kpi-foot">CPC ' + money(r.cpc, 2) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Lucro projetado</div><div class="kpi-value ' + (r.lucro >= 0 ? 'up' : 'down') + '">' + (r.lucro >= 0 ? '' : '−') + money(Math.abs(r.lucro), 0) + '</div><div class="kpi-foot">margem ' + pctf(b.margem, 0) + ' · verba ' + money(b.verbaTotal, 0) + '</div></div>' +
      '</div>';

    // funnel bars (realista) — sqrt scale so drop-off is visible but small stages still show
    var isVenda = b.objetivo === 'vendas';
    var stages = [{ n: 'Impressões', v: r.impressoes }, { n: 'Cliques', v: r.cliques }];
    if (!isVenda) stages.push({ n: TOPO[b.objetivo].label, v: r.topo });
    stages.push({ n: 'Vendas', v: r.vendas });
    var maxV = r.impressoes || 1;
    var bars = '<div class="bars">' + stages.map(function (s, i) {
      var w = Math.max(4, Math.sqrt((s.v || 0) / maxV) * 100);
      return '<div class="bar-row"><span class="bar-label">' + esc(s.n) + '</span>' +
        '<div class="bar-track"><div class="bar-fill step-' + Math.min(i, 3) + '" style="width:' + w.toFixed(1) + '%"></div></div>' +
        '<span class="bar-val">' + intf(s.v) + '</span></div>';
    }).join('') + '</div>';

    // scenario comparison table
    var rows = scenarioRows(b, C);
    var thead = '<thead><tr><th>Métrica</th>' + SCENARIOS.map(function (s) {
      return '<th class="' + (s.key === 'realista' ? 'real' : '') + '">' + s.name + '</th>';
    }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (row) {
      var tds = SCENARIOS.map(function (s) {
        var x = C[s.key]; var val = row.get(x);
        var cls = (s.key === 'realista' ? 'real' : '');
        if (row.sign) cls += (x.lucro >= 0 ? ' pos' : ' neg');
        return '<td class="' + cls.trim() + '">' + val + '</td>';
      }).join('');
      return '<tr' + (row.strong ? ' class="hl"' : '') + '><td>' + esc(row.label) + '</td>' + tds + '</tr>';
    }).join('') + '</tbody>';

    return '<div id="proj-region" class="res-body">' + kpis +
      '<div class="card-block"><h3>Funil projetado <span class="panel-title-mono" style="font-weight:400">cenário realista</span></h3>' +
        '<div class="block-sub">Do investimento à venda, no cenário realista.</div>' + bars + '</div>' +
      '<div class="card-block"><h3>Projeção por cenário</h3>' +
        '<div class="block-sub">Mesma verba, variando CTR, conversão e CPM. O realista é a referência.</div>' +
        '<div class="scn-wrap"><table class="scn-table">' + thead + tbody + '</table></div></div>' +
      '</div>';
  }

  function renderAssumptions() {
    var b = DATA.brief, pr = DATA.premissas;
    var isVenda = b.objetivo === 'vendas';
    var topoNome = TOPO[b.objetivo].label.toLowerCase();
    var cells =
      assump('as-cpm', 'CPM', 'R$', pr.cpm, 2) +
      assump('as-ctr', 'CTR', '%', pr.ctr, 2) +
      assump('as-cpg', 'Cliques → ' + topoNome, '%', pr.conv_pagina, 2) +
      (isVenda ? '' : assump('as-cvd', topoNome + ' → venda', '%', pr.conv_venda, 1));
    return '<div class="card-block"><h3>Benchmarks (premissas) <span class="panel-title-mono" style="font-weight:400">editável</span></h3>' +
      '<div class="block-sub">Estimados pela IA para o seu nicho. Ajuste com seus próprios números e a projeção recalcula na hora.</div>' +
      '<div class="assump-grid">' + cells + '</div>' +
      (DATA.racional ? '<div class="assump-note"><span class="lbl">RACIONAL DA IA:</span> ' + esc(DATA.racional) + '</div>' : '') +
      '</div>';
  }
  function assump(id, label, unit, val, dec) {
    var left = unit === 'R$' ? '<span class="u">R$</span>' : '';
    var right = unit === '%' ? '<span class="u">%</span>' : '';
    return '<div class="assump"><label>' + esc(label) + '</label><div class="assump-in">' + left +
      '<input type="number" id="' + id + '" inputmode="decimal" min="0" step="' + (dec === 2 ? '0.1' : '0.5') + '" value="' + (Math.round(val * 100) / 100) + '">' + right + '</div></div>';
  }

  function renderPlan() {
    var p = DATA.plano || {};
    var html = '<div id="plan-region">';

    if (clean(p.resumo)) html += '<div class="card-block"><div class="plan-block"><h4>Estratégia</h4><p class="plan-p">' + esc(clean(p.resumo)) + '</p></div></div>';

    var estrutura = Array.isArray(p.estrutura) ? p.estrutura : [];
    if (estrutura.length) {
      html += '<div class="card-block"><div class="plan-block"><h4>Estrutura de campanha</h4><div class="camp-list">' +
        estrutura.map(function (c) {
          var sets = Array.isArray(c.conjuntos) ? c.conjuntos : [];
          var pct = clean(c.verba_pct); if (pct) pct = String(pct).replace('%', '') + '%';
          return '<div class="camp"><div class="camp-top"><span class="camp-name">' + esc(clean(c.campanha) || 'Campanha') + '</span>' +
            (pct ? '<span class="camp-pct">' + esc(pct) + '</span>' : '') + '</div>' +
            (clean(c.objetivo_meta) ? '<div class="camp-meta">Otimização: ' + esc(clean(c.objetivo_meta)) + '</div>' : '') +
            (sets.length ? '<div class="camp-sets">' + sets.map(function (s) { return '<span class="tag">' + esc(clean(s)) + '</span>'; }).join('') + '</div>' : '') +
            '</div>';
        }).join('') + '</div></div></div>';
    }

    var publicos = Array.isArray(p.publicos) ? p.publicos.filter(function (x) { return clean(x); }) : [];
    var angulos = Array.isArray(p.angulos) ? p.angulos : [];
    if (publicos.length || angulos.length) {
      html += '<div class="card-block">';
      if (publicos.length) html += '<div class="plan-block"><h4>Públicos & segmentações</h4><div class="pill-list">' +
        publicos.map(function (x) { return '<span class="pill">' + esc(clean(x)) + '</span>'; }).join('') + '</div></div>';
      if (angulos.length) html += '<div class="plan-block"><h4>Ângulos de criativo para testar</h4><div class="angle-list">' +
        angulos.map(function (a) {
          return '<div class="angle"><div class="angle-top"><span class="angle-name">' + esc(clean(a.angulo) || 'Ângulo') + '</span>' +
            (clean(a.formato) ? '<span class="angle-fmt">' + esc(clean(a.formato)) + '</span>' : '') + '</div>' +
            (clean(a.hook) ? '<div class="angle-hook">“' + esc(clean(a.hook)) + '”</div>' : '') + '</div>';
        }).join('') + '</div></div>';
      html += '</div>';
    }

    var crono = Array.isArray(p.cronograma) ? p.cronograma : [];
    if (crono.length) {
      html += '<div class="card-block"><div class="plan-block"><h4>Cronograma de otimização</h4><div class="timeline">' +
        crono.map(function (t) {
          return '<div class="tl-item"><span class="tl-when">' + esc(clean(t.quando) || '—') + '</span><span class="tl-what">' + esc(clean(t.acao)) + '</span></div>';
        }).join('') + '</div></div></div>';
    }

    if (clean(p.diagnostico)) html += '<div class="card-block diag"><div class="plan-block"><h4>Diagnóstico</h4><p class="plan-p">' + esc(clean(p.diagnostico)) + '</p></div></div>';

    html += '<p class="disclaimer">Os números são uma <strong>projeção de planejamento</strong> baseada em benchmarks estimados — não são garantia de resultado. Ajuste as premissas com seus próprios dados. Tráfego IA não conecta a contas de anúncio nem coleta dados em tempo real.</p>';
    html += '</div>';
    return html;
  }

  function renderResults() {
    var b = DATA.brief;
    var head =
      '<div class="res-head"><div class="res-title"><h2>Plano de mídia — ' + esc(OBJ_LABELS[b.objetivo]) + '</h2>' +
        '<div class="res-sub">' + esc(PLAT_LABELS[b.plataforma]) + ' · ' + esc(b.nicho) + ' · verba ' + money(b.verbaTotal, 0) + (b.modo === 'diario' ? (' (' + money(b.verbaDiaria, 0) + '/dia × ' + b.dias + ')') : '') + '</div></div>' +
        '<div class="res-actions">' +
          '<button class="btn-sm" id="btn-regen" title="Gerar novamente com a IA">↻ Regenerar</button>' +
          '<button class="btn-sm" id="btn-csv">⤓ CSV</button>' +
          '<button class="btn-sm" id="btn-copy">Copiar</button>' +
          '<button class="btn-sm primary" id="btn-pdf">Baixar PDF</button>' +
        '</div></div>';
    $('results').innerHTML = head + renderProjection() + renderAssumptions() + renderPlan();
    wireResults();
  }

  // recompute numbers only (keeps assumption inputs & written plan; no LLM)
  function recompute() {
    if (!DATA) return;
    // pull live budget from the brief (verba/dias/modo/ticket/margem)
    DATA.brief = mergeBudget(DATA.brief);
    var region = $('proj-region');
    if (region) {
      var wrap = document.createElement('div');
      wrap.innerHTML = renderProjection();
      region.parentNode.replaceChild(wrap.firstChild, region);
    }
  }
  function mergeBudget(b) {
    var live = readBrief();
    // keep objetivo/plataforma/nicho from the generated brief; refresh the numeric budget knobs
    b.ticket = live.ticket; b.margem = live.margem; b.modo = live.modo;
    b.verbaDiaria = live.verbaDiaria; b.dias = live.dias; b.verbaTotal = live.verbaTotal;
    return b;
  }

  function wireResults() {
    var regen = $('btn-regen'); if (regen) regen.onclick = function () { generate(); };
    var csv = $('btn-csv'); if (csv) csv.onclick = exportCSV;
    var copy = $('btn-copy'); if (copy) copy.onclick = exportCopy;
    var pdf = $('btn-pdf'); if (pdf) pdf.onclick = function () { window.print(); };
    ['as-cpm', 'as-ctr', 'as-cpg', 'as-cvd'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener('input', function () {
        DATA.premissas.cpm = num($('as-cpm').value, DATA.premissas.cpm);
        DATA.premissas.ctr = num($('as-ctr').value, DATA.premissas.ctr);
        DATA.premissas.conv_pagina = num($('as-cpg').value, DATA.premissas.conv_pagina);
        if ($('as-cvd')) DATA.premissas.conv_venda = num($('as-cvd').value, DATA.premissas.conv_venda);
        recompute();
      });
    });
  }

  // ============================================================ export
  function csvCell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
  function exportCSV() {
    if (!DATA) return;
    var b = DATA.brief, C = computeAll(b, DATA.premissas);
    var rows = scenarioRows(b, C);
    var lines = [];
    lines.push([csvCell('Tráfego IA — Projeção'), '', '', ''].join(';'));
    lines.push([csvCell('Objetivo'), csvCell(OBJ_LABELS[b.objetivo]), csvCell('Plataforma'), csvCell(PLAT_LABELS[b.plataforma])].join(';'));
    lines.push([csvCell('Nicho'), csvCell(b.nicho), csvCell('Verba total'), csvCell(money(b.verbaTotal, 0))].join(';'));
    lines.push([csvCell('Ticket'), csvCell(money(b.ticket, 2)), csvCell('Margem'), csvCell(pctf(b.margem, 0))].join(';'));
    lines.push('');
    lines.push(['Métrica', 'Conservador', 'Realista', 'Otimista'].map(csvCell).join(';'));
    rows.forEach(function (row) {
      lines.push([csvCell(row.label)].concat(SCENARIOS.map(function (s) { return csvCell(row.get(C[s.key])); })).join(';'));
    });
    lines.push('');
    lines.push([csvCell('Premissas'), csvCell('CPM ' + money(DATA.premissas.cpm, 2)), csvCell('CTR ' + pctf(DATA.premissas.ctr, 2)), csvCell('Conv. ' + pctf(DATA.premissas.conv_pagina, 2))].join(';'));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, 'plano-trafego-' + slug(b.nicho) + '.csv');
    toast('CSV exportado.');
  }
  function slug(s) { return (String(s || 'campanha').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'campanha').slice(0, 40); }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob); var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function exportCopy() {
    if (!DATA) return;
    var b = DATA.brief, pr = DATA.premissas, C = computeAll(b, pr), r = C.realista, p = DATA.plano || {};
    var L = [];
    L.push('PLANO DE MÍDIA — ' + OBJ_LABELS[b.objetivo].toUpperCase());
    L.push(PLAT_LABELS[b.plataforma] + ' · ' + b.nicho + (b.produto ? ' · ' + b.produto : ''));
    L.push('Verba: ' + money(b.verbaTotal, 0) + '  |  Ticket: ' + money(b.ticket, 2) + '  |  Margem: ' + pctf(b.margem, 0));
    L.push('');
    L.push('PROJEÇÃO (cenário realista):');
    L.push('  Impressões: ' + intf(r.impressoes) + '  |  Cliques: ' + intf(r.cliques) + '  |  CPC: ' + money(r.cpc, 2));
    if (b.objetivo !== 'vendas') L.push('  ' + TOPO[b.objetivo].label + ': ' + intf(r.topo) + '  |  ' + TOPO[b.objetivo].cpLabel + ': ' + moneyAuto(r.cpl));
    L.push('  Vendas: ' + intf(r.vendas) + '  |  Faturamento: ' + money(r.faturamento, 0));
    L.push('  ROAS: ' + xf(r.roas) + '  |  CAC: ' + moneyAuto(r.cac) + '  |  Lucro: ' + (r.lucro >= 0 ? '' : '-') + money(Math.abs(r.lucro), 0));
    L.push('  ROAS de equilíbrio: ' + xf(C.roas_be));
    L.push('');
    L.push('BENCHMARKS: CPM ' + money(pr.cpm, 2) + ' · CTR ' + pctf(pr.ctr, 2) + ' · Conv. página ' + pctf(pr.conv_pagina, 2) + (b.objetivo !== 'vendas' ? (' · Conv. venda ' + pctf(pr.conv_venda, 1)) : ''));
    L.push('');
    if (clean(p.resumo)) { L.push('ESTRATÉGIA:'); L.push(clean(p.resumo)); L.push(''); }
    if (Array.isArray(p.estrutura) && p.estrutura.length) {
      L.push('ESTRUTURA DE CAMPANHA:');
      p.estrutura.forEach(function (c) {
        var pct = clean(c.verba_pct); if (pct) pct = ' (' + String(pct).replace('%', '') + '%)';
        L.push('- ' + (clean(c.campanha) || 'Campanha') + pct + (clean(c.objetivo_meta) ? ' — ' + clean(c.objetivo_meta) : ''));
        if (Array.isArray(c.conjuntos)) c.conjuntos.forEach(function (s) { if (clean(s)) L.push('    • ' + clean(s)); });
      });
      L.push('');
    }
    if (Array.isArray(p.publicos) && p.publicos.length) { L.push('PÚBLICOS: ' + p.publicos.map(clean).filter(Boolean).join(' | ')); L.push(''); }
    if (Array.isArray(p.angulos) && p.angulos.length) {
      L.push('ÂNGULOS DE CRIATIVO:');
      p.angulos.forEach(function (a) { L.push('- ' + (clean(a.angulo) || 'Ângulo') + (clean(a.formato) ? ' [' + clean(a.formato) + ']' : '') + (clean(a.hook) ? ': ' + clean(a.hook) : '')); });
      L.push('');
    }
    if (Array.isArray(p.cronograma) && p.cronograma.length) {
      L.push('CRONOGRAMA:');
      p.cronograma.forEach(function (t) { L.push('- ' + (clean(t.quando) || '—') + ': ' + clean(t.acao)); });
      L.push('');
    }
    if (clean(p.diagnostico)) { L.push('DIAGNÓSTICO:'); L.push(clean(p.diagnostico)); L.push(''); }
    L.push('— Projeção de planejamento, não garantia de resultado. Gerado com Tráfego IA (Gênesis IA).');
    copyText(L.join('\n'), function (ok) { toast(ok ? 'Plano copiado.' : 'Não foi possível copiar.', !ok); });
  }

  // ============================================================ wiring
  function flagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint warn'; h.textContent = 'Configure sua chave de IA no ícone de chave (topo direito) para gerar o plano.'; }
  }
  function unflagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint'; h.textContent = 'A IA preenche os benchmarks do nicho e escreve o plano; o cálculo é instantâneo.'; }
  }
  function wireChips(groupId, onChange) {
    var g = $(groupId); if (!g) return;
    g.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip'); if (!chip || !g.contains(chip)) return;
      g.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      g.setAttribute('data-value', chip.getAttribute('data-val') || '');
      if (onChange) onChange();
    });
  }

  var App = (function () {
    function init() {
      var session = (typeof MembershipGate !== 'undefined') ? MembershipGate.getSession() : null;
      // chips
      wireChips('chips-objetivo');
      wireChips('chips-plataforma');
      wireChips('chips-modo', function () { updateVerbaHint(); recompute(); });
      // budget hint + live recompute
      ['in-verba', 'in-dias', 'in-ticket', 'in-margem'].forEach(function (id) {
        var el = $(id); if (!el) return;
        el.addEventListener('input', function () { updateVerbaHint(); recompute(); });
      });
      updateVerbaHint();
      // studio model picker (COR-041 — every model <select> must be rendered)
      if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
      // generate
      var gen = $('btn-gerar'); if (gen) gen.onclick = generate;
      // key hint
      if (ApiKeyManager.hasRequiredKeys()) unflagKey(); else flagKey();
      document.addEventListener('click', function () { if (ApiKeyManager.hasRequiredKeys()) unflagKey(); }, true);
    }
    return { init: init };
  })();

  // init when the gate reveals the app
  var _init = false;
  function tryInit() {
    if (_init) return;
    var session = (typeof MembershipGate !== 'undefined') ? MembershipGate.getSession() : null;
    if (session) { _init = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryInit);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInit, 150); });

  window.TrafegoApp = { generate: generate }; // debug hook
})();
