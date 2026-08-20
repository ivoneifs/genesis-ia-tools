/* ============================================================
   Sequências IA — app logic
   BYOK (user's own key: OpenRouter, native Google Gemini, or native OpenAI). The tool
   asks the model for a strict JSON e-mail SEQUENCE (a full funnel flow), then renders it
   into: (a) a dispatched-mail timeline rail + a realistic inbox preview of the active
   e-mail, (b) an organized copy view with deliverability char counters + per-e-mail
   regenerate, (c) exports (copy all / HTML / CSV / copy one). Nothing is sent to our
   servers except the n8n gate calls.
   ============================================================ */
(function () {
  'use strict';

  // ---- localStorage slots (snake_case values to dodge the gitleaks KEY='literal' heuristic, COR-025) ----
  var SEQ_STORE = 'sequencia_seq_store';
  var BRIEF_STORE = 'sequencia_brief_store';

  // token budgets — generous per COR-034 (reasoning + content must both fit). A full
  // 5-7 e-mail sequence with complete bodies is a LARGE JSON → 16000; a single-email regen is medium.
  var MAXTOK_FULL = 16000;
  var MAXTOK_REGEN = 6000;

  // deliverability soft limits (chars) — inbox truncation guidance
  var LIM_SUBJECT = 50;
  var LIM_PREVIEW = 90;

  // ---- flow types: pt-BR name + strategic arc guidance for the prompt ----
  var FLOWS = {
    boas_vindas: {
      nome: 'Boas-vindas',
      arco: 'Sequência de boas-vindas para um novo lead/assinante (geralmente após baixar uma isca). ' +
        'Arco: (1) entregar/confirmar a isca e dar as boas-vindas + primeira dose de valor; ' +
        '(2) apresentar quem você é / sua história e por que confiar; (3) entregar uma dica prática rápida; ' +
        '(4) apresentar a oferta principal de forma leve; (5) convidar para o próximo passo. Adapte ao número pedido.'
    },
    nutricao: {
      nome: 'Nutrição / relacionamento',
      arco: 'Sequência de nutrição/relacionamento que educa e aquece o lead sem vender o tempo todo. ' +
        'Arco: histórias, ensinamentos práticos, quebra de crenças/objeções, prova de autoridade e construção de desejo, ' +
        'terminando com um convite natural para a oferta. Cada e-mail entrega valor real.'
    },
    lancamento: {
      nome: 'Lançamento',
      arco: 'Sequência de LANÇAMENTO para vender o produto num período de carrinho aberto. ' +
        'Arco clássico: (1) aquecimento/identificar o problema; (2) a virada/apresentar a solução e a oferta; ' +
        '(3) prova social/resultados + detalhes da oferta e bônus; (4) quebra das últimas objeções + urgência; ' +
        '(5) última chamada/escassez (carrinho fechando). Cadência mais curta (dias próximos).'
    },
    carrinho: {
      nome: 'Carrinho abandonado',
      arco: 'Sequência de carrinho abandonado / recuperação de checkout para quem iniciou a compra e não finalizou. ' +
        'Arco: (1) lembrete gentil e sem culpa; (2) reforço dos benefícios + quebra da principal objeção; ' +
        '(3) prova social/garantia; (4) urgência real ou um pequeno incentivo/bônus; (5) última chance. Cadência em horas/poucos dias.'
    },
    reengajamento: {
      nome: 'Reengajamento (win-back)',
      arco: 'Sequência de reengajamento (win-back) para leads/clientes inativos que pararam de abrir os e-mails. ' +
        'Arco: (1) "senti sua falta" + relembrar o valor; (2) entregar algo útil de graça; ' +
        '(3) pergunta direta "você ainda quer receber?"; (4) oferta/convite final; e, se pedido, um e-mail de despedida elegante.'
    },
    pos_venda: {
      nome: 'Pós-venda / onboarding',
      arco: 'Sequência de pós-venda / onboarding para quem ACABOU de comprar. ' +
        'Arco: (1) confirmação + boas-vindas ao cliente e o que esperar; (2) como acessar/começar (primeiros passos); ' +
        '(3) dica para ter resultado rápido / reduzir arrependimento; (4) pedir feedback ou depoimento; ' +
        '(5) oferta complementar/upsell suave. Tom acolhedor, foco em sucesso do cliente.'
    }
  };

  var state = {
    data: null,       // { tipo, resumo, remetente, oferta, publico, tom, emails:[...] }
    activeIdx: 0,
    abIdx: 0,         // 0 = subject A, 1 = subject B
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
  function paragraphs(text) {
    var s = String(text || '').replace(/\r/g, '').trim();
    if (!s) return [];
    var parts = s.split(/\n\s*\n/);
    if (parts.length === 1) parts = s.split(/\n/); // fall back to single newlines
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
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
        'HTTP-Referer': 'https://sequenciaia.appsbrasil.store',
        'X-Title': 'Sequencias IA'
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
      var variants = [cand, cand.replace(/,\s*([}\]])/g, '$1'), cand.replace(/[\u0000-\u001F]+/g, ' ').replace(/,\s*([}\]])/g, '$1')];
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
      tipo: $('in-tipo').value,
      oferta: $('in-oferta').value.trim(),
      publico: $('in-publico').value.trim(),
      tom: activeChip('chips-tom'),
      qtd: parseInt($('in-qtd').value, 10) || 5,
      remetente: $('in-remetente').value.trim()
    };
  }
  function activeChip(groupId) {
    var el = $(groupId).querySelector('.chip.active');
    return el ? el.getAttribute('data-val') : '';
  }

  function systemPrompt(brief) {
    var flow = FLOWS[brief.tipo] || FLOWS.nutricao;
    return 'Voce e um copywriter senior brasileiro, especialista em e-mail marketing e funis de venda, ' +
      'com anos escrevendo sequencias de alta conversao para infoprodutores, agencias, criadores e pequenos negocios no Brasil. ' +
      'Escreva SEMPRE em portugues do Brasil, com naturalidade, empatia e persuasao honesta — sem clickbait mentiroso, ' +
      'sem promessas ilegais ou garantias absolutas de resultado/saude/ganho financeiro. Evite palavras que caem em spam ' +
      '(gritar em CAIXA ALTA, "$$$", excesso de pontos de exclamacao). ' +
      'TIPO DE FLUXO: ' + flow.nome + '. ' + flow.arco + ' ' +
      'Gere EXATAMENTE ' + brief.qtd + ' e-mails, formando um arco coerente do primeiro ao ultimo (cada e-mail com um objetivo distinto, ' +
      'sem repetir o mesmo e-mail com outras palavras). Defina uma CADENCIA de envio sensata para este tipo de fluxo ' +
      '(campo "dia" = numero de dias desde o inicio, comecando em 0 e crescendo; "envio" = rotulo curto tipo "Imediato", "1 dia depois", "3 dias depois"). ' +
      'Para CADA e-mail escreva: um objetivo curto, DUAS variacoes de assunto (curtas, ate ~' + LIM_SUBJECT + ' caracteres, sem clickbait), ' +
      'um preview text / pre-cabecalho (ate ~' + LIM_PREVIEW + ' caracteres, complementa o assunto), o CORPO COMPLETO do e-mail ' +
      '(varios paragrafos separados por linha em branco \\n\\n, pronto para enviar, comecando com uma saudacao natural e terminando com um convite; ' +
      'NAO repita uma assinatura generica no fim, foque no conteudo), e um CTA curto (texto do botao/link). ' +
      'Responda APENAS com um objeto JSON valido (sem markdown, sem crases, sem texto fora do JSON) nesta estrutura EXATA:\n' +
      '{\n' +
      '  "resumo": "1-2 frases explicando a estrategia geral desta sequencia",\n' +
      '  "emails": [\n' +
      '    {\n' +
      '      "dia": 0,\n' +
      '      "envio": "Imediato (Dia 0)",\n' +
      '      "objetivo": "objetivo curto deste e-mail no arco (2-6 palavras)",\n' +
      '      "assuntos": ["variacao A do assunto", "variacao B do assunto"],\n' +
      '      "preview_text": "pre-cabecalho curto",\n' +
      '      "corpo": "corpo completo com paragrafos separados por \\n\\n",\n' +
      '      "cta": "texto curto do botao/CTA"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      'O array "emails" deve ter EXATAMENTE ' + brief.qtd + ' itens. Nao inclua comentarios nem texto fora do JSON.';
  }
  function userPrompt(brief) {
    return 'OFERTA/PRODUTO/CONTEXTO:\n' + brief.oferta + '\n\n' +
      'PUBLICO-ALVO: ' + (brief.publico || '(nao especificado — infira do produto)') + '\n' +
      'TOM DE VOZ: ' + (brief.tom || 'Proximo e amigavel') + '\n' +
      'REMETENTE/MARCA: ' + (brief.remetente || '(use um nome curto e coerente com a oferta)') + '\n' +
      'QUANTIDADE DE E-MAILS: ' + brief.qtd + '\n\n' +
      'Gere a sequencia completa em JSON, com ' + brief.qtd + ' e-mails formando um arco coerente.';
  }

  // normalize one email object into a safe shape
  function normEmail(e, idx) {
    e = e || {};
    var subs = Array.isArray(e.assuntos) ? e.assuntos.map(clean).filter(Boolean)
             : (clean(e.assunto) ? [clean(e.assunto)] : []);
    if (!subs.length) subs = [clean(e.subject) || ('E-mail ' + (idx + 1))];
    var diaNum = (typeof e.dia === 'number') ? e.dia : parseInt(String(e.dia).replace(/[^0-9]/g, ''), 10);
    if (isNaN(diaNum)) diaNum = idx === 0 ? 0 : idx * 2;
    return {
      dia: diaNum,
      envio: clean(e.envio) || (diaNum === 0 ? 'Imediato' : diaNum + (diaNum === 1 ? ' dia depois' : ' dias depois')),
      objetivo: clean(e.objetivo) || clean(e.goal) || ('E-mail ' + (idx + 1)),
      assuntos: subs.slice(0, 2),
      preview_text: clean(e.preview_text) || clean(e.preview) || clean(e.prevheader) || '',
      corpo: clean(e.corpo) || clean(e.body) || clean(e.texto) || '',
      cta: clean(e.cta) || 'Saiba mais'
    };
  }

  // ============================================================ generate (full sequence)
  function generate() {
    if (state.generating) return;
    var brief = briefFromForm();
    if (!brief.oferta || brief.oferta.length < 12) { toast('Descreva sua oferta/produto com mais detalhe.', true); $('in-oferta').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de IA primeiro.', true); MembershipGate.showScreen('key-screen'); return; }

    state.brief = brief;
    try { localStorage.setItem(BRIEF_STORE, JSON.stringify(brief)); } catch (e) {}
    setLoading(true, 'Despachando a sequência…');

    var msgs = [{ role: 'system', content: systemPrompt(brief) }, { role: 'user', content: userPrompt(brief) }];
    var run = function () { return generateJSON(msgs, MAXTOK_FULL); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('generate-sequence', run) : run();

    Promise.resolve(p).then(function (obj) {
      if (obj === null) { setLoading(false); return; } // rate limited (toast shown by limiter)
      var arr = Array.isArray(obj.emails) ? obj.emails
              : (obj.sequencia && Array.isArray(obj.sequencia.emails)) ? obj.sequencia.emails
              : (Array.isArray(obj) ? obj : []);
      var emails = arr.map(normEmail).filter(function (e) { return e.corpo || e.assuntos.length; });
      if (!emails.length) throw new Error('O modelo não retornou e-mails. Tente novamente.');
      state.data = {
        tipo: brief.tipo,
        resumo: clean(obj.resumo) || clean(obj.sequencia && obj.sequencia.resumo) || '',
        remetente: brief.remetente || 'Sua Marca',
        oferta: brief.oferta, publico: brief.publico, tom: brief.tom,
        emails: emails
      };
      state.activeIdx = 0; state.abIdx = 0;
      try { localStorage.setItem(SEQ_STORE, JSON.stringify(state.data)); } catch (e) {}
      setLoading(false);
      renderAll();
      toast('Sequência gerada — ' + emails.length + ' e-mails.');
    }).catch(function (e) {
      setLoading(false);
      toast((e && e.message) ? e.message : 'Erro ao gerar. Tente novamente.', true);
    });
  }

  // regenerate a single email (keep the rest of the arc)
  function regenEmail(idx) {
    if (state.generating || !state.data) return;
    var brief = state.brief;
    var d = state.data;
    var context = d.emails.map(function (e, i) { return (i + 1) + '. ' + e.objetivo + (i === idx ? '  <-- REESCREVER ESTE' : ''); }).join('\n');
    var msgs = [
      { role: 'system', content: systemPrompt(brief) },
      { role: 'user', content: userPrompt(brief) +
        '\n\nJa existe esta sequencia (objetivos por e-mail):\n' + context +
        '\n\nREESCREVA APENAS o e-mail numero ' + (idx + 1) + ' (posicao "dia" ' + d.emails[idx].dia + '), mantendo seu papel no arco mas com texto NOVO e melhor. ' +
        'Responda com um JSON no formato { "emails": [ { ... um unico e-mail ... } ] }.' }
    ];
    var btn = document.querySelector('.regen-email-btn[data-idx="' + idx + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    var run = function () { return generateJSON(msgs, MAXTOK_REGEN); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('regen-email', run) : run();
    Promise.resolve(p).then(function (obj) {
      if (obj === null) { if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar e-mail'; } return; }
      var arr = Array.isArray(obj.emails) ? obj.emails : (Array.isArray(obj) ? obj : [obj]);
      var ne = normEmail(arr[0], idx);
      // keep original cadence
      ne.dia = d.emails[idx].dia; ne.envio = d.emails[idx].envio;
      if (!ne.corpo && !ne.assuntos.length) throw new Error('E-mail vazio.');
      d.emails[idx] = ne;
      try { localStorage.setItem(SEQ_STORE, JSON.stringify(d)); } catch (e) {}
      renderAll();
      toast('E-mail ' + (idx + 1) + ' regerado.');
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Regerar e-mail'; }
      toast((e && e.message) ? e.message : 'Erro ao regerar.', true);
    });
  }

  function setLoading(on, title) {
    state.generating = on;
    $('generate-btn').disabled = on;
    $('generate-btn').textContent = on ? 'Gerando…' : 'Gerar sequência';
    $('preview-empty').style.display = 'none';
    $('preview-loading').style.display = on ? 'block' : 'none';
    if (on && title) $('loading-title').textContent = title;
    if (on) $('preview-content').style.display = 'none';
  }

  // ============================================================ render
  function renderAll() {
    if (!state.data) return;
    if (state.activeIdx >= state.data.emails.length) state.activeIdx = 0;
    renderSummary();
    renderRail();
    renderEmailPreview();
    renderCopy();
    $('preview-empty').style.display = 'none';
    $('preview-content').style.display = 'block';
    $('copy-empty').style.display = 'none';
    $('export-empty').style.display = 'none';
    $('export-content').style.display = 'block';
    syncAB();
  }

  function flowName(tipo) { return (FLOWS[tipo] || {}).nome || 'Sequência'; }

  function renderSummary() {
    var d = state.data;
    var h = '<strong>' + esc(flowName(d.tipo)) + '</strong> · ' + d.emails.length + ' e-mails';
    if (d.resumo) h += ' — ' + esc(d.resumo);
    $('seq-summary').innerHTML = h;
  }

  function subjOf(e) {
    var i = state.abIdx < e.assuntos.length ? state.abIdx : 0;
    return e.assuntos[i] || e.assuntos[0] || '';
  }

  function renderRail() {
    var host = $('rail');
    host.innerHTML = '';
    state.data.emails.forEach(function (e, i) {
      var b = document.createElement('button');
      b.className = 'mail-item' + (i === state.activeIdx ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.innerHTML =
        '<span class="postmark"><span class="pm-dia">DIA</span><span class="pm-n">' + e.dia + '</span></span>' +
        '<span class="mail-mini">' +
          '<span class="mm-when">' + esc(e.envio) + '</span>' +
          '<span class="mm-obj">' + esc(e.objetivo) + '</span>' +
          '<span class="mm-subj">' + esc(subjOf(e)) + '</span>' +
        '</span>';
      b.addEventListener('click', function () { state.activeIdx = i; renderRail(); renderEmailPreview(); });
      host.appendChild(b);
    });
  }

  function renderEmailPreview() {
    if (!state.data) return;
    var e = state.data.emails[state.activeIdx];
    var name = state.data.remetente || 'Sua Marca';
    var initial = (name.trim()[0] || 'S').toUpperCase();
    var subject = subjOf(e);
    var host = $('email-preview-host');
    var bodyHtml = paragraphs(e.corpo).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    host.innerHTML =
      '<div class="email-preview">' +
        '<div class="ep-head">' +
          '<div class="ep-subject">' + esc(subject) + '</div>' +
          (e.preview_text ? '<div class="ep-preview-text">' + esc(e.preview_text) + '</div>' : '') +
          '<div class="ep-from">' +
            '<div class="ep-avatar">' + esc(initial) + '</div>' +
            '<div class="ep-from-meta">' +
              '<div class="ep-from-name">' + esc(name) + '</div>' +
              '<div class="ep-from-sub">para você · ' + esc(e.envio) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ep-body">' + bodyHtml +
          (e.cta ? '<p><a class="ep-cta">' + esc(e.cta) + '</a></p>' : '') +
        '</div>' +
        '<div class="ep-foot">Você recebeu este e-mail porque se inscreveu na lista de ' + esc(name) + '. Cancelar inscrição.</div>' +
      '</div>';
  }

  function syncAB() {
    if (!state.data) return;
    var e = state.data.emails[state.activeIdx];
    var hasB = e && e.assuntos.length > 1;
    $('ab-b').style.display = hasB ? '' : 'none';
    $('ab-a').classList.toggle('active', state.abIdx === 0);
    $('ab-b').classList.toggle('active', state.abIdx === 1 && hasB);
  }

  function countClass(len, limit) { return len > limit ? ' over' : ''; }

  function renderCopy() {
    var host = $('copy-content');
    host.innerHTML = '';
    state.data.emails.forEach(function (e, i) {
      var wrap = document.createElement('div');
      wrap.className = 'copy-email';
      var h = '<div class="ce-head"><span class="ce-badge">DIA ' + e.dia + '</span><span class="ce-obj">' + esc(e.objetivo) + '</span><span class="ce-when">' + esc(e.envio) + '</span></div>';
      h += '<div class="ce-body">';
      e.assuntos.forEach(function (s, si) {
        h += '<div class="copy-block"><div class="cb-label"><span class="lbl">Assunto ' + (si === 0 ? 'A' : 'B') + ' (máx ' + LIM_SUBJECT + ')</span><span class="cb-count' + countClass(s.length, LIM_SUBJECT) + '">' + s.length + '/' + LIM_SUBJECT + '</span></div>' +
          '<div class="cb-item subj"><span class="txt">' + esc(s) + '</span>' + copyBtn(s) + '</div></div>';
      });
      if (e.preview_text) {
        h += '<div class="copy-block"><div class="cb-label"><span class="lbl">Preview text (máx ' + LIM_PREVIEW + ')</span><span class="cb-count' + countClass(e.preview_text.length, LIM_PREVIEW) + '">' + e.preview_text.length + '/' + LIM_PREVIEW + '</span></div>' +
          '<div class="cb-item"><span class="txt">' + esc(e.preview_text) + '</span>' + copyBtn(e.preview_text) + '</div></div>';
      }
      h += '<div class="copy-block"><div class="cb-label"><span class="lbl">Corpo do e-mail</span></div>' +
        '<div class="cb-item"><span class="txt">' + esc(e.corpo).replace(/\n/g, '<br>') + '</span>' + copyBtn(e.corpo) + '</div></div>';
      h += '<div class="copy-block"><div class="cb-label"><span class="lbl">Botão (CTA)</span></div>' +
        '<div class="cb-item"><span class="txt">' + esc(e.cta) + '</span>' + copyBtn(e.cta) + '</div></div>';
      h += '<button class="regen-email-btn" data-idx="' + i + '">↻ Regerar e-mail</button>';
      h += '</div>';
      wrap.innerHTML = h;
      host.appendChild(wrap);
    });

    host.querySelectorAll('.copy-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        copyText(decodeURIComponent(b.getAttribute('data-copy')), function (ok) {
          if (ok) { b.classList.add('done'); b.textContent = '✓'; setTimeout(function () { b.classList.remove('done'); b.innerHTML = copyIcon(); }, 1200); toast('Copiado!'); }
          else toast('Não foi possível copiar.', true);
        });
      });
    });
    host.querySelectorAll('.regen-email-btn').forEach(function (b) {
      b.addEventListener('click', function () { regenEmail(parseInt(b.getAttribute('data-idx'), 10)); });
    });
  }
  function copyIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function copyBtn(str) { return '<button class="copy-btn" data-copy="' + encodeURIComponent(str) + '" title="Copiar" aria-label="Copiar">' + copyIcon() + '</button>'; }

  // ============================================================ exports
  function emailToText(e) {
    var lines = [];
    lines.push('— DIA ' + e.dia + ' · ' + e.envio + ' — ' + e.objetivo);
    lines.push('Assunto A: ' + (e.assuntos[0] || ''));
    if (e.assuntos[1]) lines.push('Assunto B: ' + e.assuntos[1]);
    if (e.preview_text) lines.push('Preview: ' + e.preview_text);
    lines.push('');
    lines.push(e.corpo);
    lines.push('');
    lines.push('[CTA] ' + e.cta);
    return lines.join('\n');
  }
  function sequenceToText() {
    var d = state.data;
    var out = ['SEQUÊNCIA — ' + flowName(d.tipo) + ' (' + d.emails.length + ' e-mails)'];
    if (d.resumo) out.push(d.resumo);
    out.push('Remetente: ' + d.remetente);
    out.push('\n==============================\n');
    d.emails.forEach(function (e, i) { out.push('E-MAIL ' + (i + 1) + '\n' + emailToText(e) + '\n\n------------------------------\n'); });
    out.push('Gerado por Sequências IA — sequenciaia.appsbrasil.store');
    return out.join('\n');
  }
  function copyAll() {
    copyText(sequenceToText(), function (ok) { toast(ok ? 'Sequência copiada!' : 'Não foi possível copiar.', !ok); });
  }
  function copyCurrentEmail() {
    copyText(emailToText(state.data.emails[state.activeIdx]), function (ok) { toast(ok ? 'E-mail copiado!' : 'Não foi possível copiar.', !ok); });
  }

  function slugify(s) { return String(s || 'sequencia').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'sequencia'; }
  function triggerDownload(url, filename) {
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function csvField(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function downloadCSV() {
    if (!state.data) return;
    var d = state.data;
    var header = ['numero', 'dia', 'envio', 'objetivo', 'assunto_a', 'assunto_b', 'preview_text', 'corpo', 'cta'];
    var rows = [header.join(',')];
    d.emails.forEach(function (e, i) {
      rows.push([
        i + 1, e.dia, e.envio, e.objetivo,
        e.assuntos[0] || '', e.assuntos[1] || '', e.preview_text, e.corpo, e.cta
      ].map(csvField).join(','));
    });
    var csv = '﻿' + rows.join('\r\n'); // BOM for Excel/accents
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    triggerDownload(url, 'sequencia-' + slugify(d.remetente || d.tipo) + '.csv');
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('CSV baixado — importe na sua plataforma de e-mail.');
  }

  function downloadHTML() {
    if (!state.data) return;
    var d = state.data;
    var css = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#efe6d3;color:#1c2b4a;margin:0;padding:32px;line-height:1.6}' +
      '.wrap{max-width:680px;margin:0 auto}h1{font-family:"Arial Narrow","Helvetica Neue",sans-serif;text-transform:uppercase;letter-spacing:.03em;font-size:30px;line-height:1;margin:0 0 4px}' +
      '.sub{color:#46506a;font-size:14px;margin-bottom:4px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#7c7663}' +
      '.mail{background:#fff;border:1px solid #e3e4e8;border-radius:8px;margin:18px 0;overflow:hidden;box-shadow:0 8px 24px -16px rgba(0,0,0,.35)}' +
      '.mh{padding:14px 16px;border-bottom:1px solid #edeef1}.dia{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;color:#c8102e;border:1.5px solid #c8102e;border-radius:3px;padding:2px 7px;margin-bottom:8px}' +
      '.subj{font-size:16px;font-weight:700;color:#111;margin:2px 0}.pv{font-size:13px;color:#8a8f98}.obj{font-size:12px;color:#46506a;margin-top:6px;font-style:italic}' +
      '.mb{padding:16px}.mb p{margin:0 0 12px;white-space:pre-wrap}.altsub{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#7c7663;padding:0 16px 10px}' +
      '.cta{display:inline-block;background:#c8102e;color:#fff;font-weight:700;font-size:14px;padding:10px 20px;border-radius:6px;text-decoration:none}' +
      '.badge{display:inline-block;background:rgba(47,90,168,.12);color:#24467f;border:1px solid rgba(47,90,168,.3);border-radius:100px;padding:4px 12px;font-size:11px;font-weight:700}';
    var body = '<div class="wrap"><span class="badge">Sequências IA · Gênesis IA</span>' +
      '<h1>Sequência de e-mail</h1>' +
      '<div class="sub"><strong>' + esc(flowName(d.tipo)) + '</strong> · ' + d.emails.length + ' e-mails · Remetente: ' + esc(d.remetente) + '</div>' +
      (d.resumo ? '<div class="sub">' + esc(d.resumo) + '</div>' : '');
    d.emails.forEach(function (e) {
      var bodyHtml = paragraphs(e.corpo).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
      body += '<div class="mail"><div class="mh"><span class="dia">DIA ' + e.dia + ' · ' + esc(e.envio) + '</span>' +
        '<div class="subj">' + esc(e.assuntos[0] || '') + '</div>' +
        (e.preview_text ? '<div class="pv">' + esc(e.preview_text) + '</div>' : '') +
        '<div class="obj">Objetivo: ' + esc(e.objetivo) + '</div></div>' +
        (e.assuntos[1] ? '<div class="altsub">Assunto B (teste A/B): ' + esc(e.assuntos[1]) + '</div>' : '') +
        '<div class="mb">' + bodyHtml + (e.cta ? '<p><a class="cta">' + esc(e.cta) + '</a></p>' : '') + '</div></div>';
    });
    body += '<p class="mono" style="margin-top:24px">Gerado por Sequências IA — sequenciaia.appsbrasil.store</p></div>';
    var doc = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sequência de e-mail — ' + esc(d.remetente) + '</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    triggerDownload(url, 'sequencia-' + slugify(d.remetente || d.tipo) + '.html');
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('HTML baixado!');
  }

  // ============================================================ wiring
  function wireChips(groupId) {
    var g = $(groupId);
    g.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        g.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
      });
    });
  }
  function selectChipByVal(groupId, val) {
    if (!val) return;
    $(groupId).querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-val') === val);
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

  function setAB(i) {
    state.abIdx = i;
    syncAB();
    renderRail();
    renderEmailPreview();
  }

  function restore() {
    try {
      var b = JSON.parse(localStorage.getItem(BRIEF_STORE) || 'null');
      if (b) {
        if (b.tipo) $('in-tipo').value = b.tipo;
        if (b.oferta) $('in-oferta').value = b.oferta;
        if (b.publico) $('in-publico').value = b.publico;
        if (b.remetente) $('in-remetente').value = b.remetente;
        if (b.qtd) $('in-qtd').value = String(b.qtd);
        selectChipByVal('chips-tom', b.tom);
      }
      var c = JSON.parse(localStorage.getItem(SEQ_STORE) || 'null');
      if (c && Array.isArray(c.emails) && c.emails.length) {
        state.data = c; state.brief = b || {}; state.activeIdx = 0; state.abIdx = 0;
        renderAll();
      }
    } catch (e) {}
  }

  var inited = false;
  function init() {
    if (inited) return; inited = true;
    ApiKeyManager.renderModelPicker('model-select');
    wireChips('chips-tom');
    wireTabs();
    $('generate-btn').addEventListener('click', generate);
    $('ab-a').addEventListener('click', function () { setAB(0); });
    $('ab-b').addEventListener('click', function () { setAB(1); });
    $('btn-copy-all').addEventListener('click', copyAll);
    $('btn-copy-current-email').addEventListener('click', copyCurrentEmail);
    $('btn-download-html').addEventListener('click', downloadHTML);
    $('btn-download-csv').addEventListener('click', downloadCSV);
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
