/* ============================================================
   Anúncios IA — app logic
   BYOK (user's own key: OpenRouter, native Google Gemini, or native OpenAI). The tool asks the
   model for a strict JSON campaign, then renders it into: (a) a live feed-ad mockup
   inside a billboard frame, (b) an organized copy kit with char counters, (c) an
   exportable brief. Nothing is ever sent to our servers except the n8n gate calls.
   ============================================================ */
(function () {
  'use strict';

  // ---- localStorage slots (snake_case values to dodge the gitleaks KEY='literal' heuristic, COR-025) ----
  var CAMPAIGN_STORE = 'anuncios_campaign_store';
  var BRIEF_STORE = 'anuncios_brief_store';

  // token budgets — generous per COR-034 (reasoning + content must both fit). A 3-angle
  // campaign is a medium JSON: 8000 fits reasoning-model overhead + content comfortably.
  var MAXTOK_FULL = 8000;
  var MAXTOK_REGEN = 4000;

  // ---- platform config (feed chrome + Ads-Manager-style char limits) ----
  var PLATFORMS = {
    meta_feed:     { label: 'FEED · META',      kind: 'meta',   img: 'square', limits: { headline: 40, primaria: 125, descricao: 30 } },
    stories:       { label: 'STORIES · META',   kind: 'meta',   img: 'story',  limits: { headline: 40, primaria: 125, descricao: 30 } },
    reels:         { label: 'REELS · META',      kind: 'meta',   img: 'story',  limits: { headline: 40, primaria: 125, descricao: 30 } },
    google_search: { label: 'GOOGLE · SEARCH',   kind: 'google', img: 'none',   limits: { headline: 30, primaria: 90,  descricao: 90 } }
  };

  var CTA_LIST = 'Saiba mais, Comprar agora, Cadastre-se, Enviar mensagem, Fale no WhatsApp, Baixar, Reservar, Ver oferta, Assine já, Solicitar orçamento';

  // ---- state ----
  var state = {
    data: null,          // { oferta, publico, objetivo, plataforma, angulos:[...] }
    angleIdx: 0,
    hlIdx: [],           // current headline index per angle
    brief: {},
    generating: false
  };

  // ============================================================ helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clean(v) { // COR-015 — normalize LLM null-like strings to ''
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—|nao informado|não informado)$/i.test(s)) return '';
    return s;
  }
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.className = 'toast' + (isErr ? ' error' : ''); }, 2600);
  }
  function copyText(str, done) {
    function ok() { if (done) done(true); }
    function fail() { if (done) done(false); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(ok).catch(function () { legacy(); });
    } else { legacy(); }
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = str; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        var okc = document.execCommand('copy');
        document.body.removeChild(ta);
        okc ? ok() : fail();
      } catch (e) { fail(); }
    }
  }

  // ============================================================ LLM
  function fetchContent(messages, active, temperature, noReasoning, maxTokens) {
    var model = ApiKeyManager.getModel();

    // ---- native Google Gemini (AI Studio) path ----
    // Lets a member use a FREE Google AI Studio key directly (no OpenRouter credit
    // needed). Picker Google ids ("google/gemini-3.5-flash") map to the native model
    // name by stripping the "google/" prefix. OpenAI-style messages are converted to
    // Gemini's contents[] + systemInstruction shape.
    if (active.service === 'gemini') {
      var gModel = model.indexOf('google/') === 0 ? model.slice(7) : 'gemini-3.5-flash';
      var gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + gModel + ':generateContent';
      var sysText = '';
      var contents = [];
      messages.forEach(function (m) {
        if (m.role === 'system') { sysText += (sysText ? '\n\n' : '') + m.content; }
        else { contents.push({ role: (m.role === 'assistant' ? 'model' : 'user'), parts: [{ text: String(m.content) }] }); }
      });
      var gBody = { contents: contents, generationConfig: { temperature: temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } };
      if (sysText) gBody.systemInstruction = { parts: [{ text: sysText }] };
      return fetch(gUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': active.key },
        body: JSON.stringify(gBody)
      }).then(function (resp) {
        return resp.text().then(function (txt) {
          if (!resp.ok) {
            var gmsg = 'Erro ' + resp.status;
            try { var gej = JSON.parse(txt); gmsg = (gej.error && (gej.error.message || gej.error)) || gmsg; } catch (e) {}
            var ger = new Error(typeof gmsg === 'string' ? gmsg : ('Erro ' + resp.status)); ger.status = resp.status; throw ger;
          }
          var gdata = {};
          try { gdata = JSON.parse(txt); } catch (e) { throw new Error('Resposta ilegível do provedor.'); }
          if (gdata.promptFeedback && gdata.promptFeedback.blockReason) {
            throw new Error('O provedor bloqueou o pedido (' + gdata.promptFeedback.blockReason + '). Ajuste o texto e tente de novo.');
          }
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
        // ASCII only — a non-ISO-8859-1 char in a header makes fetch throw (slides-ia bug)
        'HTTP-Referer': 'https://anunciosia.appsbrasil.store',
        'X-Title': 'Anuncios IA'
      };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: maxTokens };
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034/035
    } else {
      // native OpenAI
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + active.key };
      var oa = model.indexOf('openai/') === 0 ? model.slice(7) : 'gpt-5.4-mini';
      body = { model: oa, messages: messages, max_completion_tokens: maxTokens };
      // omit temperature on native path — gpt-5.x reasoning models reject non-default temps
    }

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (resp) {
      return resp.text().then(function (txt) {
        if (!resp.ok) {
          var msg = 'Erro ' + resp.status;
          try { var ej = JSON.parse(txt); msg = (ej.error && (ej.error.message || ej.error)) || msg; } catch (e) {}
          var er = new Error(typeof msg === 'string' ? msg : ('Erro ' + resp.status));
          er.status = resp.status; throw er;
        }
        var data = {};
        try { data = JSON.parse(txt); } catch (e) { var pe = new Error('Resposta ilegível do provedor.'); throw pe; }
        var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content || !String(content).trim()) { var ee = new Error('Resposta vazia do modelo'); ee.emptyContent = true; throw ee; }
        return content;
      });
    });
  }

  // COR-035 — retry once WITHOUT reasoning if a model answered in the reasoning channel (empty content)
  function fetchResilient(messages, temperature, maxTokens) {
    var active = ApiKeyManager.getActiveKey();
    if (!active) return Promise.reject(new Error('Nenhuma chave de API configurada.'));
    var model = ApiKeyManager.getModel();
    if (active.service === 'openai' && model.indexOf('openai/') !== 0) {
      return Promise.reject(new Error('O modelo selecionado exige uma chave OpenRouter. Escolha um modelo OpenAI ou cole sua chave OpenRouter em "Chaves".'));
    }
    if (active.service === 'gemini' && model.indexOf('google/') !== 0) {
      return Promise.reject(new Error('O modelo selecionado exige uma chave OpenRouter. Escolha um modelo Google (Gemini) ou cole sua chave OpenRouter em "Chaves".'));
    }
    return fetchContent(messages, active, temperature, false, maxTokens).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') {
        return fetchContent(messages, active, temperature, true, maxTokens);
      }
      throw e;
    });
  }

  // repair ladder (fences → first{..last} → trailing commas → stray control chars)
  function tryParse(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    var attempts = [];
    attempts.push(s);
    var fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
    if (fenced !== s) attempts.push(fenced);
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) attempts.push(s.slice(a, b + 1));
    var af = fenced.indexOf('{'), bf = fenced.lastIndexOf('}');
    if (af >= 0 && bf > af) attempts.push(fenced.slice(af, bf + 1));
    for (var i = 0; i < attempts.length; i++) {
      var cand = attempts[i];
      var variants = [cand, cand.replace(/,\s*([}\]])/g, "$1"), cand.replace(/[\u0000-\u001F]+/g, " ").replace(/,\s*([}\]])/g, "$1")];
      for (var j = 0; j < variants.length; j++) {
        try { var o = JSON.parse(variants[j]); if (o && typeof o === 'object') return o; } catch (e) {}
      }
    }
    return null;
  }

  function generateJSON(messages, maxTokens) {
    return fetchResilient(messages, 0.85, maxTokens).then(function (raw) {
      var obj = tryParse(raw);
      if (obj) return obj;
      // COR-032 — reroll once, stricter + lower temp
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NAO era um JSON valido. Responda AGORA com APENAS o objeto JSON pedido — sem texto fora do JSON, sem markdown, sem crases. Use aspas retas.' }]);
      return fetchResilient(strict, 0.4, maxTokens).then(function (raw2) {
        var obj2 = tryParse(raw2);
        if (obj2) return obj2;
        throw new Error('O modelo nao devolveu um JSON valido. Tente gerar novamente ou troque de modelo.');
      });
    });
  }

  // ============================================================ prompts
  function briefFromForm() {
    return {
      oferta: $('in-oferta').value.trim(),
      publico: $('in-publico').value.trim(),
      objetivo: activeChip('chips-objetivo'),
      plataforma: activeChip('chips-plataforma'),
      tom: activeChip('chips-tom'),
      marca: $('in-marca').value.trim()
    };
  }
  function activeChip(groupId) {
    var el = $(groupId).querySelector('.chip.active');
    return el ? el.getAttribute('data-val') : '';
  }

  function platformName(p) {
    return ({ meta_feed: 'Feed do Instagram/Facebook (Meta Ads)', stories: 'Stories (Meta Ads)', reels: 'Reels (Meta Ads)', google_search: 'Rede de Pesquisa do Google (Google Ads)' })[p] || 'Meta Ads';
  }

  function systemPrompt(brief) {
    var lim = PLATFORMS[brief.plataforma].limits;
    var isGoogle = brief.plataforma === 'google_search';
    return 'Voce e um copywriter senior brasileiro especialista em trafego pago (Meta Ads e Google Ads), ' +
      'com anos escrevendo anuncios de alta conversao para infoprodutores, agencias e pequenos negocios no Brasil. ' +
      'Escreva SEMPRE em portugues do Brasil, com naturalidade e persuasao, sem clickbait mentiroso e sem promessas ilegais. ' +
      'Respeite as politicas de anuncios (nada de "ganhe dinheiro garantido", sem afirmacoes de saude/financeiras absolutas). ' +
      'Gere uma campanha com EXATAMENTE 3 angulos ESTRATEGICAMENTE DIFERENTES entre si (ex.: dor/problema, desejo/beneficio, ' +
      'prova social/autoridade, curiosidade, urgencia) — nao repita a mesma ideia com outras palavras. ' +
      'Plataforma: ' + platformName(brief.plataforma) + '. ' +
      'LIMITES DE CARACTERES (respeite-os): headline ate ' + lim.headline + ', descricao ate ' + lim.descricao +
      (isGoogle ? (', cada descricao longa ate ' + lim.primaria) : (', texto primario curto (gancho) ate ~' + lim.primaria + ' caracteres antes de truncar no feed')) + '. ' +
      'Responda APENAS com um objeto JSON valido (sem markdown, sem crases, sem texto fora do JSON) nesta estrutura EXATA:\n' +
      '{\n' +
      '  "angulos": [\n' +
      '    {\n' +
      '      "nome": "nome curto do angulo (2 a 4 palavras)",\n' +
      '      "estrategia": "1 frase explicando a estrategia deste angulo",\n' +
      '      "headlines": ["5 variacoes de headline curtas, cada uma <= ' + lim.headline + ' caracteres"],\n' +
      '      "texto_primario_curto": "gancho de 1-2 frases (o texto principal do anuncio)",\n' +
      '      "texto_primario_longo": "versao storytelling de 3-5 frases, com quebras de linha \\n quando fizer sentido",\n' +
      '      "descricao": "descricao curta (<= ' + lim.descricao + ' caracteres)",\n' +
      '      "cta": "um dos botoes de CTA: ' + CTA_LIST + '"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      'Devolva os 3 angulos no array "angulos". Nao inclua comentarios.';
  }
  function userPrompt(brief) {
    return 'OFERTA/PRODUTO:\n' + brief.oferta + '\n\n' +
      'PUBLICO-ALVO: ' + (brief.publico || '(nao especificado — infira do produto)') + '\n' +
      'OBJETIVO DA CAMPANHA: ' + brief.objetivo + '\n' +
      'TOM DE VOZ: ' + brief.tom + '\n' +
      'MARCA/PERFIL: ' + (brief.marca || '(use um nome curto coerente com a oferta)') + '\n\n' +
      'Gere a campanha completa em JSON, com 3 angulos diferentes.';
  }

  // normalize one angle object into a safe shape
  function normAngle(a) {
    a = a || {};
    var hl = Array.isArray(a.headlines) ? a.headlines.map(clean).filter(Boolean) : [];
    if (!hl.length) hl = [clean(a.headline) || 'Sua oferta em destaque'];
    return {
      nome: clean(a.nome) || 'Angulo',
      estrategia: clean(a.estrategia),
      headlines: hl.slice(0, 8),
      texto_primario_curto: clean(a.texto_primario_curto) || clean(a.texto_primario) || '',
      texto_primario_longo: clean(a.texto_primario_longo) || clean(a.texto_primario_curto) || clean(a.texto_primario) || '',
      descricao: clean(a.descricao),
      cta: clean(a.cta) || 'Saiba mais'
    };
  }

  // ============================================================ generate (full campaign)
  function generate() {
    if (state.generating) return;
    var brief = briefFromForm();
    if (!brief.oferta || brief.oferta.length < 12) { toast('Descreva sua oferta/produto com mais detalhe.', true); $('in-oferta').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de IA primeiro.', true); MembershipGate.showScreen('key-screen'); return; }

    state.brief = brief;
    try { localStorage.setItem(BRIEF_STORE, JSON.stringify(brief)); } catch (e) {}
    setLoading(true, 'Criando os anúncios…');

    var msgs = [{ role: 'system', content: systemPrompt(brief) }, { role: 'user', content: userPrompt(brief) }];
    var run = function () { return generateJSON(msgs, MAXTOK_FULL); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('generate-campaign', run) : run();

    Promise.resolve(p).then(function (obj) {
      if (obj === null) { setLoading(false); return; } // rate limited (toast shown by limiter)
      var angs = Array.isArray(obj.angulos) ? obj.angulos : (Array.isArray(obj) ? obj : []);
      angs = angs.map(normAngle).filter(function (a) { return a.headlines.length; });
      if (!angs.length) throw new Error('O modelo nao retornou angulos. Tente novamente.');
      state.data = { oferta: brief.oferta, publico: brief.publico, objetivo: brief.objetivo, plataforma: brief.plataforma, marca: brief.marca, angulos: angs };
      state.angleIdx = 0;
      state.hlIdx = angs.map(function () { return 0; });
      try { localStorage.setItem(CAMPAIGN_STORE, JSON.stringify(state.data)); } catch (e) {}
      setLoading(false);
      renderAll();
      toast('Campanha gerada — ' + angs.length + ' ângulos.');
    }).catch(function (e) {
      setLoading(false);
      toast((e && e.message) ? e.message : 'Erro ao gerar. Tente novamente.', true);
    });
  }

  // regenerate a single angle
  function regenAngle(idx) {
    if (state.generating || !state.data) return;
    var brief = state.brief;
    var others = state.data.angulos.filter(function (_, i) { return i !== idx; }).map(function (a) { return a.nome; }).join('; ');
    var msgs = [
      { role: 'system', content: systemPrompt(brief) },
      { role: 'user', content: userPrompt(brief) +
        '\n\nGERE APENAS UM angulo NOVO, diferente destes ja existentes: ' + (others || '(nenhum)') + '. ' +
        'Responda com um JSON no formato { "angulos": [ { ... um unico angulo ... } ] }.' }
    ];
    var btn = document.querySelector('.regen-angle-btn[data-idx="' + idx + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    var run = function () { return generateJSON(msgs, MAXTOK_REGEN); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('regen-angle', run) : run();
    Promise.resolve(p).then(function (obj) {
      if (obj === null) { if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar ângulo'; } return; }
      var arr = Array.isArray(obj.angulos) ? obj.angulos : (Array.isArray(obj) ? obj : [obj]);
      var na = normAngle(arr[0]);
      if (!na.headlines.length) throw new Error('Angulo vazio.');
      state.data.angulos[idx] = na;
      state.hlIdx[idx] = 0;
      try { localStorage.setItem(CAMPAIGN_STORE, JSON.stringify(state.data)); } catch (e) {}
      renderAll();
      toast('Ângulo ' + (idx + 1) + ' regerado.');
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar ângulo'; }
      toast((e && e.message) ? e.message : 'Erro ao regerar.', true);
    });
  }

  function setLoading(on, title) {
    state.generating = on;
    $('generate-btn').disabled = on;
    $('generate-btn').textContent = on ? 'Gerando…' : 'Gerar campanha';
    $('preview-empty').style.display = 'none';
    $('preview-loading').style.display = on ? 'block' : 'none';
    if (on && title) $('loading-title').textContent = title;
    if (on) $('preview-content').style.display = 'none';
  }

  // ============================================================ render
  function renderAll() {
    renderAngleSwitch();
    renderMock();
    renderCopy();
    renderBrief();
    $('preview-empty').style.display = 'none';
    $('preview-content').style.display = 'block';
    $('copy-empty').style.display = 'none';
    $('brief-empty').style.display = 'none';
  }

  function renderAngleSwitch() {
    var host = $('angle-switch');
    host.innerHTML = '';
    state.data.angulos.forEach(function (a, i) {
      var b = document.createElement('button');
      b.className = 'angle-pill' + (i === state.angleIdx ? ' active' : '');
      b.innerHTML = '<span class="n">' + (i + 1) + '</span>' + esc(a.nome);
      b.addEventListener('click', function () { state.angleIdx = i; renderAngleSwitch(); renderMock(); });
      host.appendChild(b);
    });
  }

  function truncatePrimary(text, limit) {
    text = String(text || '');
    if (text.length <= limit) return { shown: text, more: false };
    var cut = text.slice(0, limit);
    var sp = cut.lastIndexOf(' ');
    if (sp > limit * 0.6) cut = cut.slice(0, sp);
    return { shown: cut.replace(/[\s.,;:!-]+$/, ''), more: true };
  }

  function buildMockHTML(angle, hlIndex, platform, marca) {
    var pf = PLATFORMS[platform];
    var headline = angle.headlines[hlIndex] || angle.headlines[0] || '';
    var name = marca || 'Sua Marca';
    var initial = (name.trim()[0] || 'A').toUpperCase();
    if (pf.kind === 'google') {
      var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'suamarca';
      return '' +
        '<div class="ad-mock google">' +
          '<div class="g-badge">Patrocinado</div>' +
          '<div class="g-url"><strong>' + esc(name) + '</strong> · www.' + esc(slug) + '.com.br</div>' +
          '<div class="g-head">' + esc(headline) + '</div>' +
          '<div class="g-desc">' + esc(angle.descricao || angle.texto_primario_curto || '') + '</div>' +
        '</div>';
    }
    var prim = truncatePrimary(angle.texto_primario_longo || angle.texto_primario_curto || '', pf.limits.primaria);
    var imgCls = pf.img === 'story' ? ' stories' : '';
    var imgLabel = pf.img === 'story' ? 'Sua imagem/vídeo vertical (9:16)' : 'Sua imagem ou vídeo (1:1)';
    return '' +
      '<div class="ad-mock">' +
        '<div class="m-top">' +
          '<div class="m-avatar">' + esc(initial) + '</div>' +
          '<div class="m-id">' +
            '<div class="m-name">' + esc(name) + '</div>' +
            '<div class="m-sub">Patrocinado · <span aria-hidden="true">🌐</span></div>' +
          '</div>' +
          '<div class="m-dots">•••</div>' +
        '</div>' +
        '<div class="m-primary">' + esc(prim.shown) + (prim.more ? '… <span class="more">Ver mais</span>' : '') + '</div>' +
        '<div class="m-image' + imgCls + '">' + esc(imgLabel) + '</div>' +
        '<div class="m-cta">' +
          '<div class="c-txt">' +
            '<div class="c-head">' + esc(headline) + '</div>' +
            (angle.descricao ? '<div class="c-desc">' + esc(angle.descricao) + '</div>' : '') +
          '</div>' +
          '<div class="c-btn">' + esc(angle.cta || 'Saiba mais') + '</div>' +
        '</div>' +
        '<div class="m-react"><span>👍❤️ 128</span><span class="spacer"></span><span>24 comentários</span></div>' +
      '</div>';
  }

  function renderMock() {
    if (!state.data) return;
    var a = state.data.angulos[state.angleIdx];
    var pf = PLATFORMS[state.data.plataforma];
    $('ad-mock-host').innerHTML = buildMockHTML(a, state.hlIdx[state.angleIdx], state.data.plataforma, state.data.marca);
    $('platform-label').textContent = pf.label;
    var total = a.headlines.length;
    var cur = state.hlIdx[state.angleIdx] + 1;
    $('hl-indicator').textContent = 'TÍTULO ' + cur + '/' + total;
    $('hl-prev').disabled = false; $('hl-next').disabled = false;
  }

  function cycleHeadline(dir) {
    if (!state.data) return;
    var a = state.data.angulos[state.angleIdx];
    var n = a.headlines.length;
    state.hlIdx[state.angleIdx] = (state.hlIdx[state.angleIdx] + dir + n) % n;
    renderMock();
  }

  function countClass(len, limit) { return len > limit ? ' over' : ''; }

  function renderCopy() {
    var host = $('copy-content');
    host.innerHTML = '';
    var lim = PLATFORMS[state.data.plataforma].limits;
    state.data.angulos.forEach(function (a, i) {
      var wrap = document.createElement('div');
      wrap.className = 'copy-angle';
      var html = '<div class="copy-angle-head"><span class="ca-name">' + esc(a.nome) + '</span><span class="ca-num">ÂNGULO ' + (i + 1) + '/' + state.data.angulos.length + '</span></div>';
      html += '<div class="copy-angle-body">';
      if (a.estrategia) html += '<div class="ca-desc">' + esc(a.estrategia) + '</div>';

      // headlines
      html += '<div class="copy-block"><div class="cb-label"><span class="lbl">Headlines (máx ' + lim.headline + ')</span></div>';
      a.headlines.forEach(function (h) {
        html += '<div class="cb-item"><span class="txt">' + esc(h) + '</span><span class="mini-count' + countClass(h.length, lim.headline) + '">' + h.length + '</span>' + copyBtn(h) + '</div>';
      });
      html += '</div>';

      // primary short
      if (a.texto_primario_curto) {
        html += copyBlock('Texto primário — gancho', a.texto_primario_curto, lim.primaria, true);
      }
      // primary long
      if (a.texto_primario_longo && a.texto_primario_longo !== a.texto_primario_curto) {
        html += copyBlock('Texto primário — storytelling', a.texto_primario_longo, 0, true);
      }
      // description
      if (a.descricao) html += copyBlock('Descrição (máx ' + lim.descricao + ')', a.descricao, lim.descricao, false);
      // cta
      html += '<div class="copy-block"><div class="cb-label"><span class="lbl">Botão (CTA)</span></div><div class="cb-item"><span class="txt">' + esc(a.cta) + '</span>' + copyBtn(a.cta) + '</div></div>';

      html += '<button class="regen-angle-btn" data-idx="' + i + '">↻ Regerar ângulo</button>';
      html += '</div>';
      wrap.innerHTML = html;
      host.appendChild(wrap);
    });

    // wire copy buttons
    host.querySelectorAll('.copy-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        copyText(decodeURIComponent(b.getAttribute('data-copy')), function (ok) {
          if (ok) { b.classList.add('done'); b.textContent = '✓'; setTimeout(function () { b.classList.remove('done'); b.innerHTML = copyIcon(); }, 1200); toast('Copiado!'); }
          else toast('Não foi possível copiar.', true);
        });
      });
    });
    host.querySelectorAll('.regen-angle-btn').forEach(function (b) {
      b.addEventListener('click', function () { regenAngle(parseInt(b.getAttribute('data-idx'), 10)); });
    });
  }
  function copyIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function copyBtn(str) { return '<button class="copy-btn" data-copy="' + encodeURIComponent(str) + '" title="Copiar" aria-label="Copiar">' + copyIcon() + '</button>'; }
  function copyBlock(label, text, limit, showTotalCount) {
    var count = showTotalCount ? '<span class="cb-count' + (limit && text.length > limit ? ' over' : '') + '">' + text.length + (limit ? '/' + limit : '') + '</span>' : '';
    return '<div class="copy-block"><div class="cb-label"><span class="lbl">' + esc(label) + '</span>' + count + '</div>' +
      '<div class="cb-item"><span class="txt">' + esc(text).replace(/\n/g, '<br>') + '</span>' + copyBtn(text) + '</div></div>';
  }

  function renderBrief() {
    var d = state.data;
    var host = $('brief-content');
    var h = '<div class="meta-line">OFERTA: ' + esc(d.oferta) + '</div>';
    if (d.publico) h += '<div class="meta-line">PÚBLICO: ' + esc(d.publico) + '</div>';
    h += '<div class="meta-line">OBJETIVO: ' + esc(d.objetivo) + '</div>';
    h += '<div class="meta-line">PLATAFORMA: ' + esc(PLATFORMS[d.plataforma].label) + '</div>';
    d.angulos.forEach(function (a, i) {
      h += '<div class="b-ang"><h4>Ângulo ' + (i + 1) + ' — ' + esc(a.nome) + '</h4>';
      if (a.estrategia) h += '<div class="b-field"><span class="k">Estratégia</span><br>' + esc(a.estrategia) + '</div>';
      h += '<div class="b-field"><span class="k">Headlines</span><br>' + a.headlines.map(esc).join('<br>') + '</div>';
      if (a.texto_primario_curto) h += '<div class="b-field"><span class="k">Texto — gancho</span><br>' + esc(a.texto_primario_curto).replace(/\n/g, '<br>') + '</div>';
      if (a.texto_primario_longo && a.texto_primario_longo !== a.texto_primario_curto) h += '<div class="b-field"><span class="k">Texto — storytelling</span><br>' + esc(a.texto_primario_longo).replace(/\n/g, '<br>') + '</div>';
      if (a.descricao) h += '<div class="b-field"><span class="k">Descrição</span><br>' + esc(a.descricao) + '</div>';
      h += '<div class="b-field"><span class="k">CTA</span><br>' + esc(a.cta) + '</div></div>';
    });
    host.innerHTML = h;
  }

  // ============================================================ exports
  function currentAngleText() {
    var a = state.data.angulos[state.angleIdx];
    var lines = [];
    lines.push('ÂNGULO: ' + a.nome);
    if (a.estrategia) lines.push('Estratégia: ' + a.estrategia);
    lines.push('');
    lines.push('HEADLINES:');
    a.headlines.forEach(function (h) { lines.push('• ' + h); });
    lines.push('');
    if (a.texto_primario_curto) { lines.push('TEXTO PRIMÁRIO (gancho):'); lines.push(a.texto_primario_curto); lines.push(''); }
    if (a.texto_primario_longo && a.texto_primario_longo !== a.texto_primario_curto) { lines.push('TEXTO PRIMÁRIO (storytelling):'); lines.push(a.texto_primario_longo); lines.push(''); }
    if (a.descricao) lines.push('DESCRIÇÃO: ' + a.descricao);
    lines.push('CTA: ' + a.cta);
    return lines.join('\n');
  }

  function copyCurrent() {
    copyText(currentAngleText(), function (ok) { toast(ok ? 'Anúncio copiado!' : 'Não foi possível copiar.', !ok); });
  }

  // -- mock CSS mirrored for self-contained PNG/HTML export --
  var MOCK_CSS =
    '.ad-mock{background:#fff;border-radius:4px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#050505;width:400px}' +
    '.ad-mock .m-top{display:flex;align-items:center;gap:8px;padding:10px 12px}' +
    '.ad-mock .m-avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#e5341f,#ffd400);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:17px}' +
    '.ad-mock .m-id{min-width:0;line-height:1.25}.ad-mock .m-name{font-weight:600;font-size:14px}.ad-mock .m-sub{font-size:12px;color:#65676b}' +
    '.ad-mock .m-dots{margin-left:auto;color:#65676b;font-weight:700;letter-spacing:1px}' +
    '.ad-mock .m-primary{padding:0 12px 10px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}.ad-mock .m-primary .more{color:#65676b}' +
    '.ad-mock .m-image{width:100%;background:repeating-linear-gradient(45deg,rgba(0,0,0,.04) 0 12px,rgba(0,0,0,0) 12px 24px),linear-gradient(135deg,#e9edf2,#dfe4ea);display:flex;align-items:center;justify-content:center;color:#9aa3ad;font-size:13px;font-weight:600;text-align:center;padding:20px;height:400px}' +
    '.ad-mock .m-image.stories{height:600px}' +
    '.ad-mock .m-cta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;background:#f0f2f5}' +
    '.ad-mock .m-cta .c-head{font-weight:600;font-size:15px;line-height:1.25;word-break:break-word}.ad-mock .m-cta .c-desc{font-size:12px;color:#65676b;margin-top:2px;word-break:break-word}' +
    '.ad-mock .m-cta .c-btn{flex-shrink:0;background:#e4e6eb;color:#050505;font-weight:600;font-size:14px;padding:8px 14px;border-radius:6px;white-space:nowrap}' +
    '.ad-mock .m-react{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid #ced0d4;color:#65676b;font-size:13px}.ad-mock .m-react .spacer{flex:1}' +
    '.ad-mock.google{padding:14px 16px;font-family:arial,sans-serif;width:400px}.ad-mock.google .g-badge{font-size:12px;color:#202124;font-weight:700}.ad-mock.google .g-url{font-size:13px;color:#202124;margin-top:6px}' +
    '.ad-mock.google .g-head{color:#1a0dab;font-size:20px;line-height:1.3;margin-top:3px}.ad-mock.google .g-desc{color:#4d5156;font-size:14px;line-height:1.45;margin-top:4px}';

  function downloadPNG() {
    if (!state.data) return;
    var a = state.data.angulos[state.angleIdx];
    var inner = buildMockHTML(a, state.hlIdx[state.angleIdx], state.data.plataforma, state.data.marca);
    var W = 400, PAD = 24;
    // offscreen measure
    var off = document.createElement('div');
    off.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + W + 'px';
    off.innerHTML = '<style>' + MOCK_CSS + '</style>' + inner;
    document.body.appendChild(off);
    var mock = off.querySelector('.ad-mock');
    var H = mock ? mock.offsetHeight : 500;
    document.body.removeChild(off);

    var totalW = W + PAD * 2, totalH = H + PAD * 2, scale = 2;
    var xhtml =
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + totalW + 'px;height:' + totalH + 'px;background:#f4f1ea;padding:' + PAD + 'px;box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif">' +
      '<style>' + MOCK_CSS + '</style>' + inner + '</div>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + (totalW * scale) + '" height="' + (totalH * scale) + '">' +
      '<foreignObject width="' + totalW + '" height="' + totalH + '">' + xhtml + '</foreignObject></svg>';

    var img = new Image();
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; toast('Não foi possível gerar o PNG. Use "Baixar brief (HTML)".', true); } }, 8000);
    img.onload = function () {
      if (done) return; done = true; clearTimeout(timer);
      try {
        var canvas = document.createElement('canvas');
        canvas.width = totalW * scale; canvas.height = totalH * scale;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function (blob) {
          if (!blob) { toast('Falha ao exportar PNG.', true); return; }
          var url = URL.createObjectURL(blob);
          triggerDownload(url, 'anuncio-' + slugify(state.data.marca || state.data.oferta) + '-angulo' + (state.angleIdx + 1) + '.png');
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          toast('Mockup PNG baixado!');
        }, 'image/png');
      } catch (e) { toast('Falha ao exportar PNG (' + (e.message || 'erro') + ').', true); }
    };
    img.onerror = function () { if (done) return; done = true; clearTimeout(timer); toast('Não foi possível gerar o PNG. Use "Baixar brief (HTML)".', true); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function slugify(s) { return String(s || 'anuncio').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'anuncio'; }
  function triggerDownload(url, filename) {
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function downloadBrief() {
    if (!state.data) return;
    var d = state.data;
    var mockInner = buildMockHTML(d.angulos[0], 0, d.plataforma, d.marca);
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f4f1ea;color:#141210;margin:0;padding:32px;line-height:1.55}' +
      '.wrap{max-width:760px;margin:0 auto}h1{font-family:Impact,"Arial Narrow Bold","Helvetica Neue",sans-serif;text-transform:uppercase;letter-spacing:.02em;font-size:38px;line-height:.95;margin:0 0 6px}' +
      '.red{color:#e5341f}.meta{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#3a352d;margin:2px 0}' +
      '.ang{background:#fff;border:2px solid #141210;border-radius:6px;padding:18px;margin:20px 0;box-shadow:6px 6px 0 rgba(20,18,16,.1)}' +
      '.ang h2{font-family:Impact,"Arial Narrow Bold",sans-serif;text-transform:uppercase;font-size:22px;letter-spacing:.02em;margin:0 0 4px}' +
      '.strat{font-style:italic;color:#3a352d;margin-bottom:12px}.k{font-family:ui-monospace,Menlo,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b6355;margin-top:12px;display:block}' +
      'ul{margin:4px 0 0;padding-left:20px}.val{margin:2px 0;white-space:pre-wrap}.badge{display:inline-block;background:#ffd400;border:2px solid #141210;border-radius:100px;padding:4px 12px;font-size:11px;font-weight:800;text-transform:uppercase}' +
      MOCK_CSS + ' .mockwrap{margin-top:16px}';
    var body = '<div class="wrap"><span class="badge">Anúncios IA · Gênesis IA</span>' +
      '<h1>Kit de campanha<br><span class="red">' + esc((d.marca || d.oferta).slice(0, 60)) + '</span></h1>' +
      '<div class="meta">OFERTA: ' + esc(d.oferta) + '</div>' +
      (d.publico ? '<div class="meta">PUBLICO: ' + esc(d.publico) + '</div>' : '') +
      '<div class="meta">OBJETIVO: ' + esc(d.objetivo) + '</div>' +
      '<div class="meta">PLATAFORMA: ' + esc(PLATFORMS[d.plataforma].label) + '</div>' +
      '<div class="mockwrap">' + mockInner + '</div>';
    d.angulos.forEach(function (a, i) {
      body += '<div class="ang"><h2>Ângulo ' + (i + 1) + ' — ' + esc(a.nome) + '</h2>';
      if (a.estrategia) body += '<div class="strat">' + esc(a.estrategia) + '</div>';
      body += '<span class="k">Headlines</span><ul>' + a.headlines.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>';
      if (a.texto_primario_curto) body += '<span class="k">Texto primário — gancho</span><div class="val">' + esc(a.texto_primario_curto) + '</div>';
      if (a.texto_primario_longo && a.texto_primario_longo !== a.texto_primario_curto) body += '<span class="k">Texto primário — storytelling</span><div class="val">' + esc(a.texto_primario_longo) + '</div>';
      if (a.descricao) body += '<span class="k">Descrição</span><div class="val">' + esc(a.descricao) + '</div>';
      body += '<span class="k">Botão (CTA)</span><div class="val">' + esc(a.cta) + '</div></div>';
    });
    body += '<p class="meta" style="margin-top:24px">Gerado por Anúncios IA — anunciosia.appsbrasil.store</p></div>';
    var doc = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kit de campanha — ' + esc(d.marca || d.oferta) + '</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    triggerDownload(url, 'campanha-' + slugify(d.marca || d.oferta) + '.html');
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Brief HTML baixado!');
  }

  // ============================================================ wiring
  function wireChips(groupId) {
    var g = $(groupId);
    g.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        g.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); x.classList.remove('red'); });
        c.classList.add('active');
        if (groupId === 'chips-objetivo' || groupId === 'chips-plataforma') c.classList.add('red');
      });
    });
  }

  function wireTabs() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        $('tab-' + t.getAttribute('data-tab')).classList.add('active');
      });
    });
  }

  function restore() {
    try {
      var b = JSON.parse(localStorage.getItem(BRIEF_STORE) || 'null');
      if (b) {
        if (b.oferta) $('in-oferta').value = b.oferta;
        if (b.publico) $('in-publico').value = b.publico;
        if (b.marca) $('in-marca').value = b.marca;
        selectChipByVal('chips-objetivo', b.objetivo);
        selectChipByVal('chips-plataforma', b.plataforma);
        selectChipByVal('chips-tom', b.tom);
      }
      var c = JSON.parse(localStorage.getItem(CAMPAIGN_STORE) || 'null');
      if (c && Array.isArray(c.angulos) && c.angulos.length) {
        state.data = c; state.brief = b || {}; state.angleIdx = 0; state.hlIdx = c.angulos.map(function () { return 0; });
        renderAll();
      }
    } catch (e) {}
  }
  function selectChipByVal(groupId, val) {
    if (!val) return;
    var g = $(groupId); var found = false;
    g.querySelectorAll('.chip').forEach(function (c) {
      var on = c.getAttribute('data-val') === val;
      c.classList.toggle('active', on);
      c.classList.remove('red');
      if (on && (groupId === 'chips-objetivo' || groupId === 'chips-plataforma')) c.classList.add('red');
      if (on) found = true;
    });
  }

  var inited = false;
  function init() {
    if (inited) return; inited = true;
    ApiKeyManager.renderModelPicker('model-select');
    wireChips('chips-objetivo'); wireChips('chips-plataforma'); wireChips('chips-tom');
    wireTabs();
    $('generate-btn').addEventListener('click', generate);
    $('hl-prev').addEventListener('click', function () { cycleHeadline(-1); });
    $('hl-next').addEventListener('click', function () { cycleHeadline(1); });
    $('btn-copy-current').addEventListener('click', copyCurrent);
    $('btn-download-png').addEventListener('click', downloadPNG);
    $('btn-download-brief').addEventListener('click', downloadBrief);
    // greet
    var s = window.MembershipGate ? MembershipGate.getSession() : null;
    restore();
  }

  // COR-008 — init on app-ready (returning + first-time users) with a DOMContentLoaded fallback
  document.addEventListener('maestria:app-ready', init);
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      if (document.getElementById('app-screen') && document.getElementById('app-screen').classList.contains('active')) init();
    }, 400);
  });
})();
