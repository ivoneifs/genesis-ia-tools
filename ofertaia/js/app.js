/**
 * Oferta IA — offer / value-stack builder.
 *
 * BYOK: all AI calls run on the user's own key (OpenRouter preferred → one key
 * reaches every model; OpenAI native supported). Zero company keys. The browser
 * talks only to the model provider + the shared n8n webhooks (gate/feedback).
 *
 * Pipeline: briefing → callLLM (auto-reroll on bad JSON, COR-032; reasoning
 * budget capped, COR-034) → normalizeOffer (computes the value-stack totals
 * client-side, never trusts the model's arithmetic) → render voucher →
 * inline-edit / per-component regenerate → export (text / HTML / PNG).
 */
const App = (function () {
  'use strict';

  var CUR = {
    BRL: { symbol: 'R$', locale: 'pt-BR', code: 'BRL' },
    USD: { symbol: '$',  locale: 'en-US', code: 'USD' },
    EUR: { symbol: '€',  locale: 'de-DE', code: 'EUR' }
  };

  var state = {
    offer: null,
    input: null,
    currency: 'BRL',
    tone: 'Direto e objetivo',
    busy: false
  };

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // COR-015: LLM JSON sometimes emits literal "null"/"n/a" for empty fields.
  function cleanField(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/?a|none|nenhum[ao]?|-|—)$/i.test(s)) return '';
    return s;
  }
  function toast(msg, isErr) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, 3600);
  }
  function slugify(s, fallback) {
    var out = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    return out || fallback || 'oferta';
  }
  function curInfo() { return CUR[state.currency] || CUR.BRL; }
  function money(n) {
    var v = Number(n) || 0;
    var c = curInfo();
    try {
      return new Intl.NumberFormat(c.locale, {
        style: 'currency', currency: c.code, minimumFractionDigits: (v % 1 === 0 ? 0 : 2), maximumFractionDigits: 2
      }).format(v);
    } catch (e) {
      return c.symbol + ' ' + v.toFixed(2);
    }
  }
  // Parse an edited DISPLAY money string (locale-formatted, e.g. "R$ 2.000" or
  // "R$ 1.497,50") back to a number, honouring the active currency's thousands/
  // decimal convention (BRL/EUR: dot=thousands comma=decimal; USD: reverse).
  function parseMoney(str) {
    var s = String(str || '').replace(/[^\d.,]/g, '').trim();
    if (!s) return 0;
    if (state.currency === 'USD') {
      s = s.replace(/,/g, '');                 // commas are thousands
    } else { // BRL / EUR
      if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/\./g, '');           // lone dots are thousands → drop
    }
    var n = parseFloat(s);
    return isFinite(n) && n >= 0 ? n : 0;
  }
  // The price <input type="number"> always exposes a '.'-decimal value, so parse
  // it directly — never through the locale-aware parseMoney above.
  function parseNumberField(v) { var n = parseFloat(String(v || '').replace(',', '.')); return isFinite(n) && n >= 0 ? n : 0; }

  // ---------- briefing input ----------
  function readInput() {
    return {
      product: $('f-product').value.trim(),
      what: $('f-what').value.trim(),
      audience: $('f-audience').value.trim(),
      transformation: $('f-transformation').value.trim(),
      price: parseNumberField($('f-price').value),
      currency: state.currency,
      installments: $('f-installments').value.trim(),
      tone: state.tone
    };
  }

  // ---------- prompt builders ----------
  function priceLine(input) {
    return input.price > 0 ? (money(input.price) + ' (' + state.currency + ')') : 'a definir (sugira um preço coerente)';
  }

  function buildPrompt(input) {
    return [
      'Você é um copywriter sênior especialista em ofertas de resposta direta para o mercado brasileiro (estilo "oferta irresistível": promessa forte, stack de valor, bônus, garantia, urgência ética).',
      'Monte uma OFERTA COMPLETA e coerente para o produto abaixo. Escreva tudo em português do Brasil, específico para o produto e o público (sem clichês genéricos).',
      '',
      'BRIEFING:',
      '- Produto/serviço: ' + (input.product || '(não informado)'),
      '- O que é / o que entrega: ' + (input.what || '(não informado)'),
      '- Público-alvo: ' + (input.audience || '(não informado)'),
      '- Transformação prometida: ' + (input.transformation || '(não informada)'),
      '- Preço atual (o quanto a pessoa paga hoje): ' + priceLine(input),
      '- Moeda: ' + state.currency,
      '- Tom de voz: ' + input.tone,
      '',
      'REGRAS DO STACK DE VALOR:',
      '- "value_stack": de 4 a 6 COMPONENTES que somados formam a entrega principal (módulos, etapas, materiais, suporte). Cada um com um "value" (valor percebido em ' + state.currency + ', APENAS número, sem símbolo).',
      '- "bonuses": de 2 a 4 BÔNUS complementares, cada um com "value" (número).',
      '- Os valores percebidos devem ser realistas porém ANCORADORES: a soma de todos os "value" (stack + bônus) deve ficar entre 4x e 10x o preço atual, para criar uma âncora forte. Não invente valores absurdos.',
      '- NÃO calcule o total nem o desconto — o sistema soma os valores automaticamente.',
      '',
      'RESPONDA APENAS com um objeto JSON válido (sem markdown, sem comentários, sem texto fora do JSON), neste formato EXATO:',
      '{',
      '  "headline": "manchete principal da oferta, focada no benefício/transformação (máx ~90 caracteres)",',
      '  "promise": "promessa central em 1-2 frases (o que a pessoa conquista)",',
      '  "value_stack": [ {"name": "nome do componente", "desc": "o que é / o que resolve em 1 frase", "value": 497} ],',
      '  "bonuses": [ {"name": "nome do bônus", "desc": "benefício do bônus em 1 frase", "value": 197} ],',
      '  "guarantee": {"title": "título curto da garantia", "text": "texto da garantia (risco revertido) em 1-2 frases"},',
      '  "urgency": "gatilho de urgência/escassez ético e específico em 1 frase",',
      '  "cta": "texto curto do botão de ação (máx ~28 caracteres)",',
      '  "one_line": "a oferta resumida em UMA frase (você recebe X para conseguir Y)"',
      '}'
    ].join('\n');
  }

  function buildRegenPrompt(section, input, offer) {
    var ctx = [
      'Contexto da oferta (produto: ' + (input.product || '-') + '; público: ' + (input.audience || '-') +
        '; transformação: ' + (input.transformation || '-') + '; tom: ' + input.tone + '; moeda: ' + state.currency + ').',
      'Mantenha coerência com o restante da oferta. Português do Brasil. Responda APENAS com JSON válido, sem markdown.'
    ];
    if (section === 'headline')
      return ctx.concat(['Gere uma NOVA manchete (headline) diferente da atual ("' + (offer.headline || '') + '").',
        'Formato: {"headline": "..."}']).join('\n');
    if (section === 'promise')
      return ctx.concat(['Gere uma NOVA promessa central diferente da atual.',
        'Formato: {"promise": "..."}']).join('\n');
    if (section === 'urgency')
      return ctx.concat(['Gere um NOVO gatilho de urgência/escassez ético e específico, diferente do atual.',
        'Formato: {"urgency": "..."}']).join('\n');
    if (section === 'guarantee')
      return ctx.concat(['Gere uma NOVA garantia (reversão de risco) diferente da atual.',
        'Formato: {"guarantee": {"title": "...", "text": "..."}}']).join('\n');
    if (section === 'value_stack')
      return ctx.concat(['Gere um NOVO value_stack (4 a 6 componentes) para a entrega principal, diferente do atual.',
        'Cada componente: {"name","desc","value"} com value APENAS número em ' + state.currency + '. A soma (com os bônus existentes) deve ancorar 4x-10x o preço.',
        'Formato: {"value_stack": [{"name":"...","desc":"...","value":497}]}']).join('\n');
    if (section === 'bonuses')
      return ctx.concat(['Gere uma NOVA lista de bônus (2 a 4), diferente da atual.',
        'Cada bônus: {"name","desc","value"} com value APENAS número em ' + state.currency + '.',
        'Formato: {"bonuses": [{"name":"...","desc":"...","value":197}]}']).join('\n');
    return '';
  }

  // ---------- LLM call (COR-032 reroll + COR-034 reasoning budget) ----------
  async function callLLM(prompt, maxTokens) {
    var active = ApiKeyManager.getActiveKey();
    if (!active) throw new Error('Nenhuma chave de API configurada. Clique no ícone de chave no topo.');

    var endpoint, model, headers = { 'Content-Type': 'application/json' };
    var selected = ApiKeyManager.getModel();
    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      model = selected;
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Oferta IA';
    } else { // openai native fallback
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = selected.indexOf('openai/') === 0 ? selected.replace('openai/', '') : 'gpt-5.5';
      headers['Authorization'] = 'Bearer ' + active.key;
    }

    var sys = 'Você responde SOMENTE com JSON válido, sem markdown e sem texto fora do objeto JSON.';

    function buildBody(strict) {
      var strictMsg = 'ATENÇÃO: sua resposta anterior NÃO era um JSON válido. Responda novamente com APENAS o objeto JSON completo e válido — sem markdown, sem comentários, sem texto fora do JSON, e com as aspas internas em formato tipográfico (“ ”), nunca aspas duplas retas.';
      var messages = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
      if (strict) messages.push({ role: 'user', content: strictMsg });
      var body = { model: model, messages: messages, temperature: strict ? 0.4 : 0.7, max_tokens: maxTokens || 4000 };
      if (active.service === 'openrouter') body.reasoning = { effort: 'low' };
      return body;
    }

    async function doFetch(strict) {
      var res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(buildBody(strict)) });
      if (!res.ok) {
        var detail = '';
        try { var e = await res.json(); detail = (e.error && (e.error.message || e.error)) || ''; } catch (_) {}
        if (res.status === 401 || res.status === 403) throw new Error('Chave de API inválida, sem permissão ou sem créditos.');
        if (res.status === 429) throw new Error('Limite de uso atingido no provedor. Aguarde um instante e tente novamente.');
        throw new Error('Erro do provedor (' + res.status + '). ' + (typeof detail === 'string' ? detail : ''));
      }
      var json = await res.json();
      return json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    }

    function exec(strict) {
      return (window.RateLimiter && typeof RateLimiter.executeWithLimit === 'function')
        ? RateLimiter.executeWithLimit('generate-offer', function () { return doFetch(strict); })
        : doFetch(strict);
    }

    var content = await exec(false);
    if (!content) throw new Error('Resposta vazia do modelo. Tente outro modelo.');
    try { return parseJSON(content); }
    catch (firstErr) {
      content = await exec(true);
      if (!content) throw firstErr;
      return parseJSON(content);
    }
  }

  // ---------- robust JSON extraction (repair ladder) ----------
  function stripToObject(text) {
    var t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a > -1 && b > -1) t = t.slice(a, b + 1);
    return t;
  }
  function repairJSONStrings(t) {
    var out = '', inStr = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
      if (ch === '\\') { out += ch + (t[i + 1] || ''); i++; continue; }
      if (ch === '"') {
        var j = i + 1; while (j < t.length && (t[j] === ' ' || t[j] === '\t' || t[j] === '\n' || t[j] === '\r')) j++;
        var nx = t[j];
        if (nx === undefined || nx === ':' || nx === ',' || nx === '}' || nx === ']') { out += '"'; inStr = false; }
        else { out += '\\"'; }
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    }
    return out;
  }
  function parseJSON(text) {
    var t = stripToObject(text);
    var noTrail = function (s) { return s.replace(/,\s*([}\]])/g, '$1'); };
    var attempts = [t, noTrail(t), repairJSONStrings(t), noTrail(repairJSONStrings(t))];
    for (var i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* next */ }
    }
    throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
  }

  // ---------- normalize ----------
  function normItem(x) {
    var o = x || {};
    return { name: cleanField(o.name) || 'Item', desc: cleanField(o.desc), value: Math.max(0, Number(o.value) || 0) };
  }
  function normalizeOffer(raw, input) {
    var o = raw || {};
    var stack = arr(o.value_stack).map(normItem).filter(function (x) { return x.name; });
    var bonuses = arr(o.bonuses).map(normItem).filter(function (x) { return x.name; });
    var g = o.guarantee || {};
    return {
      headline: cleanField(o.headline) || 'Sua transformação começa aqui',
      promise: cleanField(o.promise),
      value_stack: stack.length ? stack : [{ name: 'Acesso principal', desc: '', value: Math.max(input.price, 1) }],
      bonuses: bonuses,
      guarantee: { title: cleanField(g.title) || 'Garantia de satisfação', text: cleanField(g.text) },
      urgency: cleanField(o.urgency),
      cta: cleanField(o.cta) || 'Quero garantir minha vaga',
      one_line: cleanField(o.one_line),
      price: input.price,
      installments: input.installments
    };
  }

  function stackTotal(offer) {
    var sum = 0;
    offer.value_stack.forEach(function (x) { sum += Number(x.value) || 0; });
    offer.bonuses.forEach(function (x) { sum += Number(x.value) || 0; });
    return sum;
  }

  // ---------- render ----------
  var ICON_REGEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';

  function regenBtn(section) {
    return '<button class="regen-btn" data-regen="' + section + '" type="button">' + ICON_REGEN + 'Regerar</button>';
  }
  function ed(attrs) { return 'contenteditable="true" spellcheck="false" ' + attrs; }

  function stackRowHTML(item, idx, isBonus) {
    var k = isBonus ? 'bonus' : 'stack';
    return '<div class="stack-row' + (isBonus ? ' bonus' : '') + '">' +
      '<div>' +
        '<div class="stack-name"><span ' + ed('data-edit="' + k + '" data-i="' + idx + '" data-k="name"') + '>' + esc(item.name) + '</span>' +
          (isBonus ? '<span class="tag">Bônus</span>' : '') + '</div>' +
        (item.desc || !isBonus ? '<div class="stack-desc" ' + ed('data-edit="' + k + '" data-i="' + idx + '" data-k="desc"') + '>' + esc(item.desc) + '</div>' : '') +
      '</div>' +
      '<div class="stack-val"><span ' + ed('data-edit="' + k + 'val" data-i="' + idx + '"') + '>' + money(item.value) + '</span></div>' +
    '</div>';
  }

  function render(offer) {
    var total = stackTotal(offer);
    var today = Number(offer.price) || 0;
    var savings = (total > 0 && today > 0 && total > today) ? Math.round((total - today) / total * 100) : 0;
    var serial = 'OF-' + slugify(offer.headline, 'oferta').toUpperCase().replace(/-/g, '').slice(0, 6) +
      '-' + String(total).slice(0, 4);

    var rows = offer.value_stack.map(function (it, i) { return stackRowHTML(it, i, false); }).join('') +
      offer.bonuses.map(function (it, i) { return stackRowHTML(it, i, true); }).join('');

    var priceTodayHTML = today > 0
      ? '<div class="price-anchor mono">De ' + money(total) + '</div>' +
        '<div class="price-today"><span class="cur">por</span>' + money(today) + '</div>' +
        (offer.installments ? '<div class="price-installments">ou ' + esc(offer.installments) + '</div>' : '')
      : '<div class="price-today" style="font-size:1.3rem;">Defina o preço no briefing</div>' +
        '<div class="price-installments">Valor total montado: ' + money(total) + '</div>';

    var stampHTML = savings > 0
      ? '<div class="savings-stamp"><span class="big">-' + savings + '%</span><span class="small">Economia</span></div>'
      : '';

    var html =
      '<article class="voucher" id="voucher">' +
        '<div class="voucher-top">' +
          '<span class="voucher-serial mono">' + esc(serial) + '</span>' +
          '<span class="tlabel">Oferta · Comunidade Gênesis IA</span>' +
          '<h2 class="voucher-headline" ' + ed('data-edit="headline"') + '>' + esc(offer.headline) + '</h2>' +
          (offer.promise ? '<p class="voucher-promise" ' + ed('data-edit="promise"') + '>' + esc(offer.promise) + '</p>' : '') +
        '</div>' +
        '<div class="voucher-body">' +

          '<div class="vsec">' +
            '<div class="vsec-head"><span class="tlabel">Stack de valor</span>' + regenBtn('value_stack') + '</div>' +
            '<div class="stack">' + rows +
              '<div class="stack-total"><span>Valor total da entrega</span><span class="stack-val mono">' + money(total) + '</span></div>' +
            '</div>' +
            (offer.bonuses.length ? '<div style="text-align:right;margin-top:6px;">' + regenBtn('bonuses') + '</div>' : '') +
          '</div>' +

          '<div class="vsec">' +
            '<div class="price-stub">' +
              '<div class="price-left">' + priceTodayHTML + '</div>' +
              stampHTML +
            '</div>' +
          '</div>' +

          '<div class="vsec">' +
            '<div class="vsec-head"><span class="tlabel">Garantia</span>' + regenBtn('guarantee') + '</div>' +
            '<div class="guarantee">' +
              '<div class="seal" aria-hidden="true">Risco<br>Zero</div>' +
              '<div><div class="guarantee-title" ' + ed('data-edit="g.title"') + '>' + esc(offer.guarantee.title) + '</div>' +
                '<div class="guarantee-text" ' + ed('data-edit="g.text"') + '>' + esc(offer.guarantee.text) + '</div></div>' +
            '</div>' +
          '</div>' +

          (offer.urgency ?
          '<div class="vsec">' +
            '<div class="vsec-head"><span class="tlabel">Urgência</span>' + regenBtn('urgency') + '</div>' +
            '<div class="urgency" ' + ed('data-edit="urgency"') + '>' + esc(offer.urgency) + '</div>' +
          '</div>' : '') +

          '<div class="offer-cta"><span class="cta-btn" ' + ed('data-edit="cta"') + '>' + esc(offer.cta) + '</span></div>' +
          (offer.one_line ? '<p class="one-line" ' + ed('data-edit="one_line"') + '>' + esc(offer.one_line) + '</p>' : '') +
        '</div>' +
      '</article>' +

      '<div class="export-bar">' +
        '<span class="tlabel">Exportar oferta</span>' +
        '<button class="btn-ticket" data-export="text" type="button">' + iconCopy() + 'Copiar texto</button>' +
        '<button class="btn-ticket" data-export="html" type="button">' + iconCode() + 'Baixar HTML</button>' +
        '<button class="btn-ticket" data-export="copyhtml" type="button">' + iconCopy() + 'Copiar HTML</button>' +
        '<button class="btn-ticket" data-export="png" type="button">' + iconImg() + 'Baixar imagem (PNG)</button>' +
      '</div>';

    $('preview').innerHTML = html;
  }

  function iconCopy() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function iconCode() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'; }
  function iconImg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20"/></svg>'; }

  // ---------- generate ----------
  function setBusy(b) {
    state.busy = b;
    var btn = $('generate-btn');
    if (btn) {
      btn.disabled = b;
      btn.querySelector('.btn-text').style.display = b ? 'none' : '';
      btn.querySelector('.btn-loading').style.display = b ? '' : 'none';
    }
  }
  function showLoading() {
    $('preview').innerHTML = '<div class="loading-state"><div class="ticket-spinner"></div>' +
      '<p class="tlabel">Emitindo sua oferta…</p><p style="color:var(--text-muted);margin-top:6px;">Montando stack de valor, garantia e âncora de preço.</p></div>';
  }

  async function generate() {
    if (state.busy) return;
    var input = readInput();
    if (!input.product || !input.audience) {
      toast('Preencha ao menos o produto e o público-alvo.', true);
      return;
    }
    if (!ApiKeyManager.hasRequiredKeys()) {
      toast('Configure sua chave de API primeiro (ícone de chave no topo).', true);
      ApiKeyManager.renderInputs('modal-key-inputs');
      $('key-modal').style.display = 'flex';
      return;
    }
    state.input = input;
    setBusy(true);
    showLoading();
    try {
      var raw = await callLLM(buildPrompt(input), 4000);
      state.offer = normalizeOffer(raw, input);
      render(state.offer);
      toast('Oferta emitida! Edite qualquer parte ou regenere por seção.');
    } catch (err) {
      $('preview').innerHTML = '<div class="empty-state"><h3>Não foi possível emitir</h3><p>' + esc(err.message || 'Erro inesperado.') + '</p></div>';
      toast(err.message || 'Erro ao gerar.', true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- per-component regenerate ----------
  async function regenSection(section) {
    if (state.busy || !state.offer || !state.input) return;
    var btns = document.querySelectorAll('[data-regen="' + section + '"]');
    btns.forEach(function (b) { b.disabled = true; });
    state.busy = true;
    try {
      var raw = await callLLM(buildRegenPrompt(section, state.input, state.offer), 2500);
      if (section === 'headline') state.offer.headline = cleanField(raw.headline) || state.offer.headline;
      else if (section === 'promise') state.offer.promise = cleanField(raw.promise);
      else if (section === 'urgency') state.offer.urgency = cleanField(raw.urgency);
      else if (section === 'guarantee') {
        var g = raw.guarantee || {};
        state.offer.guarantee = { title: cleanField(g.title) || state.offer.guarantee.title, text: cleanField(g.text) };
      } else if (section === 'value_stack') {
        var st = arr(raw.value_stack).map(normItem).filter(function (x) { return x.name; });
        if (st.length) state.offer.value_stack = st;
      } else if (section === 'bonuses') {
        var bo = arr(raw.bonuses).map(normItem).filter(function (x) { return x.name; });
        state.offer.bonuses = bo;
      }
      render(state.offer);
      toast('Seção regenerada.');
    } catch (err) {
      toast(err.message || 'Erro ao regenerar.', true);
      btns.forEach(function (b) { b.disabled = false; });
    } finally {
      state.busy = false;
    }
  }

  // ---------- inline editing (event delegation) ----------
  function applyTextEdit(el) {
    var key = el.getAttribute('data-edit');
    var txt = el.textContent.trim();
    var o = state.offer;
    if (!o) return;
    if (key === 'headline') o.headline = txt;
    else if (key === 'promise') o.promise = txt;
    else if (key === 'urgency') o.urgency = txt;
    else if (key === 'cta') o.cta = txt;
    else if (key === 'one_line') o.one_line = txt;
    else if (key === 'g.title') o.guarantee.title = txt;
    else if (key === 'g.text') o.guarantee.text = txt;
    else if (key === 'stack' || key === 'bonus') {
      var listA = key === 'stack' ? o.value_stack : o.bonuses;
      var iA = parseInt(el.getAttribute('data-i'), 10);
      var kA = el.getAttribute('data-k');
      if (listA[iA]) listA[iA][kA] = txt;
    }
  }
  function applyValueEdit(el) {
    var key = el.getAttribute('data-edit');
    var list = key === 'stackval' ? state.offer.value_stack : state.offer.bonuses;
    var i = parseInt(el.getAttribute('data-i'), 10);
    if (list[i]) { list[i].value = parseMoney(el.textContent); render(state.offer); }
  }

  function wirePreview() {
    var pv = $('preview');
    pv.addEventListener('input', function (e) {
      var t = e.target.closest('[data-edit]');
      if (!t) return;
      var k = t.getAttribute('data-edit');
      if (k !== 'stackval' && k !== 'bonusval') applyTextEdit(t);
    });
    pv.addEventListener('focusout', function (e) {
      var t = e.target.closest('[data-edit]');
      if (!t) return;
      var k = t.getAttribute('data-edit');
      if (k === 'stackval' || k === 'bonusval') applyValueEdit(t);
    });
    pv.addEventListener('keydown', function (e) {
      var t = e.target.closest('[data-edit]');
      if (t && e.key === 'Enter' && t.tagName !== 'DIV') { /* allow */ }
      // prevent newline in single-line value cells
      var k = t && t.getAttribute('data-edit');
      if (t && (k === 'stackval' || k === 'bonusval' || k === 'cta' || k === 'headline') && e.key === 'Enter') {
        e.preventDefault(); t.blur();
      }
    });
    pv.addEventListener('click', function (e) {
      var rb = e.target.closest('[data-regen]');
      if (rb) { regenSection(rb.getAttribute('data-regen')); return; }
      var xb = e.target.closest('[data-export]');
      if (xb) { doExport(xb.getAttribute('data-export')); }
    });
  }

  // ---------- exports ----------
  function offerToText(o) {
    var total = stackTotal(o);
    var lines = [];
    lines.push(o.headline.toUpperCase());
    if (o.promise) lines.push('', o.promise);
    lines.push('', '— STACK DE VALOR —');
    o.value_stack.forEach(function (x) { lines.push('• ' + x.name + (x.desc ? ' — ' + x.desc : '') + '  (' + money(x.value) + ')'); });
    o.bonuses.forEach(function (x) { lines.push('• [BÔNUS] ' + x.name + (x.desc ? ' — ' + x.desc : '') + '  (' + money(x.value) + ')'); });
    lines.push('', 'VALOR TOTAL: ' + money(total));
    if (o.price > 0) {
      lines.push('De ' + money(total) + ' por apenas ' + money(o.price) + (o.installments ? ' (' + o.installments + ')' : ''));
      if (total > o.price) lines.push('Economia de ' + Math.round((total - o.price) / total * 100) + '%');
    }
    lines.push('', '— GARANTIA —', o.guarantee.title + (o.guarantee.text ? ': ' + o.guarantee.text : ''));
    if (o.urgency) lines.push('', '⏳ ' + o.urgency);
    lines.push('', '👉 ' + o.cta);
    if (o.one_line) lines.push('', o.one_line);
    return lines.join('\n');
  }

  function offerToHTML(o) {
    var total = stackTotal(o);
    var savings = (total > o.price && o.price > 0) ? Math.round((total - o.price) / total * 100) : 0;
    function row(x, b) {
      return '<tr><td style="padding:10px 12px;border-bottom:1px dashed #d8c9a8;">' +
        '<strong>' + esc(x.name) + (b ? ' <span style="color:#a8842c;font-size:11px;">[BÔNUS]</span>' : '') + '</strong>' +
        (x.desc ? '<br><span style="color:#5c5443;font-size:13px;">' + esc(x.desc) + '</span>' : '') +
        '</td><td style="padding:10px 12px;border-bottom:1px dashed #d8c9a8;text-align:right;font-family:monospace;white-space:nowrap;">' + money(x.value) + '</td></tr>';
    }
    var rows = o.value_stack.map(function (x) { return row(x, false); }).join('') +
      o.bonuses.map(function (x) { return row(x, true); }).join('');
    return '' +
'<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#1d241f;background:#fbf6ea;border:2px solid #1f3a28;border-radius:10px;overflow:hidden;">' +
  '<div style="background:#15301f;color:#f4efe2;padding:22px 26px;">' +
    '<div style="color:#a8842c;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Oferta</div>' +
    '<h2 style="margin:8px 0;color:#fff;font-size:24px;text-transform:uppercase;">' + esc(o.headline) + '</h2>' +
    (o.promise ? '<p style="margin:0;color:#e6e1d2;">' + esc(o.promise) + '</p>' : '') +
  '</div>' +
  '<div style="padding:24px 26px;">' +
    '<div style="color:#0f5132;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Stack de valor</div>' +
    '<table style="width:100%;border-collapse:collapse;border:1px solid #d8c9a8;border-radius:6px;overflow:hidden;">' + rows +
      '<tr><td style="padding:12px;background:#15301f;color:#fff;text-transform:uppercase;font-weight:bold;">Valor total</td>' +
      '<td style="padding:12px;background:#15301f;color:#a8842c;text-align:right;font-family:monospace;font-weight:bold;">' + money(total) + '</td></tr>' +
    '</table>' +
    (o.price > 0 ? '<div style="margin-top:16px;padding:16px;border:2px solid #0b3a24;border-radius:6px;background:#fffdf6;text-align:center;">' +
      '<div style="text-decoration:line-through;color:#8a8068;font-family:monospace;">De ' + money(total) + '</div>' +
      '<div style="font-size:30px;font-weight:800;color:#0b3a24;">por ' + money(o.price) + '</div>' +
      (o.installments ? '<div style="color:#5c5443;">ou ' + esc(o.installments) + '</div>' : '') +
      (savings ? '<div style="display:inline-block;margin-top:8px;border:2px solid #b3261e;color:#b3261e;border-radius:6px;padding:4px 10px;font-weight:bold;">ECONOMIA DE ' + savings + '%</div>' : '') +
    '</div>' : '') +
    '<div style="margin-top:16px;padding:14px;border:1px solid #a8842c;background:#faf3e2;border-radius:6px;">' +
      '<strong style="color:#0b3a24;">' + esc(o.guarantee.title) + '</strong>' +
      (o.guarantee.text ? '<div style="color:#5c5443;font-size:14px;margin-top:3px;">' + esc(o.guarantee.text) + '</div>' : '') +
    '</div>' +
    (o.urgency ? '<p style="margin-top:16px;text-align:center;color:#b3261e;border:1px dashed #b3261e;border-radius:6px;padding:10px;">' + esc(o.urgency) + '</p>' : '') +
    '<div style="text-align:center;margin-top:18px;"><span style="display:inline-block;background:#b3261e;color:#fff;padding:14px 30px;border-radius:6px;font-weight:bold;text-transform:uppercase;">' + esc(o.cta) + '</span></div>' +
    (o.one_line ? '<p style="text-align:center;font-style:italic;color:#5c5443;margin-top:14px;">' + esc(o.one_line) + '</p>' : '') +
  '</div>' +
'</div>';
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  async function copyText(txt) {
    try { await navigator.clipboard.writeText(txt); toast('Copiado para a área de transferência.'); }
    catch (e) {
      var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copiado.'); } catch (_) { toast('Não foi possível copiar.', true); }
      document.body.removeChild(ta);
    }
  }

  function doExport(kind) {
    var o = state.offer;
    if (!o) return;
    var base = slugify(o.headline, 'oferta');
    if (kind === 'text') return copyText(offerToText(o));
    if (kind === 'html') {
      var doc = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>' + esc(o.headline) + '</title></head><body style="margin:0;padding:24px;background:#e7dcc6;">' + offerToHTML(o) + '</body></html>';
      return download(base + '.html', doc, 'text/html;charset=utf-8');
    }
    if (kind === 'copyhtml') return copyText(offerToHTML(o));
    if (kind === 'png') return exportPNG(o, base);
  }

  // ---------- PNG (canvas value-stack voucher) ----------
  function exportPNG(o, base) {
    try {
      var scale = 2, W = 720;
      var pad = 36, lineH = 0;
      var c = document.createElement('canvas');
      var ctx = c.getContext('2d');
      // measure pass: estimate height
      var items = o.value_stack.map(function (x) { return { x: x, b: false }; })
        .concat(o.bonuses.map(function (x) { return { x: x, b: true }; }));
      var total = stackTotal(o);

      function wrap(text, maxW, font) {
        ctx.font = font;
        var words = String(text).split(/\s+/), lines = [], cur = '';
        for (var i = 0; i < words.length; i++) {
          var test = cur ? cur + ' ' + words[i] : words[i];
          if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; }
          else cur = test;
        }
        if (cur) lines.push(cur);
        return lines;
      }

      // compute height
      var bodyFont = '15px Arial';
      var descFont = '13px Arial';
      var h = 0;
      h += 118; // header
      h += 44;  // stack label
      var rowHeights = items.map(function (it) {
        var nl = wrap(it.x.name + (it.b ? '  [BÔNUS]' : ''), W - pad * 2 - 120, 'bold 15px Arial').length;
        var dl = it.x.desc ? wrap(it.x.desc, W - pad * 2 - 120, descFont).length : 0;
        return 16 + nl * 19 + dl * 17 + 10;
      });
      rowHeights.forEach(function (r) { h += r; });
      h += 46; // total row
      h += o.price > 0 ? 110 : 70; // price
      h += 86; // guarantee
      h += pad * 2;

      c.width = W * scale; c.height = h * scale;
      ctx.scale(scale, scale);

      // bg ticket
      ctx.fillStyle = '#fbf6ea'; ctx.fillRect(0, 0, W, h);
      ctx.strokeStyle = '#1f3a28'; ctx.lineWidth = 3; ctx.strokeRect(3, 3, W - 6, h - 6);

      // header
      ctx.fillStyle = '#15301f'; ctx.fillRect(0, 0, W, 104);
      ctx.fillStyle = '#a8842c'; ctx.font = 'bold 12px Arial';
      ctx.fillText('OFERTA · COMUNIDADE GÊNESIS IA', pad, 30);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px Arial';
      var hl = wrap(o.headline.toUpperCase(), W - pad * 2, 'bold 24px Arial').slice(0, 2);
      var y = 58;
      hl.forEach(function (ln) { ctx.fillText(ln, pad, y); y += 28; });

      // stack label
      y = 104 + 34;
      ctx.fillStyle = '#0f5132'; ctx.font = 'bold 13px Arial';
      ctx.fillText('STACK DE VALOR', pad, y);
      y += 14;

      // rows
      items.forEach(function (it, idx) {
        var startY = y;
        ctx.fillStyle = '#1d241f'; ctx.font = 'bold 15px Arial';
        var nameLines = wrap(it.x.name + (it.b ? '  [BÔNUS]' : ''), W - pad * 2 - 130, 'bold 15px Arial');
        nameLines.forEach(function (ln) { y += 19; ctx.fillText(ln, pad, y); });
        if (it.x.desc) {
          ctx.fillStyle = '#5c5443'; ctx.font = descFont;
          wrap(it.x.desc, W - pad * 2 - 130, descFont).forEach(function (ln) { y += 17; ctx.fillText(ln, pad, y); });
        }
        // value right-aligned
        ctx.fillStyle = '#0b3a24'; ctx.font = 'bold 15px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(money(it.x.value), W - pad, startY + 19);
        ctx.textAlign = 'left';
        y += 14;
        // divider
        ctx.strokeStyle = '#d8c9a8'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); ctx.setLineDash([]);
      });

      // total
      y += 8;
      ctx.fillStyle = '#15301f'; ctx.fillRect(pad, y, W - pad * 2, 34);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 14px Arial';
      ctx.fillText('VALOR TOTAL DA ENTREGA', pad + 12, y + 22);
      ctx.fillStyle = '#a8842c'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'right';
      ctx.fillText(money(total), W - pad - 12, y + 22); ctx.textAlign = 'left';
      y += 34 + 22;

      // price
      if (o.price > 0) {
        ctx.fillStyle = '#8a8068'; ctx.font = '14px monospace';
        ctx.fillText('De ' + money(total), pad, y);
        ctx.fillStyle = '#0b3a24'; ctx.font = 'bold 30px Arial';
        ctx.fillText('por ' + money(o.price), pad, y + 32);
        if (total > o.price) {
          var sv = Math.round((total - o.price) / total * 100);
          ctx.strokeStyle = '#b3261e'; ctx.lineWidth = 2.5;
          ctx.strokeRect(W - pad - 120, y - 4, 120, 44);
          ctx.fillStyle = '#b3261e'; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center';
          ctx.fillText('-' + sv + '%', W - pad - 60, y + 18);
          ctx.font = 'bold 9px Arial'; ctx.fillText('ECONOMIA', W - pad - 60, y + 32); ctx.textAlign = 'left';
        }
        y += 56;
      } else {
        ctx.fillStyle = '#5c5443'; ctx.font = '15px Arial';
        ctx.fillText('Defina o preço no briefing para mostrar a âncora.', pad, y + 10);
        y += 30;
      }

      // guarantee
      y += 18;
      ctx.strokeStyle = '#a8842c'; ctx.lineWidth = 1.5; ctx.strokeRect(pad, y, W - pad * 2, 60);
      ctx.fillStyle = '#0b3a24'; ctx.font = 'bold 15px Arial';
      ctx.fillText(o.guarantee.title, pad + 12, y + 24);
      if (o.guarantee.text) {
        ctx.fillStyle = '#5c5443'; ctx.font = '13px Arial';
        var gt = wrap(o.guarantee.text, W - pad * 2 - 24, '13px Arial').slice(0, 2);
        var gy = y + 42; gt.forEach(function (ln) { ctx.fillText(ln, pad + 12, gy); gy += 16; });
      }

      var data = c.toDataURL('image/png');
      var a = document.createElement('a'); a.href = data; a.download = base + '-stack.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('Imagem PNG baixada.');
    } catch (e) {
      toast('Não foi possível gerar a imagem.', true);
    }
  }

  // ---------- tone chips ----------
  function wireTone() {
    var chips = document.querySelectorAll('#tone-chips .chip');
    function select(chip) {
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      state.tone = chip.getAttribute('data-tone');
    }
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () { select(chip); });
      chip.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(chip); }
      });
    });
  }

  // ---------- init ----------
  var _wired = false;
  function init() {
    var session = (window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession()) || null;
    var nameEl = $('user-name');
    if (nameEl && session && session.name) nameEl.textContent = session.name;

    if (_wired) return;
    _wired = true;

    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
    $('f-currency').addEventListener('change', function () { state.currency = this.value; if (state.offer) render(state.offer); });
    wireTone();
    wirePreview();
    $('brief-form').addEventListener('submit', function (e) { e.preventDefault(); generate(); });
    console.log('Oferta IA initialized');
  }

  return { init: init };
})();

(function () {
  var done = false;
  function go() { if (done) return; var s = window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession(); if (s) { done = true; App.init(); } }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 150); });
})();
