/**
 * Precificação IA — Main Application Logic
 * Calculadora determinística de preços + IA de empacotamento/posicionamento.
 * Um motor client-side calcula preço-hora, break-even, 3 pacotes e volume-para-meta;
 * a IA (BYOK) escreve os entregáveis de cada pacote, o posicionamento, a quebra de
 * objeções e o diagnóstico. Inputs editáveis → recálculo instantâneo (sem chamar a IA).
 *
 * BYOK: toda geração roda na chave do próprio usuário (Hard Rule #1).
 * LLM plumbing: COR-032 (reroll) / COR-034-035 (reasoning/deepseek) / COR-015 (null-strings).
 */
(function () {
  'use strict';

  var MAXTOK = 9000; // generous — reasoning + content must both fit (COR-034)

  // ── charge-model tier definitions ──
  // projeto/mensal: scope levels scaled by hours; hora: hour packages with volume discount.
  var TIER_DEFS = {
    projeto: [
      { key: 'essencial',    label: 'Essencial',    hf: 0.6 },
      { key: 'profissional', label: 'Profissional', hf: 1.0, rec: true },
      { key: 'premium',      label: 'Premium',      hf: 1.7 }
    ],
    mensal: [
      { key: 'essencial',    label: 'Essencial',    hf: 0.6 },
      { key: 'profissional', label: 'Profissional', hf: 1.0, rec: true },
      { key: 'premium',      label: 'Premium',      hf: 1.7 }
    ],
    hora: [
      { key: 'avulsa',   label: 'Hora avulsa', qty: 1,  disc: 0.00 },
      { key: 'pacote10', label: 'Pacote 10h',  qty: 10, disc: 0.08, rec: true },
      { key: 'pacote20', label: 'Pacote 20h',  qty: 20, disc: 0.15 }
    ]
  };

  var MODE_LABELS = { projeto: 'Por projeto', mensal: 'Mensalidade', hora: 'Por hora' };
  var UNIT_SHORT = { projeto: 'projeto', mensal: 'mês', hora: 'pacote' };

  // ── state ──
  var DATA = null;   // { brief, ai:{pacotes,posicionamento,...} }
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
  function num(v, dflt) { var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : (dflt == null ? 0 : dflt); }
  function money(n, d) { if (!isFinite(n)) n = 0; d = (d == null ? 0 : d); return 'R$ ' + new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n); }
  function pctf(n, d) { d = (d == null ? 0 : d); return (isFinite(n) ? n : 0).toFixed(d).replace('.', ',') + '%'; }
  function niceRound(n) {
    n = Math.max(0, n || 0);
    if (n < 100) return Math.round(n / 5) * 5;
    if (n < 500) return Math.round(n / 10) * 10;
    if (n < 3000) return Math.round(n / 50) * 50;
    if (n < 20000) return Math.round(n / 100) * 100;
    return Math.round(n / 500) * 500;
  }

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

  // ============================================================ LLM (proven plumbing — trafego-ia)
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
        'HTTP-Referer': 'https://precificacaoia.appsbrasil.store',
        'X-Title': 'Precificacao IA'
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
    return {
      modelo: chipVal('chips-modelo') || 'projeto',
      nicho: $('in-nicho').value.trim(),
      custos: Math.max(0, num($('in-custos').value, 0)),
      meta: Math.max(0, num($('in-meta').value, 0)),
      horas: Math.max(1, num($('in-horas').value, 120)),
      margem: Math.min(300, Math.max(0, num($('in-margem').value, 25))),
      horasproj: Math.max(0.5, num($('in-horasproj').value, 20)),
      custodir: Math.max(0, num($('in-custodir').value, 0)),
      mercMin: Math.max(0, num($('in-mercmin').value, 0)),
      mercMax: Math.max(0, num($('in-mercmax').value, 0))
    };
  }

  // ============================================================ engine (deterministic)
  function computeEngine(b) {
    var custoHora = b.horas > 0 ? (b.custos + b.meta) / b.horas : 0;
    var precoHora = custoHora * (1 + b.margem / 100);
    var receitaAlvo = b.custos + b.meta;
    var defs = TIER_DEFS[b.modelo] || TIER_DEFS.projeto;
    var horasBase = b.horasproj;

    var tiers = defs.map(function (d) {
      if (b.modelo === 'hora') {
        var perHora = precoHora * (1 - d.disc);
        return { key: d.key, label: d.label, rec: !!d.rec, horas: d.qty, disc: d.disc, perHora: perHora, preco: niceRound(perHora * d.qty), custoMin: custoHora * d.qty };
      }
      var h = horasBase * d.hf;
      return { key: d.key, label: d.label, rec: !!d.rec, horas: h, preco: niceRound(precoHora * h + b.custodir), custoMin: custoHora * h + b.custodir, custoDir: b.custodir };
    });

    var rec = tiers.filter(function (t) { return t.rec; })[0] || tiers[1] || tiers[0];

    var precoMinRec, volume;
    if (b.modelo === 'hora') {
      precoMinRec = niceRound(custoHora);
      var horasMeta = precoHora > 0 ? Math.ceil(receitaAlvo / precoHora) : 0;
      volume = { unidLabel: 'horas/mês', meta: horasMeta, capacidade: Math.round(b.horas), horasMeta: horasMeta };
    } else {
      precoMinRec = Math.round(rec.custoMin);
      var contrib = Math.max(1, rec.preco - b.custodir);
      var unidMeta = Math.ceil(receitaAlvo / contrib);
      var capac = horasBase > 0 ? Math.floor(b.horas / horasBase) : 0;
      volume = { unidLabel: (b.modelo === 'mensal' ? 'clientes/mês' : 'projetos/mês'), meta: unidMeta, capacidade: capac, horasMeta: unidMeta * horasBase };
    }

    var pos = null;
    if (b.mercMin > 0 || b.mercMax > 0) {
      var lo = b.mercMin, hi = b.mercMax, p = rec.preco;
      if (hi > 0 && p > hi) pos = { cls: 'premium', txt: 'acima do mercado' };
      else if (lo > 0 && p < lo) pos = { cls: 'abaixo', txt: 'abaixo do mercado' };
      else pos = { cls: 'media', txt: 'dentro da faixa de mercado' };
      pos.lo = lo; pos.hi = hi;
    }

    return { custoHora: custoHora, precoHora: precoHora, receitaAlvo: receitaAlvo, tiers: tiers, rec: rec, precoMinRec: precoMinRec, volume: volume, pos: pos };
  }

  // ============================================================ prompts
  function systemPrompt() {
    return [
      'Você é um consultor de precificação e posicionamento para prestadores de serviço, freelancers, agências, social medias, designers, editores de vídeo, consultores e mentores no mercado brasileiro.',
      'Você recebe o serviço/nicho e uma estrutura de 3 pacotes JÁ PRECIFICADA por um motor determinístico. Você NÃO define nem repete preços em reais — os números vêm do sistema. Sua função é escrever o CONTEÚDO: o que cada pacote entrega, o posicionamento de valor, a ancoragem, a quebra de objeções e um diagnóstico honesto.',
      'Escreva em português do Brasil, específico para o nicho, na linguagem de quem vende serviço de verdade. Nada de encher linguiça.',
      'Responda EXCLUSIVAMENTE com um objeto JSON válido (aspas retas, sem markdown, sem comentários, sem texto fora do JSON).'
    ].join(' ');
  }

  function userPrompt(b, E, askMarket) {
    var isHora = b.modelo === 'hora';
    var unid = UNIT_SHORT[b.modelo];
    var linhas = E.tiers.map(function (t) {
      var esc2 = isHora ? (t.horas + 'h no total') : (Math.round(t.horas) + 'h de trabalho');
      return '- ' + t.label + (t.rec ? ' (RECOMENDADO — pacote do meio, use como âncora)' : '') + ': ~' + esc2;
    }).join('\n');

    return [
      'Monte o conteúdo de um cardápio de preços para este prestador de serviço:',
      '',
      'SERVIÇO / NICHO: ' + (b.nicho || '(não informado)'),
      'MODELO DE COBRANÇA: ' + MODE_LABELS[b.modelo] + (isHora ? ' (o cliente compra horas/pacotes de horas)' : (b.modelo === 'mensal' ? ' (mensalidade/recorrente por cliente)' : ' (preço fechado por projeto/entrega)')),
      'ESTRUTURA DOS 3 PACOTES (portes — descreva o que cada um entrega, do enxuto ao completo; NÃO cite preços):',
      linhas,
      '',
      'Retorne o JSON EXATAMENTE neste formato:',
      '{',
      '  "pacotes": [',
      '    { "tier": "' + E.tiers[0].key + '", "nome": "<nome curto e atrativo do pacote para o nicho>", "resumo": "<1 frase do que é>", "entregaveis": ["<entregável>", "<entregável>"], "ideal_para": "<para que tipo de cliente>" },',
      '    { "tier": "' + E.tiers[1].key + '", "nome": "...", "resumo": "...", "entregaveis": ["...", "..."], "ideal_para": "..." },',
      '    { "tier": "' + E.tiers[2].key + '", "nome": "...", "resumo": "...", "entregaveis": ["...", "..."], "ideal_para": "..." }',
      '  ],',
      '  "posicionamento": "<1 parágrafo: como se posicionar e justificar esse preço nesse nicho (autoridade, resultado, escassez)>",',
      '  "ancoragem": "<como apresentar as 3 opções ao cliente: qual ancorar, parcelamento, como conduzir para o pacote do meio>",',
      '  "objecoes": [ { "objecao": "Tá caro", "resposta": "<como responder>" }, { "objecao": "Vou pensar", "resposta": "..." }, { "objecao": "O concorrente cobra menos", "resposta": "..." } ],',
      '  "diagnostico": "<1 parágrafo honesto: esse preço faz sentido para o nicho? principais riscos? o que precisa para sustentar/subir?>",',
      '  "dicas": ["<dica prática de precificação para o nicho>", "<outra dica>"]' + (askMarket ? ',' : ''),
      (askMarket ? '  "mercado": { "min": <número, menor preço que o mercado BR costuma cobrar por ' + unid + ' nesse nicho>, "max": <número, maior preço>, "racional": "<1 frase>" }' : ''),
      '}',
      '',
      'Regras: 2 a 5 entregáveis por pacote, coerentes com o porte (Essencial enxuto, Premium completo, sem repetir os mesmos itens em todos). 3 a 4 objeções reais. 2 a 4 dicas.' + (askMarket ? ' Em "mercado" use apenas números (sem "R$").' : ' NÃO inclua o campo "mercado".') + ' Nenhum preço em reais dentro de "pacotes", "posicionamento", "ancoragem", "objecoes" ou "diagnostico".'
    ].filter(function (x) { return x !== ''; }).join('\n');
  }

  // ============================================================ generate
  function generate() {
    if (busy) return;
    var b = readBrief();
    if (!b.nicho) { toast('Informe o seu serviço/nicho.', true); $('in-nicho').focus(); return; }
    if (b.custos + b.meta <= 0) { toast('Informe custos fixos e/ou sua meta de renda.', true); $('in-meta').focus(); return; }
    if (b.modelo !== 'hora' && b.horasproj <= 0) { toast('Informe as horas por ' + (b.modelo === 'mensal' ? 'mês' : 'projeto') + '.', true); $('in-horasproj').focus(); return; }
    if (!ApiKeyManager.hasRequiredKeys()) { toast('Configure sua chave de IA (ícone de chave no topo).', true); flagKey(); return; }

    var E = computeEngine(b);
    var askMarket = !(b.mercMin > 0 && b.mercMax > 0);

    if (typeof RateLimiter !== 'undefined' && RateLimiter.executeWithLimit) {
      busy = true; renderLoading();
      RateLimiter.executeWithLimit('gerar-precos', function () { return runGen(b, E, askMarket); })
        .then(function () {}).catch(function (e) { showError(e); })
        .then(function () { busy = false; });
    } else {
      busy = true; renderLoading();
      runGen(b, E, askMarket).catch(function (e) { showError(e); }).then(function () { busy = false; });
    }
  }
  function runGen(b, E, askMarket) {
    return generateJSON([{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(b, E, askMarket) }])
      .then(function (obj) {
        DATA = { brief: b, ai: obj || {} };
        // If the AI estimated a market range and the user left it blank, prefill the inputs
        if (askMarket && obj && obj.mercado) {
          var mn = num(obj.mercado.min, 0), mx = num(obj.mercado.max, 0);
          if (mn > 0 && !$('in-mercmin').value) $('in-mercmin').value = Math.round(mn);
          if (mx > 0 && !$('in-mercmax').value) $('in-mercmax').value = Math.round(mx);
          DATA.brief = readBrief();
        }
        renderResults();
        toast('Cardápio gerado.');
      });
  }

  function renderLoading() {
    $('results').innerHTML =
      '<div class="state"><div class="spinner"></div>' +
      '<h3>Emplatando seu cardápio…</h3>' +
      '<p>O cálculo já está pronto; a IA está escrevendo os pacotes, o posicionamento e a quebra de objeções.</p>' +
      '<div class="subnote">CÁLCULO · PACOTES · POSICIONAMENTO</div></div>';
  }
  function showError(e) {
    var msg = (e && e.message) ? e.message : 'Falha ao gerar o cardápio.';
    if (/401|invalid|unauthor/i.test(msg)) msg = 'Chave de API inválida ou sem permissão. Verifique sua chave.';
    else if (/429|rate|limit|quota|exhaust/i.test(msg)) msg = 'Muitas requisições ou créditos esgotados na sua conta de IA. Aguarde e tente de novo.';
    $('results').innerHTML =
      '<div class="state"><div class="state-glyph"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<h3>Não foi possível gerar</h3><p>' + esc(msg) + '</p></div>';
    toast(msg, true);
  }

  // ============================================================ render
  function aiPacote(tierKey, idx) {
    var arr = (DATA.ai && Array.isArray(DATA.ai.pacotes)) ? DATA.ai.pacotes : [];
    var byKey = arr.filter(function (p) { return (clean(p.tier) || '').toLowerCase() === tierKey; })[0];
    return byKey || arr[idx] || {};
  }
  function unitSuffix(b) { return b.modelo === 'mensal' ? '/mês' : (b.modelo === 'hora' ? '' : '/projeto'); }

  function renderMenu(b, E) {
    var suffix = unitSuffix(b);
    var cards = E.tiers.map(function (t, i) {
      var ai = aiPacote(t.key, i);
      var nome = clean(ai.nome) || t.label;
      var resumo = clean(ai.resumo);
      var ideal = clean(ai.ideal_para);
      var ents = Array.isArray(ai.entregaveis) ? ai.entregaveis.map(clean).filter(Boolean) : [];
      var unitLabel = b.modelo === 'hora'
        ? (t.horas === 1 ? 'por hora' : 'pacote ' + t.horas + 'h')
        : (b.modelo === 'mensal' ? 'por mês' : 'por projeto');
      var note = b.modelo === 'hora'
        ? (money(t.perHora, 0) + '/h' + (t.disc > 0 ? ' · ' + pctf(t.disc * 100, 0) + ' de desconto' : ''))
        : (Math.round(t.horas) + 'h de trabalho · ' + money(E.precoHora, 0) + '/h');
      return '<article class="tier' + (t.rec ? ' rec' : '') + '">' +
        (t.rec ? '<span class="rec-ribbon">Recomendado</span>' : '') +
        '<div class="tier-course">' + esc(t.label) + '</div>' +
        '<h4 class="tier-name">' + esc(nome) + '</h4>' +
        (resumo ? '<p class="tier-resumo">' + esc(resumo) + '</p>' : '') +
        '<div class="tier-priceline"><span class="tpl-label">' + esc(unitLabel) + '</span><span class="tpl-leader" aria-hidden="true"></span><span class="tpl-price">' + money(t.preco, 0) + '</span></div>' +
        '<div class="tier-perhora">' + note + '</div>' +
        '<div class="fleuron-rule" aria-hidden="true"><span>&#10086;</span></div>' +
        (ents.length ? '<ul class="tier-ents">' + ents.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        (ideal ? '<div class="tier-ideal"><span>Ideal para</span> ' + esc(ideal) + '</div>' : '') +
        '</article>';
    }).join('');
    return '<div class="card-block menu-block"><div class="menu-head"><h3>O cardápio</h3><span class="menu-sub">Três opções para o cliente escolher — o pacote do meio é a âncora.</span></div>' +
      '<div class="tier-grid">' + cards + '</div></div>';
  }

  function renderKpis(b, E) {
    var v = E.volume;
    var meta = v.meta, cap = v.capacidade;
    var folgaOk = cap >= meta;
    var recPrice = E.rec.preco;
    return '<div class="kpi-grid">' +
      '<div class="kpi hero"><div class="kpi-label">Preço-hora recomendado</div><div class="kpi-value">' + money(E.precoHora, 0) + '<span class="kpi-unit">/h</span></div>' +
        '<div class="kpi-foot">mínimo (equilíbrio): ' + money(E.custoHora, 0) + '/h</div></div>' +
      '<div class="kpi"><div class="kpi-label">Pacote recomendado</div><div class="kpi-value">' + money(recPrice, 0) + '</div><div class="kpi-foot">' + esc(E.rec.label) + (b.modelo === 'hora' ? '' : ' · ' + Math.round(E.rec.horas) + 'h') + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">' + (b.modelo === 'hora' ? 'Preço-hora mínimo' : 'Preço mínimo (equilíbrio)') + '</div><div class="kpi-value">' + money(E.precoMinRec, 0) + (b.modelo === 'hora' ? '<span class="kpi-unit">/h</span>' : '') + '</div><div class="kpi-foot">nunca cobre abaixo disso</div></div>' +
      '<div class="kpi"><div class="kpi-label">Para bater a meta</div><div class="kpi-value">' + meta + ' <span class="kpi-unit">' + esc(v.unidLabel) + '</span></div>' +
        '<div class="kpi-foot"><span class="' + (folgaOk ? 'ok' : 'warn') + '">' + (folgaOk ? '✓ cabe na sua capacidade' : '✕ acima da sua capacidade') + '</span> (' + cap + ' ' + esc(v.unidLabel) + ')</div></div>' +
      '</div>';
  }

  function renderBastidores(b, E) {
    var v = E.volume;
    var recPrice = E.rec.preco;
    var lucro = recPrice - E.rec.custoMin;
    var margemReal = recPrice > 0 ? (lucro / recPrice) * 100 : 0;
    var rows = [
      ['Receita-alvo mensal (custos + sua meta)', money(E.receitaAlvo, 0)],
      ['Preço-hora de equilíbrio', money(E.custoHora, 0) + '/h'],
      ['Preço-hora recomendado (com margem)', money(E.precoHora, 0) + '/h'],
      ['Margem no pacote recomendado', money(lucro, 0) + ' (' + pctf(margemReal, 0) + ')'],
      ['Volume para a meta', v.meta + ' ' + v.unidLabel + ' · ~' + Math.round(v.horasMeta) + 'h/mês'],
      ['Sua capacidade', v.capacidade + ' ' + v.unidLabel]
    ];
    var posHtml = '';
    if (E.pos) {
      var faixa = (E.pos.lo > 0 ? money(E.pos.lo, 0) : '?') + ' – ' + (E.pos.hi > 0 ? money(E.pos.hi, 0) : '?');
      posHtml = '<div class="market-pos ' + E.pos.cls + '"><span class="mp-dot"></span>Seu pacote recomendado (' + money(recPrice, 0) + ') está <strong>' + esc(E.pos.txt) + '</strong> — faixa informada: ' + faixa + '.</div>';
    }
    return '<div class="card-block"><h3>Bastidores do cálculo <span class="panel-title-mono">só para você</span></h3>' +
      '<div class="block-sub">A conta por trás dos preços. Ajuste seus números ao lado e tudo recalcula na hora.</div>' +
      '<table class="calc-table"><tbody>' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td class="mono">' + r[1] + '</td></tr>'; }).join('') + '</tbody></table>' +
      posHtml + '</div>';
  }

  function renderStrategy() {
    var ai = DATA.ai || {};
    var html = '';
    if (clean(ai.posicionamento)) html += '<div class="card-block"><div class="plan-block"><h4>Posicionamento &amp; valor</h4><p class="plan-p">' + esc(clean(ai.posicionamento)) + '</p></div></div>';
    if (clean(ai.ancoragem)) html += '<div class="card-block"><div class="plan-block"><h4>Como apresentar (ancoragem)</h4><p class="plan-p">' + esc(clean(ai.ancoragem)) + '</p></div></div>';

    var objs = Array.isArray(ai.objecoes) ? ai.objecoes.filter(function (o) { return clean(o && o.objecao) && clean(o && o.resposta); }) : [];
    if (objs.length) {
      html += '<div class="card-block"><div class="plan-block"><h4>Quebra de objeções</h4><div class="obj-list">' +
        objs.map(function (o) {
          return '<div class="obj"><div class="obj-q">“' + esc(clean(o.objecao)) + '”</div><div class="obj-a">' + esc(clean(o.resposta)) + '</div></div>';
        }).join('') + '</div></div></div>';
    }

    if (clean(ai.diagnostico)) html += '<div class="card-block diag"><div class="plan-block"><h4>Diagnóstico honesto</h4><p class="plan-p">' + esc(clean(ai.diagnostico)) + '</p></div></div>';

    var dicas = Array.isArray(ai.dicas) ? ai.dicas.map(clean).filter(Boolean) : [];
    if (dicas.length) {
      html += '<div class="card-block"><div class="plan-block"><h4>Dicas de precificação</h4><ul class="dica-list">' +
        dicas.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></div></div>';
    }
    return html;
  }

  function renderResults() {
    var b = DATA.brief;
    var E = computeEngine(b);
    var head =
      '<div class="res-head"><div class="res-title"><h2>Cardápio de preços — ' + esc(b.nicho) + '</h2>' +
        '<div class="res-sub">' + esc(MODE_LABELS[b.modelo]) + ' · preço-hora ' + money(E.precoHora, 0) + '/h · meta ' + money(E.receitaAlvo, 0) + '/mês</div></div>' +
        '<div class="res-actions">' +
          '<button class="btn-sm" id="btn-regen" title="Gerar novamente com a IA">↻ Regenerar</button>' +
          '<button class="btn-sm" id="btn-csv">⤓ CSV</button>' +
          '<button class="btn-sm" id="btn-copy">Copiar</button>' +
          '<button class="btn-sm primary" id="btn-pdf">Baixar PDF</button>' +
        '</div></div>';
    $('results').innerHTML = head + renderKpis(b, E) + renderMenu(b, E) + renderBastidores(b, E) + renderStrategy() +
      '<p class="disclaimer">Os preços são uma <strong>recomendação de planejamento</strong> a partir dos seus custos, sua meta e as premissas que você informou — ajuste com o seu contexto e o seu mercado. Precificação IA não consulta preços em tempo real nem conecta a nenhum sistema.</p>';
    wireResults();
  }

  // recompute numbers only (keeps the AI-written text; no LLM) — live edit from the brief
  function recompute() {
    if (!DATA) return;
    DATA.brief = readBrief();
    renderResults();
  }

  function wireResults() {
    var regen = $('btn-regen'); if (regen) regen.onclick = function () { generate(); };
    var csv = $('btn-csv'); if (csv) csv.onclick = exportCSV;
    var copy = $('btn-copy'); if (copy) copy.onclick = exportCopy;
    var pdf = $('btn-pdf'); if (pdf) pdf.onclick = function () { window.print(); };
  }

  // ============================================================ export
  function csvCell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
  function exportCSV() {
    if (!DATA) return;
    var b = DATA.brief, E = computeEngine(b);
    var lines = [];
    lines.push([csvCell('Precificação IA — Cardápio de preços'), '', '', ''].join(';'));
    lines.push([csvCell('Serviço/nicho'), csvCell(b.nicho), csvCell('Modelo'), csvCell(MODE_LABELS[b.modelo])].join(';'));
    lines.push([csvCell('Preço-hora recomendado'), csvCell(money(E.precoHora, 2)), csvCell('Preço-hora mínimo'), csvCell(money(E.custoHora, 2))].join(';'));
    lines.push([csvCell('Receita-alvo/mês'), csvCell(money(E.receitaAlvo, 0)), csvCell('Volume p/ meta'), csvCell(E.volume.meta + ' ' + E.volume.unidLabel)].join(';'));
    lines.push('');
    lines.push([csvCell('Pacote'), csvCell('Nome'), csvCell('Preço'), csvCell('Horas'), csvCell('Entregáveis')].join(';'));
    E.tiers.forEach(function (t, i) {
      var ai = aiPacote(t.key, i);
      var ents = Array.isArray(ai.entregaveis) ? ai.entregaveis.map(clean).filter(Boolean).join(' | ') : '';
      lines.push([csvCell(t.label), csvCell(clean(ai.nome) || t.label), csvCell(money(t.preco, 0) + (b.modelo === 'hora' ? (t.horas > 1 ? ' (' + t.horas + 'h)' : '/h') : unitSuffix(b))), csvCell(b.modelo === 'hora' ? (t.horas + 'h') : (Math.round(t.horas) + 'h')), csvCell(ents)].join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, 'precos-' + slug(b.nicho) + '.csv');
    toast('CSV exportado.');
  }
  function slug(s) { return (String(s || 'servico').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'servico').slice(0, 40); }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob); var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function exportCopy() {
    if (!DATA) return;
    var b = DATA.brief, E = computeEngine(b), ai = DATA.ai || {};
    var L = [];
    L.push('CARDÁPIO DE PREÇOS — ' + (b.nicho ? b.nicho.toUpperCase() : 'SERVIÇO'));
    L.push(MODE_LABELS[b.modelo] + ' · preço-hora recomendado ' + money(E.precoHora, 0) + '/h (mínimo ' + money(E.custoHora, 0) + '/h)');
    L.push('');
    E.tiers.forEach(function (t, i) {
      var p = aiPacote(t.key, i);
      var preco = money(t.preco, 0) + (b.modelo === 'hora' ? (t.horas > 1 ? ' (pacote ' + t.horas + 'h)' : '/hora') : unitSuffix(b));
      L.push((t.rec ? '★ ' : '') + t.label.toUpperCase() + ' — ' + (clean(p.nome) || t.label) + ' — ' + preco);
      if (clean(p.resumo)) L.push('  ' + clean(p.resumo));
      if (Array.isArray(p.entregaveis)) p.entregaveis.map(clean).filter(Boolean).forEach(function (e) { L.push('   • ' + e); });
      if (clean(p.ideal_para)) L.push('  Ideal para: ' + clean(p.ideal_para));
      L.push('');
    });
    L.push('PARA BATER SUA META (' + money(E.receitaAlvo, 0) + '/mês): ' + E.volume.meta + ' ' + E.volume.unidLabel + ' (capacidade: ' + E.volume.capacidade + ').');
    L.push('');
    if (clean(ai.posicionamento)) { L.push('POSICIONAMENTO:'); L.push(clean(ai.posicionamento)); L.push(''); }
    if (clean(ai.ancoragem)) { L.push('COMO APRESENTAR:'); L.push(clean(ai.ancoragem)); L.push(''); }
    if (Array.isArray(ai.objecoes) && ai.objecoes.length) {
      L.push('QUEBRA DE OBJEÇÕES:');
      ai.objecoes.forEach(function (o) { if (clean(o.objecao)) L.push('- "' + clean(o.objecao) + '": ' + clean(o.resposta)); });
      L.push('');
    }
    if (clean(ai.diagnostico)) { L.push('DIAGNÓSTICO:'); L.push(clean(ai.diagnostico)); L.push(''); }
    if (Array.isArray(ai.dicas) && ai.dicas.length) { L.push('DICAS:'); ai.dicas.map(clean).filter(Boolean).forEach(function (d) { L.push('- ' + d); }); L.push(''); }
    L.push('— Preços de planejamento a partir dos seus custos e sua meta. Gerado com Precificação IA (Gênesis IA).');
    copyText(L.join('\n'), function (ok) { toast(ok ? 'Cardápio copiado.' : 'Não foi possível copiar.', !ok); });
  }

  // ============================================================ live custo-hora hint + mode UI
  function updateCustoHoraLive() {
    var custos = Math.max(0, num($('in-custos').value, 0));
    var meta = Math.max(0, num($('in-meta').value, 0));
    var horas = Math.max(1, num($('in-horas').value, 120));
    var margem = Math.min(300, Math.max(0, num($('in-margem').value, 25)));
    var custoHora = (custos + meta) / horas;
    var precoHora = custoHora * (1 + margem / 100);
    var el = $('custohora-val'); if (el) el.textContent = money(precoHora, 0) + '/h';
    var lbl = document.querySelector('#custohora-live .chl-label'); if (lbl) lbl.textContent = 'Seu preço-hora recomendado agora';
  }
  function applyModeUI() {
    var modo = chipVal('chips-modelo') || 'projeto';
    var wrap = $('field-horasproj');
    var lbl = $('lbl-horasproj'), hint = $('hint-horasproj');
    var lblCd = $('lbl-custodir');
    if (modo === 'hora') {
      if (wrap) wrap.style.display = 'none';
    } else {
      if (wrap) wrap.style.display = '';
      if (modo === 'mensal') {
        if (lbl) lbl.textContent = 'Horas por mês (por cliente)';
        if (hint) hint.textContent = 'Quantas horas por mês você dedica a cada cliente.';
        if (lblCd) lblCd.innerHTML = 'Custo direto por mês <span style="opacity:.6">(opcional)</span>';
      } else {
        if (lbl) lbl.textContent = 'Horas por projeto';
        if (hint) hint.textContent = 'Quantas horas você leva para entregar um projeto.';
        if (lblCd) lblCd.innerHTML = 'Custo direto por projeto <span style="opacity:.6">(opcional)</span>';
      }
    }
  }

  // ============================================================ wiring
  function flagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint warn'; h.textContent = 'Configure sua chave de IA no ícone de chave (topo direito) para gerar o cardápio.'; }
  }
  function unflagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint'; h.textContent = 'O cálculo é instantâneo; a IA escreve os pacotes, o posicionamento e a quebra de objeções.'; }
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
      wireChips('chips-modelo', function () { applyModeUI(); recompute(); });
      ['in-custos', 'in-meta', 'in-horas', 'in-margem'].forEach(function (id) {
        var el = $(id); if (!el) return;
        el.addEventListener('input', function () { updateCustoHoraLive(); recompute(); });
      });
      ['in-nicho', 'in-horasproj', 'in-custodir', 'in-mercmin', 'in-mercmax'].forEach(function (id) {
        var el = $(id); if (!el) return;
        el.addEventListener('input', function () { recompute(); });
      });
      applyModeUI();
      updateCustoHoraLive();
      // studio model picker (COR-041 — every model <select> must be rendered)
      if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
      var gen = $('btn-gerar'); if (gen) gen.onclick = generate;
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

  window.PrecificacaoApp = { generate: generate }; // debug hook
})();
