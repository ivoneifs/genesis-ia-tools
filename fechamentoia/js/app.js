/* ============================================================
   Fechamento IA — app logic
   BYOK (user's own key: OpenRouter, native Google Gemini, or native OpenAI). The tool
   asks the model for a strict JSON SALES-CLOSING PLAYBOOK (a full WhatsApp/DM conversation
   organized by scenario), then renders it into: (a) a navigable scenario library where each
   scenario is a "PLAY" card with a chalk route header + realistic WhatsApp chat bubbles,
   (b) an objection-breaker grid, (c) exports (copy all / copy scenario / .html / .txt) +
   per-message copy + per-scenario regenerate. Nothing is sent to our servers except the
   n8n gate calls. LLM plumbing = proven COR-032/034/035/015 set.
   ============================================================ */
(function () {
  'use strict';

  // ---- localStorage slots (snake_case values to dodge the gitleaks KEY='literal' heuristic, COR-025) ----
  var PLAY_STORE = 'fechamento_play_store';
  var BRIEF_STORE = 'fechamento_brief_store';

  // token budgets — generous per COR-034 (reasoning + content must both fit).
  var MAXTOK_FULL = 16000;
  var MAXTOK_REGEN = 6000;

  // ---- fixed scenario framework (the playbook order + chalk route + coaching tip) ----
  var SCENARIOS = [
    { id: 'abertura',     titulo: 'Abertura',           ico: '👋', rota: ['Lead novo', 'Conexão', 'Conversa'],
      dica: 'Responda um lead que chegou pelo anúncio, bio ou direct. Conecte e crie conversa antes de vender.' },
    { id: 'qualificacao', titulo: 'Qualificação',       ico: '🔎', rota: ['Conversa', 'Perguntas', 'Dor'],
      dica: 'Faça perguntas para descobrir a dor real e o momento do lead antes de apresentar a oferta.' },
    { id: 'oferta',       titulo: 'Oferta',             ico: '🎯', rota: ['Dor', 'Solução', 'Oferta'],
      dica: 'Apresente a oferta conectada à dor, em mensagens curtas — várias bolhas, nunca um textão.' },
    { id: 'objecoes',     titulo: 'Quebra de objeções', ico: '🛡️', rota: ['Objeção', 'Resposta', 'Avanço'],
      dica: 'Uma resposta pronta para cada objeção comum. Responda com empatia e reconduza para o fechamento.', special: 'objecoes' },
    { id: 'fechamento',   titulo: 'Fechamento',         ico: '🤝', rota: ['Interesse', 'Link', 'Venda'],
      dica: 'Conduza para o pagamento com clareza, próximo passo e urgência honesta (sem pressão falsa).' },
    { id: 'followup',     titulo: 'Follow-up',          ico: '⏰', rota: ['Sumiu', 'Dia 1 / 3 / 7', 'Retomada'],
      dica: 'Reative quem não respondeu — sem ser chato, sempre agregando um novo motivo para voltar.' }
  ];
  var LINEAR_IDS = ['abertura', 'qualificacao', 'oferta', 'fechamento', 'followup'];

  var state = {
    data: null,               // { produto, publico, ticket, tom, canal, vendedor, resumo, cenarios:{}, objecoes:[] }
    activeScenario: 'abertura',
    channel: 'whatsapp',
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
  // WhatsApp-style formatting: escape HTML, then apply *bold* _italic_ ~strike~
  function waFormat(text) {
    var s = esc(text).replace(/\r/g, '');
    s = s.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~([^~\n]+)~/g, '<del>$1</del>');
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
  function fmtTime(startMin, idx) {
    var m = startMin + idx * 2;
    var hh = Math.floor(m / 60) % 24, mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function scenMeta(id) { for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) return SCENARIOS[i]; return null; }
  // normalize a follow-up timing label to a clean "Dia N" (handles model quirks like "Dia int 3", "3", "Day 3")
  function fmtQuando(q) {
    q = clean(q);
    if (!q) return '';
    var m = q.match(/\d+/);
    if (m && (/di?a|day/i.test(q) || /^\s*\d+\s*$/.test(q))) return 'Dia ' + m[0];
    return q;
  }

  // ============================================================ LLM (proven plumbing — COR-032/034/035/015)
  function fetchContent(messages, active, temperature, noReasoning, maxTokens) {
    var model = ApiKeyManager.getModel();

    // ---- native Google Gemini (AI Studio) path — free-tier friendly ----
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
        // ASCII only — a non-ISO-8859-1 char in a header makes fetch throw
        'HTTP-Referer': 'https://fechamentoia.appsbrasil.store',
        'X-Title': 'Fechamento IA'
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
        try { data = JSON.parse(txt); } catch (e) { throw new Error('Resposta ilegível do provedor.'); }
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
    var fenced = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (fenced !== s) attempts.push(fenced);
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) attempts.push(s.slice(a, b + 1));
    var af = fenced.indexOf('{'), bf = fenced.lastIndexOf('}');
    if (af >= 0 && bf > af) attempts.push(fenced.slice(af, bf + 1));
    for (var i = 0; i < attempts.length; i++) {
      var cand = attempts[i];
      var variants = [cand, cand.replace(/,\s*([}\]])/g, '$1'), cand.replace(/[\x00-\x1f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')];
      for (var j = 0; j < variants.length; j++) {
        try { var o = JSON.parse(variants[j]); if (o && typeof o === 'object') return o; } catch (e) {}
      }
    }
    return null;
  }

  function generateJSON(messages, maxTokens) {
    return fetchResilient(messages, 0.8, maxTokens).then(function (raw) {
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
      produto: $('in-produto').value.trim(),
      publico: $('in-publico').value.trim(),
      ticket: $('in-ticket').value.trim(),
      canal: activeChip('chips-canal') || 'whatsapp',
      tom: activeChip('chips-tom') || 'Consultivo e próximo',
      vendedor: $('in-vendedor').value.trim(),
      objecoesExtras: $('in-objecoes').value.trim()
    };
  }
  function activeChip(groupId) {
    var el = $(groupId).querySelector('.chip.active');
    return el ? el.getAttribute('data-val') : '';
  }
  function canalNome(c) { return c === 'instagram' ? 'Instagram Direct (DM)' : 'WhatsApp'; }

  function systemPrompt(brief) {
    var canal = canalNome(brief.canal);
    return 'Voce e um closer/vendedor senior brasileiro, especialista em vender por ' + canal + ' para infoprodutores, ' +
      'agencias, criadores e pequenos negocios. Voce escreve conversas de venda 1:1 que fecham. ' +
      'Escreva SEMPRE em portugues do Brasil. Estilo de mensagens de ' + canal + ': mensagens CURTAS (varias bolhas curtas, ' +
      'como se manda de verdade no celular — nunca um textao), naturais e humanas, com *negrito* pontual (asteriscos, a formatacao do ' + canal + ') ' +
      'e emojis com moderacao. Persuasao HONESTA: sem clickbait mentiroso, sem promessas ilegais nem garantias absolutas de resultado/renda/saude, sem pressao falsa. ' +
      'Trate o lead com empatia; faca perguntas; conduza. ' +
      'Voce vai montar um PLAYBOOK COMPLETO de fechamento com estes 6 cenarios: abertura, qualificacao, oferta, objecoes, fechamento, followup. ' +
      'Regras por cenario:\n' +
      '- "abertura": array de mensagens. Comece com UMA mensagem do lead (de:"lead") curta (ele chegou pelo anuncio/bio/direct), depois 2-3 mensagens suas (de:"voce") que criam conexao e puxam conversa. NAO venda ainda.\n' +
      '- "qualificacao": array com 3-5 mensagens suas (de:"voce") — perguntas que descobrem a dor, o momento e o desejo do lead.\n' +
      '- "oferta": array com 3-5 mensagens suas (de:"voce") apresentando a oferta conectada a dor, em bolhas curtas, com beneficios e uma frase de valor. Pode citar o preco.\n' +
      '- "objecoes": array de 5 a 7 objecoes. Cada item = {"objecao":"a fala tipica do lead (curta, do jeito que ele fala)","resposta":"sua resposta pronta, empatica, em 1 a 3 frases curtas, que quebra a objecao e reconduz ao proximo passo"}. Cubra OBRIGATORIAMENTE: preco/"ta caro", "vou pensar", "nao tenho tempo", "preciso falar com meu socio/esposo(a)", "sera que funciona pra mim". Use o ticket/preco informado na objecao de preco.\n' +
      '- "fechamento": array com 3-4 mensagens suas (de:"voce") conduzindo ao pagamento — proximo passo claro, espaco para o link com o marcador [seu link de pagamento], e urgencia honesta.\n' +
      '- "followup": array com EXATAMENTE 3 mensagens suas (de:"voce") para quem sumiu; cada uma com o campo "quando" = "Dia 1", "Dia 3", "Dia 7" (nessa ordem). Cada follow-up traz um angulo/motivo novo, sem cobrar.\n' +
      'Responda APENAS com um objeto JSON valido (sem markdown, sem crases, sem texto fora do JSON) nesta estrutura EXATA:\n' +
      '{\n' +
      '  "resumo": "1-2 frases sobre a estrategia geral deste playbook de fechamento",\n' +
      '  "abertura": [ {"de":"lead","texto":"..."}, {"de":"voce","texto":"..."} ],\n' +
      '  "qualificacao": [ {"de":"voce","texto":"..."} ],\n' +
      '  "oferta": [ {"de":"voce","texto":"..."} ],\n' +
      '  "objecoes": [ {"objecao":"...","resposta":"..."} ],\n' +
      '  "fechamento": [ {"de":"voce","texto":"..."} ],\n' +
      '  "followup": [ {"de":"voce","texto":"...","quando":"Dia 1"} ]\n' +
      '}\n' +
      'Nao inclua comentarios nem texto fora do JSON.';
  }
  function userPrompt(brief) {
    return 'PRODUTO/OFERTA:\n' + brief.produto + '\n\n' +
      'PUBLICO-ALVO: ' + (brief.publico || '(nao especificado — infira do produto)') + '\n' +
      'TICKET/PRECO: ' + (brief.ticket || '(nao informado — use uma referencia coerente e generica)') + '\n' +
      'CANAL: ' + canalNome(brief.canal) + '\n' +
      'TOM DE VOZ: ' + (brief.tom || 'Consultivo e proximo') + '\n' +
      'VENDEDOR/MARCA: ' + (brief.vendedor || '(use um tom pessoal, sem inventar um nome)') + '\n' +
      (brief.objecoesExtras ? 'OBJECOES ESPECIFICAS A INCLUIR ALEM DAS COMUNS: ' + brief.objecoesExtras + '\n' : '') +
      '\nMonte o playbook completo em JSON, com os 6 cenarios e conversas curtas e naturais para ' + canalNome(brief.canal) + '.';
  }

  // ---- normalizers ----
  function normMsg(m) {
    m = m || {};
    var de = (clean(m.de) || 'voce').toLowerCase();
    if (de.indexOf('lead') === 0 || de === 'cliente' || de === 'entrada' || de === 'in') de = 'lead';
    else de = 'voce';
    return { de: de, texto: clean(m.texto) || clean(m.text) || clean(m.mensagem) || '', quando: clean(m.quando) || clean(m.dia) || '' };
  }
  function normMsgs(arr) {
    if (!Array.isArray(arr)) arr = [];
    return arr.map(normMsg).filter(function (m) { return m.texto; });
  }
  function normObj(o) {
    o = o || {};
    return { objecao: clean(o.objecao) || clean(o.objection) || clean(o.titulo) || '', resposta: clean(o.resposta) || clean(o.answer) || clean(o.texto) || '' };
  }

  function buildData(obj, brief) {
    var cen = {};
    LINEAR_IDS.forEach(function (id) {
      var raw = obj[id] || (obj.cenarios && obj.cenarios[id]) || [];
      cen[id] = normMsgs(raw);
    });
    var objec = (Array.isArray(obj.objecoes) ? obj.objecoes : (obj.cenarios && Array.isArray(obj.cenarios.objecoes) ? obj.cenarios.objecoes : []))
      .map(normObj).filter(function (o) { return o.objecao && o.resposta; });
    return {
      produto: brief.produto, publico: brief.publico, ticket: brief.ticket, tom: brief.tom,
      canal: brief.canal, vendedor: brief.vendedor || '',
      resumo: clean(obj.resumo) || '',
      cenarios: cen,
      objecoes: objec
    };
  }
  function hasAnyContent(d) {
    if (!d) return false;
    var n = 0;
    LINEAR_IDS.forEach(function (id) { n += (d.cenarios[id] || []).length; });
    n += (d.objecoes || []).length;
    return n > 0;
  }

  // ============================================================ generate (full playbook)
  function generate() {
    if (state.generating) return;
    var brief = briefFromForm();
    if (!brief.produto || brief.produto.length < 12) { toast('Descreva seu produto/oferta com mais detalhe.', true); $('in-produto').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de IA primeiro.', true); MembershipGate.showScreen('key-screen'); return; }

    state.brief = brief;
    try { localStorage.setItem(BRIEF_STORE, JSON.stringify(brief)); } catch (e) {}
    setLoading(true, 'Desenhando as jogadas…');

    var msgs = [{ role: 'system', content: systemPrompt(brief) }, { role: 'user', content: userPrompt(brief) }];
    var run = function () { return generateJSON(msgs, MAXTOK_FULL); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('generate-playbook', run) : run();

    Promise.resolve(p).then(function (obj) {
      if (obj === null) { setLoading(false); return; } // rate limited (toast shown by limiter)
      var data = buildData(obj, brief);
      if (!hasAnyContent(data)) throw new Error('O modelo não retornou conteúdo. Tente novamente.');
      state.data = data;
      state.channel = brief.canal;
      state.activeScenario = 'abertura';
      try { localStorage.setItem(PLAY_STORE, JSON.stringify(data)); } catch (e) {}
      setLoading(false);
      renderAll();
      toast('Playbook montado — 6 cenários prontos.');
    }).catch(function (e) {
      setLoading(false);
      toast((e && e.message) ? e.message : 'Erro ao gerar. Tente novamente.', true);
    });
  }

  // regenerate a single scenario (keep the rest)
  function regenScenario(id) {
    if (state.generating || !state.data) return;
    var meta = scenMeta(id);
    var brief = state.brief;
    var instr;
    if (id === 'objecoes') {
      instr = 'REESCREVA APENAS o cenario "objecoes": devolva um JSON { "objecoes": [ {"objecao":"...","resposta":"..."} ] } ' +
        'com 5 a 7 objecoes novas e melhores (mantendo as obrigatorias: preco, "vou pensar", "nao tenho tempo", decisor, "sera que funciona pra mim").';
    } else {
      instr = 'REESCREVA APENAS o cenario "' + id + '" (' + meta.titulo + '): devolva um JSON { "' + id + '": [ {"de":"voce"|"lead","texto":"..."' +
        (id === 'followup' ? ',"quando":"Dia 1"' : '') + '} ] } com mensagens NOVAS e melhores, curtas e naturais, mantendo o papel deste cenario no arco.';
    }
    var msgs = [
      { role: 'system', content: systemPrompt(brief) },
      { role: 'user', content: userPrompt(brief) + '\n\n' + instr + ' Responda APENAS com esse JSON.' }
    ];
    var btn = document.querySelector('.regen[data-scen="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '↻ Gerando…'; }
    var run = function () { return generateJSON(msgs, MAXTOK_REGEN); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('regen-scenario', run) : run();
    Promise.resolve(p).then(function (obj) {
      if (obj === null) { if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar'; } return; }
      if (id === 'objecoes') {
        var arr = (Array.isArray(obj.objecoes) ? obj.objecoes : (Array.isArray(obj) ? obj : [])).map(normObj).filter(function (o) { return o.objecao && o.resposta; });
        if (!arr.length) throw new Error('Cenário vazio.');
        state.data.objecoes = arr;
      } else {
        var raw = obj[id] || (obj.cenarios && obj.cenarios[id]) || (Array.isArray(obj) ? obj : []);
        var msgsN = normMsgs(raw);
        if (!msgsN.length) throw new Error('Cenário vazio.');
        state.data.cenarios[id] = msgsN;
      }
      try { localStorage.setItem(PLAY_STORE, JSON.stringify(state.data)); } catch (e) {}
      renderRail(); renderScenario();
      toast(meta.titulo + ' regerado.');
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar'; }
      toast((e && e.message) ? e.message : 'Erro ao regerar.', true);
    });
  }

  function setLoading(on, title) {
    state.generating = on;
    $('generate-btn').disabled = on;
    $('generate-btn').textContent = on ? 'Montando…' : 'Montar playbook';
    $('pb-empty').style.display = 'none';
    $('pb-loading').style.display = on ? 'block' : 'none';
    if (on && title) $('loading-title').textContent = title;
    if (on) $('pb-content').style.display = 'none';
  }

  // ============================================================ render
  function renderAll() {
    if (!state.data) return;
    renderSummary();
    renderRail();
    renderScenario();
    $('pb-empty').style.display = 'none';
    $('pb-loading').style.display = 'none';
    $('pb-content').style.display = 'block';
    $('ex-empty').style.display = 'none';
    $('ex-content').style.display = 'block';
    syncChannel();
  }

  function scenarioCount(id) {
    if (id === 'objecoes') return (state.data.objecoes || []).length;
    return (state.data.cenarios[id] || []).length;
  }

  function renderSummary() {
    var d = state.data;
    var total = 0; LINEAR_IDS.forEach(function (id) { total += (d.cenarios[id] || []).length; });
    var h = '<strong>Playbook de fechamento</strong> · ' + canalNome(d.canal) + ' · ' + total + ' mensagens + ' + (d.objecoes || []).length + ' objeções';
    if (d.resumo) h += ' — ' + esc(d.resumo);
    $('pb-summary').innerHTML = h;
    var e = '<strong>' + esc(d.produto.slice(0, 60)) + (d.produto.length > 60 ? '…' : '') + '</strong> · ' + canalNome(d.canal);
    $('ex-summary').innerHTML = e;
  }

  function renderRail() {
    var host = $('pb-rail');
    host.innerHTML = '';
    SCENARIOS.forEach(function (s) {
      var count = scenarioCount(s.id);
      var b = document.createElement('button');
      b.className = 'play-tab' + (s.id === state.activeScenario ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.innerHTML =
        '<span class="pt-ico">' + s.ico + '</span>' +
        '<span class="pt-meta">' +
          '<span class="pt-title">' + esc(s.titulo) + '</span>' +
          '<span class="pt-n">' + count + (s.id === 'objecoes' ? ' objeções' : ' msgs') + '</span>' +
        '</span>';
      b.addEventListener('click', function () { state.activeScenario = s.id; renderRail(); renderScenario(); });
      host.appendChild(b);
    });
  }

  function routeHtml(rota) {
    var parts = [];
    rota.forEach(function (n, i) {
      var goal = i === rota.length - 1;
      parts.push('<span class="node' + (goal ? ' goal' : '') + '">' + esc(n) + '</span>');
      if (!goal) parts.push('<span class="arrow">▸</span>');
    });
    return '<div class="route">' + parts.join('') + '</div>';
  }

  function bubbleHtml(m, time, allowCopy) {
    var side = m.de === 'lead' ? 'in' : 'out';
    var check = side === 'out' ? '<span class="b-check">✓✓</span>' : '';
    var copy = (allowCopy && side === 'out')
      ? '<button class="bubble-copy" data-copy="' + encodeURIComponent(m.texto) + '" title="Copiar mensagem" aria-label="Copiar mensagem">' + copyIcon() + '</button>' : '';
    var quando = m.quando ? '<div class="quando-tag">' + esc(fmtQuando(m.quando)) + '</div>' : '';
    return quando +
      '<div class="bubble-row ' + side + '">' + copy +
        '<div class="bubble"><span class="b-txt">' + waFormat(m.texto) + '</span>' +
        '<span class="b-time">' + time + ' ' + check + '</span></div>' +
      '</div>';
  }

  function renderScenario() {
    var id = state.activeScenario;
    var meta = scenMeta(id);
    var d = state.data;
    var host = $('pb-stage');
    var igCls = state.channel === 'instagram' ? ' ig' : '';

    var head =
      '<div class="play-head">' +
        '<div class="play-head-top">' +
          '<h3>' + meta.ico + ' ' + esc(meta.titulo) + '</h3>' +
          routeHtml(meta.rota) +
        '</div>' +
        '<div class="play-dica"><b>Como usar:</b> ' + esc(meta.dica) + '</div>' +
      '</div>';

    var bodyInner;
    if (id === 'objecoes') {
      if (!(d.objecoes && d.objecoes.length)) {
        bodyInner = '<div class="wa-frame' + igCls + '"><p style="color:var(--wa-time);text-align:center">Nenhuma objeção gerada.</p></div>';
      } else {
        var cards = d.objecoes.map(function (o) {
          var respMsgs = String(o.resposta).split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean);
          var respBubbles = respMsgs.map(function (t, j) { return bubbleHtml({ de: 'voce', texto: t, quando: '' }, fmtTime(600, j), false); }).join('');
          return '<div class="obj-card">' +
            '<div class="obj-head"><span class="shield">' +
              '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
              '</span>' + esc(o.objecao) + '</div>' +
            '<div class="obj-body wa-frame' + igCls + '" style="min-height:0">' + respBubbles + '</div>' +
            '<div class="obj-actions"><button class="mini-copy obj-copy" data-copy="' + encodeURIComponent(o.resposta) + '">Copiar resposta</button></div>' +
          '</div>';
        }).join('');
        bodyInner = '<div class="obj-grid">' + cards + '</div>';
      }
    } else {
      var list = d.cenarios[id] || [];
      if (!list.length) {
        bodyInner = '<div class="wa-frame' + igCls + '"><p style="color:var(--wa-time);text-align:center">Cenário vazio — clique em Regerar.</p></div>';
      } else {
        var startMin = 9 * 60 + (LINEAR_IDS.indexOf(id) * 12);
        var bubbles = list.map(function (m, i) { return bubbleHtml(m, fmtTime(startMin, i), true); }).join('');
        bodyInner = '<div class="wa-frame' + igCls + '"><div class="wa-day">' + (state.channel === 'instagram' ? 'Instagram Direct' : 'HOJE') + '</div>' + bubbles + '</div>';
      }
    }

    var actions =
      '<div class="card-actions">' +
        '<button class="mini-copy scen-copy" data-scen="' + id + '">Copiar cenário</button>' +
        '<button class="mini-copy regen" data-scen="' + id + '">↻ Regerar</button>' +
      '</div>';

    host.innerHTML = '<div class="play-card">' + head + '<div class="play-body">' + bodyInner + '</div>' + actions + '</div>';

    // wire copy buttons (bubbles + objection responses)
    host.querySelectorAll('.bubble-copy, .obj-copy').forEach(function (b) {
      b.addEventListener('click', function () {
        copyText(decodeURIComponent(b.getAttribute('data-copy')), function (ok) {
          if (ok) {
            b.classList.add('done');
            var wasIcon = b.classList.contains('bubble-copy');
            if (wasIcon) { b.innerHTML = '✓'; setTimeout(function () { b.classList.remove('done'); b.innerHTML = copyIcon(); }, 1100); }
            else { var o = b.textContent; b.textContent = '✓ Copiado'; setTimeout(function () { b.classList.remove('done'); b.textContent = o; }, 1100); }
            toast('Copiado!');
          } else toast('Não foi possível copiar.', true);
        });
      });
    });
    host.querySelectorAll('.scen-copy').forEach(function (b) { b.addEventListener('click', function () { copyScenario(id); }); });
    host.querySelectorAll('.regen').forEach(function (b) { b.addEventListener('click', function () { regenScenario(id); }); });
  }

  function copyIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }

  function syncChannel() {
    document.querySelectorAll('#chan-toggle .seg').forEach(function (s) {
      s.classList.toggle('active', s.getAttribute('data-chan') === state.channel);
    });
  }

  // ============================================================ text builders / exports
  function scenarioToText(id) {
    var d = state.data, meta = scenMeta(id), lines = [];
    lines.push('▸ ' + meta.titulo.toUpperCase());
    if (id === 'objecoes') {
      (d.objecoes || []).forEach(function (o, i) {
        lines.push((i + 1) + '. LEAD: ' + o.objecao);
        lines.push('   VOCÊ: ' + o.resposta);
      });
    } else {
      (d.cenarios[id] || []).forEach(function (m) {
        var who = m.de === 'lead' ? 'LEAD' : 'VOCÊ';
        var pre = m.quando ? '[' + fmtQuando(m.quando) + '] ' : '';
        lines.push(pre + who + ': ' + m.texto);
      });
    }
    return lines.join('\n');
  }
  function scenarioOutgoingOnly(id) {
    var d = state.data, lines = [];
    if (id === 'objecoes') {
      (d.objecoes || []).forEach(function (o) { lines.push('[' + o.objecao + ']'); lines.push(o.resposta); lines.push(''); });
    } else {
      (d.cenarios[id] || []).forEach(function (m) { if (m.de === 'voce') lines.push((m.quando ? '[' + fmtQuando(m.quando) + '] ' : '') + m.texto); });
    }
    return lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function copyScenario(id) {
    copyText(scenarioOutgoingOnly(id), function (ok) { toast(ok ? 'Cenário copiado!' : 'Não foi possível copiar.', !ok); });
  }
  function playbookToText() {
    var d = state.data, out = [];
    out.push('PLAYBOOK DE FECHAMENTO — ' + canalNome(d.canal));
    if (d.resumo) out.push(d.resumo);
    out.push('Produto: ' + d.produto);
    if (d.publico) out.push('Público: ' + d.publico);
    if (d.ticket) out.push('Ticket: ' + d.ticket);
    out.push('\n==============================\n');
    SCENARIOS.forEach(function (s) { out.push(scenarioToText(s.id)); out.push('\n------------------------------\n'); });
    out.push('Gerado por Fechamento IA — fechamentoia.appsbrasil.store');
    return out.join('\n');
  }
  function copyAll() { copyText(playbookToText(), function (ok) { toast(ok ? 'Playbook copiado!' : 'Não foi possível copiar.', !ok); }); }
  function copyActiveScenario() { copyScenario(state.activeScenario); }

  function slugify(s) { return String(s || 'fechamento').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'fechamento'; }
  function triggerDownload(url, filename) { var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); }

  function downloadTXT() {
    if (!state.data) return;
    var blob = new Blob([playbookToText()], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    triggerDownload(url, 'playbook-fechamento-' + slugify(state.data.produto) + '.txt');
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('TXT baixado!');
  }

  function downloadHTML() {
    if (!state.data) return;
    var d = state.data;
    var ig = d.canal === 'instagram';
    var outBg = ig ? 'linear-gradient(135deg,#7b2ff7,#4f5bd5)' : '#005c4b';
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#14211c;color:#ece6d6;margin:0;padding:28px;line-height:1.5}' +
      '.wrap{max-width:760px;margin:0 auto}h1{font-family:"Arial Narrow","Helvetica Neue",sans-serif;text-transform:uppercase;letter-spacing:.04em;font-size:30px;margin:0 0 4px;color:#ece6d6}' +
      '.badge{display:inline-block;background:rgba(55,217,176,.12);color:#37d9b0;border:1px solid rgba(55,217,176,.3);border-radius:100px;padding:4px 12px;font-size:11px;font-weight:700;letter-spacing:.05em}' +
      '.sub{color:#c3c8bd;font-size:13px;margin:6px 0}.meta{color:#8d968b;font-size:12px;margin:2px 0}' +
      '.scen{margin:24px 0;border:1.5px solid rgba(236,230,214,.14);border-radius:14px;overflow:hidden;background:#101b16}' +
      '.sh{padding:13px 16px;border-bottom:1.5px dashed rgba(236,230,214,.14);background:rgba(34,54,45,.5)}' +
      '.sh h2{font-family:"Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:.04em;font-size:20px;margin:0;color:#ece6d6}' +
      '.sh .dica{font-size:12px;color:#5fe8c6;margin-top:6px}' +
      '.wa{background:#0b141a;padding:14px}.row{display:flex;margin-bottom:7px}.row.out{justify-content:flex-end}.row.in{justify-content:flex-start}' +
      '.b{max-width:78%;padding:8px 11px;border-radius:10px;font-size:14px;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.3)}' +
      '.row.out .b{background:' + outBg + ';color:#e9edef;border-top-right-radius:3px}.row.in .b{background:#202c33;color:#e9edef;border-top-left-radius:3px}' +
      '.b strong{font-weight:700}.b em{font-style:italic}' +
      '.q{width:max-content;margin:8px auto 4px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#ffd23f;border:1px dashed rgba(255,210,63,.4);border-radius:100px;padding:3px 10px}' +
      '.objcard{border:1.5px solid rgba(236,230,214,.14);border-radius:12px;overflow:hidden;margin:10px 0}' +
      '.objh{padding:9px 12px;background:rgba(255,92,92,.1);border-bottom:1px solid rgba(255,92,92,.25);color:#ffbcbc;font-weight:700;font-size:13px}' +
      '.foot{color:#8d968b;font-size:11px;margin-top:24px;font-family:ui-monospace,Menlo,monospace}';
    function bubbleH(m) {
      var side = m.de === 'lead' ? 'in' : 'out';
      var q = m.quando ? '<div class="q">' + esc(fmtQuando(m.quando)) + '</div>' : '';
      return q + '<div class="row ' + side + '"><div class="b">' + waFormat(m.texto) + '</div></div>';
    }
    var body = '<div class="wrap"><span class="badge">Fechamento IA · Gênesis IA</span>' +
      '<h1>Playbook de Fechamento</h1>' +
      '<div class="sub">' + esc(canalNome(d.canal)) + (d.resumo ? ' — ' + esc(d.resumo) : '') + '</div>' +
      '<div class="meta">Produto: ' + esc(d.produto) + '</div>' +
      (d.publico ? '<div class="meta">Público: ' + esc(d.publico) + '</div>' : '') +
      (d.ticket ? '<div class="meta">Ticket: ' + esc(d.ticket) + '</div>' : '');
    SCENARIOS.forEach(function (s) {
      body += '<div class="scen"><div class="sh"><h2>' + esc(s.titulo) + '</h2><div class="dica">' + esc(s.dica) + '</div></div>';
      if (s.id === 'objecoes') {
        (d.objecoes || []).forEach(function (o) {
          var respMsgs = String(o.resposta).split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean);
          body += '<div class="objcard"><div class="objh">🛡️ ' + esc(o.objecao) + '</div><div class="wa">' +
            respMsgs.map(function (t) { return bubbleH({ de: 'voce', texto: t, quando: '' }); }).join('') + '</div></div>';
        });
      } else {
        body += '<div class="wa">' + (d.cenarios[s.id] || []).map(bubbleH).join('') + '</div>';
      }
      body += '</div>';
    });
    body += '<p class="foot">Gerado por Fechamento IA — fechamentoia.appsbrasil.store</p></div>';
    var doc = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Playbook de Fechamento — ' + esc(d.produto.slice(0, 40)) + '</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    triggerDownload(url, 'playbook-fechamento-' + slugify(d.produto) + '.html');
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('HTML baixado!');
  }

  // ============================================================ wiring
  function wireChips(groupId, onChange) {
    var g = $(groupId);
    g.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        g.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        if (onChange) onChange(c.getAttribute('data-val'));
      });
    });
  }
  function selectChipByVal(groupId, val) {
    if (!val) return;
    $(groupId).querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-val') === val); });
  }
  function wireTabs() {
    document.querySelectorAll('.stage-tabs .tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.stage-tabs .tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        $('tab-' + t.getAttribute('data-tab')).classList.add('active');
      });
    });
  }
  function setChannel(c) {
    state.channel = c;
    syncChannel();
    if (state.data) renderScenario();
  }

  function restore() {
    try {
      var b = JSON.parse(localStorage.getItem(BRIEF_STORE) || 'null');
      if (b) {
        if (b.produto) $('in-produto').value = b.produto;
        if (b.publico) $('in-publico').value = b.publico;
        if (b.ticket) $('in-ticket').value = b.ticket;
        if (b.vendedor) $('in-vendedor').value = b.vendedor;
        if (b.objecoesExtras) $('in-objecoes').value = b.objecoesExtras;
        selectChipByVal('chips-canal', b.canal);
        selectChipByVal('chips-tom', b.tom);
      }
      var c = JSON.parse(localStorage.getItem(PLAY_STORE) || 'null');
      if (c && (c.cenarios || c.objecoes)) {
        state.data = c; state.brief = b || {}; state.activeScenario = 'abertura'; state.channel = c.canal || 'whatsapp';
        renderAll();
      }
    } catch (e) {}
  }

  var inited = false;
  function init() {
    if (inited) return; inited = true;
    ApiKeyManager.renderModelPicker('model-select');
    wireChips('chips-canal');
    wireChips('chips-tom');
    wireTabs();
    $('generate-btn').addEventListener('click', generate);
    document.querySelectorAll('#chan-toggle .seg').forEach(function (s) {
      s.addEventListener('click', function () { setChannel(s.getAttribute('data-chan')); });
    });
    $('btn-copy-all').addEventListener('click', copyAll);
    $('btn-copy-scenario').addEventListener('click', copyActiveScenario);
    $('btn-download-html').addEventListener('click', downloadHTML);
    $('btn-download-txt').addEventListener('click', downloadTXT);
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
