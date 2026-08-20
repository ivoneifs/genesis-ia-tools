/**
 * VSL IA — Main Application Logic
 * Gera o roteiro de uma VSL (Carta de Vendas em Vídeo) em beats de resposta direta,
 * com timing por WPM, teleprompter (auto-scroll), regeneração por beat e export.
 *
 * BYOK: toda geração roda na chave do próprio usuário (Hard Rule #1).
 * LLM plumbing: COR-032 (reroll) / COR-034-035 (reasoning/deepseek) / COR-015 (null-strings).
 */
(function () {
  'use strict';

  // ── canonical direct-response VSL beats (fixed ids → deterministic render) ──
  var BEATS = [
    { id: 'gancho',    rotulo: 'Gancho / Lead',          funcao: 'Prender a atenção nos primeiros segundos' },
    { id: 'historia',  rotulo: 'História / Identificação', funcao: 'Criar conexão e fazer o espectador se identificar' },
    { id: 'problema',  rotulo: 'Agitação do Problema',    funcao: 'Ampliar a dor e o custo de continuar como está' },
    { id: 'mecanismo', rotulo: 'Mecanismo Único',         funcao: 'Apresentar a nova solução — o "como", a virada' },
    { id: 'oferta',    rotulo: 'Oferta & Stack de Valor', funcao: 'Apresentar o produto e empilhar o valor' },
    { id: 'prova',     rotulo: 'Prova & Autoridade',      funcao: 'Provar que funciona (casos, números, autoridade)' },
    { id: 'garantia',  rotulo: 'Garantia',                funcao: 'Remover o risco da decisão' },
    { id: 'escassez',  rotulo: 'Escassez & Urgência',     funcao: 'Dar um motivo real para agir agora' },
    { id: 'cta',       rotulo: 'Chamada para Ação (CTA)', funcao: 'Dizer exatamente o que fazer, passo a passo' }
  ];
  var BEAT_IDS = BEATS.map(function (b) { return b.id; });
  var BEAT_COLORS = ['#f5c451','#f0a93a','#e98b4e','#e0685f','#c9678f','#8f6fd0','#5f86d0','#4fb0c0','#46d08a'];

  // token budgets — generous (COR-034: reasoning + content must both fit).
  var MAXTOK_FULL = 16000;
  var MAXTOK_BEAT = 4000;
  var MAXTOK_HOOKS = 4000;

  // ── state ──
  var DATA = null;          // { titulo, ganchos:[{rotulo,narracao,estrategia}], beats:{id:{narracao,texto_tela,broll}} }
  var WPM = 150;            // palavras por minuto (velocidade de leitura)
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
  function wordCount(s) { s = clean(s); if (!s) return 0; return s.split(/\s+/).filter(Boolean).length; }
  function secsFor(text) { return Math.max(3, Math.round(wordCount(text) / WPM * 60)); }
  function tc(total) {
    total = Math.max(0, Math.round(total));
    var m = Math.floor(total / 60), s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function toast(msg, isErr) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = 'toast' + (isErr ? ' error' : ''); }, 2600);
  }
  function copyText(str, done) {
    function ok() { if (done) done(true); } function fail() { if (done) done(false); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(ok).catch(legacy); return;
      }
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
  function metaBeat(id) { for (var i = 0; i < BEATS.length; i++) if (BEATS[i].id === id) return BEATS[i]; return { id: id, rotulo: id, funcao: '' }; }

  // ============================================================ LLM (proven plumbing)
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
        'HTTP-Referer': 'https://vslia.appsbrasil.store',
        'X-Title': 'VSL IA'
      };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: maxTokens };
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034/035
    } else {
      // native OpenAI
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + active.key };
      var oa = model.indexOf('openai/') === 0 ? model.slice(7) : 'gpt-4o';
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

  function generateJSON(messages, maxTokens) {
    return fetchResilient(messages, 0.75, maxTokens).then(function (raw) {
      var obj = tryParse(raw); if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NAO era um JSON valido. Responda AGORA com APENAS o objeto JSON pedido — sem texto fora do JSON, sem markdown, sem crases. Use aspas retas.' }]);
      return fetchResilient(strict, 0.4, maxTokens).then(function (raw2) {
        var obj2 = tryParse(raw2); if (obj2) return obj2;
        throw new Error('O modelo nao devolveu um JSON valido. Tente gerar novamente ou troque de modelo.');
      });
    });
  }

  // ============================================================ brief + prompts
  function activeChip(groupId) {
    var g = $(groupId); return g ? (g.getAttribute('data-value') || '') : '';
  }
  function briefFromForm() {
    return {
      produto: $('in-produto').value.trim(),
      avatar: $('in-avatar').value.trim(),
      mecanismo: $('in-mecanismo').value.trim(),
      promessa: $('in-promessa').value.trim(),
      preco: $('in-preco').value.trim(),
      tom: activeChip('chips-tom') || 'Direto e confiante',
      dur: parseInt(activeChip('chips-dur') || '6', 10) || 6
    };
  }
  function briefBlock(b) {
    return 'PRODUTO/OFERTA: ' + (b.produto || '(não informado)') +
      '\nPÚBLICO-ALVO: ' + (b.avatar || '(não informado)') +
      '\nMECANISMO ÚNICO (o "como"): ' + (b.mecanismo || '(não informado)') +
      '\nPROMESSA/TRANSFORMAÇÃO: ' + (b.promessa || '(não informada)') +
      '\nPREÇO/TICKET: ' + (b.preco || '(não informado)') +
      '\nTOM DA NARRAÇÃO: ' + b.tom +
      '\nDURAÇÃO ALVO DO VÍDEO: cerca de ' + b.dur + ' minutos';
  }
  function beatSpec() {
    return BEATS.map(function (b, i) { return (i + 1) + '. "' + b.id + '" — ' + b.rotulo + ' (' + b.funcao + ')'; }).join('\n');
  }
  function targetWords(dur) { return Math.round(dur * WPM); } // ~WPM palavras/min faladas

  function systemPrompt() {
    return [
      'Você é um copywriter sênior de resposta direta especializado em VSL (Video Sales Letter / Carta de Vendas em Vídeo) para o mercado brasileiro de infoprodutos, agências e tráfego pago.',
      'Você escreve o ROTEIRO FALADO da VSL — a narração palavra por palavra que a pessoa vai LER no teleprompter e gravar. Não é uma página de vendas escrita, não é um post: é o texto para ser falado em vídeo.',
      'Escreva em português do Brasil, com naturalidade de FALA (frases curtas, ritmo, respiros), tom persuasivo mas honesto, sem clichê vazio e sem promessas ilegais/garantias irreais.',
      'Estruture SEMPRE na sequência clássica de resposta direta, sem pular etapas.',
      'Responda EXCLUSIVAMENTE com um objeto JSON válido (aspas retas, sem markdown, sem comentários, sem texto fora do JSON).'
    ].join(' ');
  }

  function userPromptFull(b) {
    return [
      'Crie o roteiro COMPLETO de uma VSL com base neste briefing:',
      '',
      briefBlock(b),
      '',
      'A VSL deve ter aproximadamente ' + targetWords(b.dur) + ' palavras no total (para ~' + b.dur + ' min de vídeo falado). Distribua o texto entre os beats de forma proporcional (gancho curto; problema, mecanismo e oferta mais longos).',
      '',
      'Entregue os seguintes BEATS, nesta ordem e com estes ids exatos:',
      beatSpec(),
      '',
      'Para CADA beat, escreva:',
      '- "narracao": o texto falado PALAVRA POR PALAVRA daquele trecho (pronto para ler no teleprompter). Fala natural, primeira/segunda pessoa, sem rubricas dentro do texto.',
      '- "texto_tela": uma frase curta de LEGENDA/TEXTO NA TELA para reforçar o ponto (ou "" se não precisar).',
      '- "broll": uma sugestão curta de imagem/B-roll para mostrar durante esse trecho (ou "" ).',
      '',
      'Além dos beats, entregue "ganchos": um array com 3 GANCHOS ALTERNATIVOS de abertura para testar (A/B). Cada um: { "rotulo": rótulo curto do estilo do gancho (ex.: "Pergunta provocadora", "Estatística chocante", "Micro-história"), "narracao": o texto falado da abertura, "estrategia": 1 frase explicando por que esse gancho funciona }. O primeiro gancho deve ser o mesmo texto do beat "gancho".',
      '',
      'Formato EXATO de saída (preencha os valores):',
      '{',
      '  "titulo": "título interno curto da VSL",',
      '  "ganchos": [ { "rotulo": "...", "narracao": "...", "estrategia": "..." }, {...}, {...} ],',
      '  "beats": [',
      '    { "id": "gancho", "narracao": "...", "texto_tela": "...", "broll": "..." },',
      '    { "id": "historia", "narracao": "...", "texto_tela": "...", "broll": "..." },',
      '    ... (todos os 9 ids na ordem)',
      '  ]',
      '}'
    ].join('\n');
  }

  function userPromptBeat(b, beatId, currentText) {
    var m = metaBeat(beatId);
    return [
      'Reescreva APENAS o beat "' + beatId + '" (' + m.rotulo + ' — ' + m.funcao + ') do roteiro desta VSL, com um ângulo/versão diferente do atual, mantendo o mesmo tom e coerência com o resto.',
      '',
      briefBlock(b),
      '',
      'Versão atual deste beat (para você variar, NÃO repetir igual):',
      (clean(currentText) || '(vazio)'),
      '',
      'Responda EXCLUSIVAMENTE com um JSON: { "narracao": "novo texto falado deste beat", "texto_tela": "...", "broll": "..." }'
    ].join('\n');
  }

  function userPromptHooks(b) {
    return [
      'Gere 3 NOVOS ganchos de abertura ALTERNATIVOS para a VSL abaixo, diferentes entre si e prontos para testar (A/B). Cada gancho é o texto FALADO dos primeiros segundos do vídeo.',
      '',
      briefBlock(b),
      '',
      'Responda EXCLUSIVAMENTE com um JSON: { "ganchos": [ { "rotulo": "estilo curto do gancho", "narracao": "texto falado da abertura", "estrategia": "1 frase do porquê funciona" }, {...}, {...} ] }'
    ].join('\n');
  }

  // ============================================================ normalization
  function normBeats(arr) {
    var map = {};
    (Array.isArray(arr) ? arr : []).forEach(function (o) { if (o && o.id) map[String(o.id).trim()] = o; });
    var out = {};
    BEAT_IDS.forEach(function (id, i) {
      var o = map[id] || (Array.isArray(arr) ? arr[i] : null) || {};
      out[id] = { narracao: clean(o.narracao || o.texto || o.text || ''), texto_tela: clean(o.texto_tela || o.tela || ''), broll: clean(o.broll || o.b_roll || o.imagem || '') };
    });
    return out;
  }
  function normHooks(arr) {
    var out = (Array.isArray(arr) ? arr : []).map(function (o) {
      o = o || {};
      return { rotulo: clean(o.rotulo || o.titulo || 'Gancho'), narracao: clean(o.narracao || o.texto || ''), estrategia: clean(o.estrategia || o.porque || '') };
    }).filter(function (h) { return h.narracao; });
    return out.slice(0, 5);
  }

  // ============================================================ render
  function totalSeconds() {
    if (!DATA) return 0;
    var t = 0; BEAT_IDS.forEach(function (id) { t += secsFor(DATA.beats[id].narracao); }); return t;
  }
  function fullNarration() {
    return BEAT_IDS.map(function (id) { return DATA.beats[id].narracao; }).filter(Boolean).join('\n\n');
  }

  function renderOutput() {
    var out = $('vsl-output');
    var empty = $('empty-state');
    if (!DATA) { if (empty) empty.hidden = false; out.hidden = true; out.innerHTML = ''; return; }
    if (empty) empty.hidden = true;
    out.hidden = false;

    var html = '';
    // toolbar
    html += '<div class="stage-toolbar">';
    html += '<span class="runtime-total" id="rt-total"><span id="rt-val">' + tc(totalSeconds()) + '</span><small>RUNTIME</small></span>';
    html += '<span class="wpm-control">Ritmo <input type="range" id="wpm-range" min="90" max="220" step="5" value="' + WPM + '"><span class="wpm-val" id="wpm-val">' + WPM + '</span> ppm</span>';
    html += '<span class="toolbar-spacer"></span>';
    html += '<button class="btn-tool rec" id="btn-tp">▶ Teleprompter</button>';
    html += '<button class="btn-tool" id="btn-copy-all">Copiar tudo</button>';
    html += '<button class="btn-tool" id="btn-exp-html">Exportar .html</button>';
    html += '<button class="btn-tool" id="btn-exp-txt">Exportar .txt</button>';
    html += '</div>';

    html += '<div class="stage-body">';

    // runtime ruler
    html += '<div class="ruler-wrap"><div class="ruler-label"><span class="eyebrow">Linha do tempo</span><span class="rt" id="ruler-rt"></span></div>';
    html += '<div class="ruler" id="ruler"></div>';
    html += '<div class="ruler-scale"><span>00:00</span><span id="ruler-end"></span></div></div>';

    // hooks
    html += '<div class="stage-section-head first"><span class="eyebrow">Ganchos para testar (A/B)</span><span class="rule"></span>';
    html += '<button class="beat-act" id="btn-new-hooks" title="Gerar novos ganchos">↻ Novos ganchos</button></div>';
    html += '<div class="hooks-grid" id="hooks-grid"></div>';

    // beats
    html += '<div class="stage-section-head"><span class="eyebrow">Roteiro em beats</span><span class="rule"></span></div>';
    html += '<div class="beats-list" id="beats-list"></div>';

    html += '</div>';
    out.innerHTML = html;

    renderRuler(); renderHooks(); renderBeats();
    wireOutput();
  }

  function renderRuler() {
    var ruler = $('ruler'); if (!ruler) return;
    var total = totalSeconds() || 1;
    var html = '';
    BEAT_IDS.forEach(function (id, i) {
      var s = secsFor(DATA.beats[id].narracao);
      var pct = (s / total) * 100;
      var m = metaBeat(id);
      html += '<div class="ruler-seg" data-beat="' + id + '" title="' + esc(m.rotulo) + ' — ' + tc(s) + '" style="flex:' + pct.toFixed(3) + ' 1 0;background:' + BEAT_COLORS[i] + '">';
      html += '<span class="seg-tag">' + esc(m.rotulo.split(' ')[0]) + '</span></div>';
    });
    ruler.innerHTML = html;
    var end = $('ruler-end'); if (end) end.textContent = tc(total);
    var rt = $('ruler-rt'); if (rt) rt.textContent = BEAT_IDS.length + ' beats · ' + tc(total) + ' · ' + wordCount(fullNarration()) + ' palavras';
    // clicking a segment scrolls to its beat
    Array.prototype.forEach.call(ruler.querySelectorAll('.ruler-seg'), function (seg) {
      seg.addEventListener('click', function () {
        var el = document.querySelector('.beat[data-beat="' + seg.getAttribute('data-beat') + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  function renderHooks() {
    var grid = $('hooks-grid'); if (!grid) return;
    var hooks = DATA.ganchos || [];
    var chosen = DATA.beats.gancho.narracao;
    if (!hooks.length) { grid.innerHTML = '<p style="color:var(--faint);font-size:13px">Sem ganchos alternativos. Clique em “Novos ganchos”.</p>'; return; }
    grid.innerHTML = hooks.map(function (h, i) {
      var isChosen = clean(h.narracao) === clean(chosen);
      return '<div class="hook-card' + (isChosen ? ' chosen' : '') + '">' +
        '<span class="hook-tag">Gancho ' + String.fromCharCode(65 + i) + (h.rotulo ? ' · ' + esc(h.rotulo) : '') + '</span>' +
        '<div class="hook-text">' + esc(h.narracao) + '</div>' +
        (h.estrategia ? '<div class="hook-strat">' + esc(h.estrategia) + '</div>' : '') +
        '<div class="hook-actions">' +
        '<button class="hook-mini use" data-hook="' + i + '">' + (isChosen ? 'Em uso' : 'Usar este gancho') + '</button>' +
        '<button class="hook-mini" data-copyhook="' + i + '">Copiar</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('[data-hook]'), function (btn) {
      btn.addEventListener('click', function () { swapHook(parseInt(btn.getAttribute('data-hook'), 10)); });
    });
    Array.prototype.forEach.call(grid.querySelectorAll('[data-copyhook]'), function (btn) {
      btn.addEventListener('click', function () {
        var h = hooks[parseInt(btn.getAttribute('data-copyhook'), 10)];
        copyText(h.narracao, function (ok) { toast(ok ? 'Gancho copiado' : 'Falha ao copiar', !ok); });
      });
    });
  }

  function renderBeats() {
    var list = $('beats-list'); if (!list) return;
    list.innerHTML = BEAT_IDS.map(function (id, i) {
      var m = metaBeat(id); var d = DATA.beats[id]; var s = secsFor(d.narracao);
      var cues = '';
      if (d.texto_tela) cues += '<div class="cue tela"><span class="cue-tag">Tela</span><span class="cue-text">' + esc(d.texto_tela) + '</span></div>';
      if (d.broll) cues += '<div class="cue broll"><span class="cue-tag">B-roll</span><span class="cue-text">' + esc(d.broll) + '</span></div>';
      return '<div class="beat" data-beat="' + id + '">' +
        '<div class="beat-head"><span class="beat-num">' + (i + 1) + '</span>' +
        '<div class="beat-titles"><div class="beat-label">' + esc(m.rotulo) + '</div><div class="beat-func">' + esc(m.funcao) + '</div></div>' +
        '<span class="beat-dur" data-dur="' + id + '">' + tc(s) + '</span></div>' +
        '<div class="beat-body"><div class="beat-narr">' + esc(d.narracao || '(vazio)') + '</div>' +
        (cues ? '<div class="beat-cues">' + cues + '</div>' : '') +
        '<div class="beat-actions">' +
        '<button class="beat-act" data-copy="' + id + '">Copiar</button>' +
        '<button class="beat-act" data-regen="' + id + '">↻ Regenerar</button>' +
        '</div></div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-copy]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-copy');
        copyText(DATA.beats[id].narracao, function (ok) { toast(ok ? 'Beat copiado' : 'Falha ao copiar', !ok); });
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-regen]'), function (btn) {
      btn.addEventListener('click', function () { regenBeat(btn.getAttribute('data-regen'), btn); });
    });
  }

  function refreshTimings() {
    // update ruler + beat dur badges + runtime total without full re-render
    var rv = $('rt-val'); if (rv) rv.textContent = tc(totalSeconds());
    renderRuler();
    BEAT_IDS.forEach(function (id) {
      var el = document.querySelector('[data-dur="' + id + '"]');
      if (el) el.textContent = tc(secsFor(DATA.beats[id].narracao));
    });
  }

  function wireOutput() {
    var tp = $('btn-tp'); if (tp) tp.addEventListener('click', openTeleprompter);
    var ca = $('btn-copy-all'); if (ca) ca.addEventListener('click', function () {
      copyText(buildTXT(), function (ok) { toast(ok ? 'Roteiro copiado' : 'Falha ao copiar', !ok); });
    });
    var eh = $('btn-exp-html'); if (eh) eh.addEventListener('click', exportHTML);
    var et = $('btn-exp-txt'); if (et) et.addEventListener('click', exportTXT);
    var nh = $('btn-new-hooks'); if (nh) nh.addEventListener('click', function () { regenHooks(nh); });
    var wr = $('wpm-range');
    if (wr) wr.addEventListener('input', function () {
      WPM = parseInt(wr.value, 10) || 150;
      var wv = $('wpm-val'); if (wv) wv.textContent = WPM;
      refreshTimings();
    });
  }

  // ============================================================ actions
  function setBusy(v) { busy = v; var g = $('generate-btn'); if (g) { g.disabled = v; g.textContent = v ? 'Gerando roteiro...' : 'Gerar roteiro de VSL'; } }

  function generate() {
    if (busy) return;
    var b = briefFromForm();
    if (!b.produto) { toast('Descreva o produto/oferta primeiro.', true); $('in-produto').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de API (ícone da chave no topo).', true); ApiKeyManager && document.getElementById('manage-keys-btn') && document.getElementById('manage-keys-btn').click(); return; }
    setBusy(true);
    // show generating overlay
    var out = $('vsl-output'), empty = $('empty-state');
    if (empty) empty.hidden = true; out.hidden = false;
    out.innerHTML = '<div class="gen-overlay"><div class="gen-ring"></div><h3>Escrevendo sua VSL…</h3><p>Montando gancho, história, problema, mecanismo, oferta, prova, garantia, escassez e CTA.</p></div>';

    var msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPromptFull(b) }];
    var call = function () { return generateJSON(msgs, MAXTOK_FULL); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('vsl-generate', call) : call();
    Promise.resolve(p).then(function (obj) {
      var beats = normBeats(obj.beats || obj.roteiro || []);
      var hooks = normHooks(obj.ganchos || obj.hooks || []);
      // ensure gancho beat + hooks are consistent
      if (!beats.gancho.narracao && hooks[0]) beats.gancho.narracao = hooks[0].narracao;
      if (!hooks.length && beats.gancho.narracao) hooks = [{ rotulo: 'Gancho principal', narracao: beats.gancho.narracao, estrategia: '' }];
      DATA = { titulo: clean(obj.titulo) || 'VSL', brief: b, ganchos: hooks, beats: beats };
      // basic sanity: at least a few beats filled
      var filled = BEAT_IDS.filter(function (id) { return DATA.beats[id].narracao; }).length;
      if (filled < 4) { throw new Error('O modelo devolveu poucos beats. Tente gerar novamente ou troque de modelo.'); }
      renderOutput();
      toast('Roteiro pronto — ' + tc(totalSeconds()) + ' de vídeo');
    }).catch(function (e) {
      DATA = null; renderOutput();
      toast(friendly(e), true);
    }).then(function () { setBusy(false); });
  }

  function regenBeat(id, btn) {
    if (busy || !DATA) return;
    var orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Gerando';
    var msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPromptBeat(DATA.brief, id, DATA.beats[id].narracao) }];
    var call = function () { return generateJSON(msgs, MAXTOK_BEAT); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('vsl-beat', call) : call();
    Promise.resolve(p).then(function (obj) {
      var narr = clean(obj.narracao || obj.texto || '');
      if (!narr) throw new Error('Resposta vazia.');
      DATA.beats[id] = { narracao: narr, texto_tela: clean(obj.texto_tela) || DATA.beats[id].texto_tela, broll: clean(obj.broll) || DATA.beats[id].broll };
      if (id === 'gancho') { /* keep hooks in sync visually */ }
      renderOutput();
      var el = document.querySelector('.beat[data-beat="' + id + '"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Beat regenerado');
    }).catch(function (e) {
      btn.disabled = false; btn.innerHTML = orig;
      toast(friendly(e), true);
    });
  }

  function regenHooks(btn) {
    if (busy || !DATA) return;
    var orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Gerando';
    var msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPromptHooks(DATA.brief) }];
    var call = function () { return generateJSON(msgs, MAXTOK_HOOKS); };
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('vsl-hooks', call) : call();
    Promise.resolve(p).then(function (obj) {
      var hooks = normHooks(obj.ganchos || obj.hooks || []);
      if (!hooks.length) throw new Error('Nenhum gancho novo.');
      DATA.ganchos = hooks;
      renderOutput();
      toast('3 novos ganchos gerados');
    }).catch(function (e) {
      btn.disabled = false; btn.innerHTML = orig;
      toast(friendly(e), true);
    });
  }

  function swapHook(i) {
    if (!DATA || !DATA.ganchos[i]) return;
    DATA.beats.gancho.narracao = DATA.ganchos[i].narracao;
    renderOutput();
    toast('Gancho ' + String.fromCharCode(65 + i) + ' aplicado ao roteiro');
  }

  function friendly(e) {
    var m = (e && e.message) || 'Algo deu errado.';
    if (/401|invalid.*key|no auth|unauthor/i.test(m)) return 'Chave de API inválida. Confira em “Chaves”.';
    if (/429|rate|limit/i.test(m)) return 'Limite de uso atingido no provedor. Aguarde um pouco.';
    if (/quota|billing|credit|exhaust/i.test(m)) return 'Sua conta do provedor está sem créditos/limite.';
    if (/Nenhuma chave/i.test(m)) return m;
    return m;
  }

  // ============================================================ export
  function buildTXT() {
    if (!DATA) return '';
    var lines = [];
    lines.push('VSL — ' + (DATA.titulo || 'Roteiro'));
    lines.push('Runtime estimado: ' + tc(totalSeconds()) + ' (~' + WPM + ' palavras/min) · ' + wordCount(fullNarration()) + ' palavras');
    lines.push('Gerado por VSL IA — Gênesis IA');
    lines.push(''); lines.push('========================================'); lines.push('');
    BEAT_IDS.forEach(function (id, i) {
      var m = metaBeat(id); var d = DATA.beats[id];
      lines.push('[' + (i + 1) + '] ' + m.rotulo.toUpperCase() + '  (' + tc(secsFor(d.narracao)) + ')');
      lines.push('');
      lines.push(d.narracao || '');
      if (d.texto_tela) lines.push('   > TEXTO NA TELA: ' + d.texto_tela);
      if (d.broll) lines.push('   > B-ROLL: ' + d.broll);
      lines.push(''); lines.push('----------------------------------------'); lines.push('');
    });
    if (DATA.ganchos && DATA.ganchos.length > 1) {
      lines.push('GANCHOS ALTERNATIVOS (A/B):'); lines.push('');
      DATA.ganchos.forEach(function (h, i) {
        lines.push('Gancho ' + String.fromCharCode(65 + i) + (h.rotulo ? ' — ' + h.rotulo : '') + ':');
        lines.push(h.narracao);
        if (h.estrategia) lines.push('(' + h.estrategia + ')');
        lines.push('');
      });
    }
    return lines.join('\n');
  }

  function download(name, mime, content) {
    try {
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    } catch (e) { toast('Falha ao exportar.', true); }
  }
  function slug() { return (DATA && DATA.titulo ? DATA.titulo : 'vsl').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vsl'; }

  function exportTXT() { if (!DATA) return; download('roteiro-' + slug() + '.txt', 'text/plain;charset=utf-8', buildTXT()); toast('.txt exportado'); }

  function buildHTML() {
    // self-contained teleprompter HTML — inline CSS + JS, no external refs, no keys
    var blocks = BEAT_IDS.map(function (id) {
      var m = metaBeat(id); var d = DATA.beats[id];
      return { tag: m.rotulo, text: d.narracao || '' };
    }).filter(function (x) { return x.text; });
    var payload = JSON.stringify({ titulo: DATA.titulo || 'VSL', wpm: WPM, blocks: blocks });
    var doc = '';
    doc += '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
    doc += '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    doc += '<title>Teleprompter — ' + esc(DATA.titulo || 'VSL') + '</title><style>';
    doc += '*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}body{background:#050607;color:#f3efe6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden}';
    doc += '.bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 18px;background:#0a0c0f;border-bottom:1px solid #2a313b}';
    doc += '.tc{font-family:ui-monospace,Menlo,monospace;font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}.tc .rec{width:12px;height:12px;border-radius:50%;background:#ff3b30;box-shadow:0 0 12px #ff3b30}.tc.paused .rec{background:#6c7684;box-shadow:none}';
    doc += '.ctr{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}button{font-family:inherit;cursor:pointer;border-radius:10px;border:1px solid #363f4b;background:#14181e;color:#dfe3ea;font-size:13px;font-weight:700;padding:9px 14px}button.play{background:#f5c451;color:#14130c;border-color:#f5c451;min-width:120px}';
    doc += 'label{font-size:12px;color:#97a0ae;display:flex;align-items:center;gap:8px}input[type=range]{accent-color:#f5c451;width:120px}.v{font-family:ui-monospace,monospace;color:#f3efe6;font-weight:700;min-width:60px}';
    doc += '.vp{position:relative;height:calc(100vh - 60px);overflow:hidden}.line{position:absolute;top:42%;left:0;right:0;height:128px;z-index:2;pointer-events:none;background:linear-gradient(180deg,transparent,rgba(245,196,81,.09) 50%,transparent);border-top:1px solid rgba(245,196,81,.35);border-bottom:1px solid rgba(245,196,81,.35)}';
    doc += '.ft,.fb{position:absolute;left:0;right:0;height:120px;z-index:3;pointer-events:none}.ft{top:0;background:linear-gradient(180deg,#050607,transparent)}.fb{bottom:0;background:linear-gradient(0deg,#050607,transparent)}';
    doc += '.scroll{position:absolute;top:0;left:0;right:0;padding:42vh 8vw 60vh;will-change:transform}.scroll.mirror{transform:scaleX(-1)}';
    doc += '.blk{margin-bottom:46px}.blk .t{font-family:ui-monospace,monospace;font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#e0a92e;margin-bottom:14px}.blk .x{font-size:clamp(28px,4.4vw,54px);line-height:1.32;font-weight:700;white-space:pre-wrap}';
    doc += '</style></head><body>';
    doc += '<div class="bar"><span class="tc paused" id="tc"><span class="rec"></span><span id="t">00:00</span> / <span id="tt" style="color:#97a0ae">00:00</span></span>';
    doc += '<div class="ctr"><label>Ritmo <input type="range" id="wpm" min="90" max="220" step="5" value="' + WPM + '"><span class="v" id="wv">' + WPM + ' ppm</span></label>';
    doc += '<button id="mir">Espelhar</button><button id="rst">↺</button><button class="play" id="pl">▶ Reproduzir</button></div></div>';
    doc += '<div class="vp"><div class="ft"></div><div class="line"></div><div class="fb"></div><div class="scroll" id="s"></div></div>';
    doc += '<script>var D=' + payload + ';var WPM=D.wpm||150;var S=document.getElementById("s");';
    doc += 'function wc(t){t=(t||"").trim();return t?t.split(/\\s+/).length:0}var TW=0;D.blocks.forEach(function(b){TW+=wc(b.text)});';
    doc += 'S.innerHTML=D.blocks.map(function(b){return \'<div class="blk"><div class="t">\'+b.tag.replace(/[<>&]/g,"")+\'</div><div class="x">\'+b.text.replace(/[<]/g,"&lt;")+\'</div></div>\'}).join("");';
    doc += 'function fmt(x){x=Math.max(0,Math.round(x));var m=Math.floor(x/60),s=x%60;return (m<10?"0":"")+m+":"+(s<10?"0":"")+s}';
    doc += 'var playing=false,prog=0,base=0,startT=0,maxTr=0,dur=0,raf=0;var vp=document.querySelector(".vp");';
    doc += 'function recalc(){maxTr=Math.max(1,S.scrollHeight-vp.clientHeight);dur=Math.max(1,TW/WPM*60)*1000}';
    doc += 'function frame(now){if(!playing)return;prog=base+(now-startT)/dur;if(prog>=1){prog=1;playing=false;setPlay()}S.style.transform="translateY("+(-maxTr*prog)+"px)";document.getElementById("t").textContent=fmt(prog*dur/1000);if(playing)raf=requestAnimationFrame(frame)}';
    doc += 'function setPlay(){var b=document.getElementById("pl");b.textContent=playing?"⏸ Pausar":"▶ Reproduzir";document.getElementById("tc").className="tc"+(playing?"":" paused")}';
    doc += 'function play(){recalc();if(prog>=1){prog=0}base=prog;startT=performance.now();playing=true;setPlay();raf=requestAnimationFrame(frame)}';
    doc += 'function pause(){playing=false;base=prog;cancelAnimationFrame(raf);setPlay()}';
    doc += 'document.getElementById("pl").onclick=function(){playing?pause():play()};';
    doc += 'document.getElementById("rst").onclick=function(){pause();prog=0;base=0;S.style.transform="translateY(0)";document.getElementById("t").textContent="00:00"};';
    doc += 'document.getElementById("mir").onclick=function(){S.classList.toggle("mirror")};';
    doc += 'document.getElementById("wpm").oninput=function(){WPM=parseInt(this.value,10)||150;document.getElementById("wv").textContent=WPM+" ppm";base=prog;startT=performance.now();recalc();document.getElementById("tt").textContent=fmt(dur/1000)};';
    doc += 'window.addEventListener("resize",function(){var p=prog;recalc();S.style.transform="translateY("+(-maxTr*p)+"px)"});';
    doc += 'recalc();document.getElementById("tt").textContent=fmt(dur/1000);';
    doc += '<\/script></body></html>';
    return doc;
  }
  function exportHTML() { if (!DATA) return; download('teleprompter-' + slug() + '.html', 'text/html;charset=utf-8', buildHTML()); toast('.html exportado'); }

  // ============================================================ Teleprompter (in-app overlay)
  var TP = { playing: false, prog: 0, base: 0, startT: 0, maxTr: 0, dur: 0, raf: 0, wpm: 150, built: false };
  function tpEl(id) { return document.getElementById(id); }

  function openTeleprompter() {
    if (!DATA) return;
    var ov = $('teleprompter'); if (!ov) return;
    TP.wpm = WPM;
    var scroll = $('tp-scroll');
    var blocks = BEAT_IDS.map(function (id) { var m = metaBeat(id); var d = DATA.beats[id]; return { tag: m.rotulo, text: d.narracao }; }).filter(function (x) { return x.text; });
    scroll.classList.remove('mirror');
    scroll.innerHTML = blocks.length ? blocks.map(function (b) {
      return '<div class="tp-block"><span class="tp-tag">' + esc(b.tag) + '</span><div class="tp-text">' + esc(b.text) + '</div></div>';
    }).join('') : '<div class="tp-empty">Roteiro vazio.</div>';
    scroll.style.transform = 'translateY(0)';
    TP.playing = false; TP.prog = 0; TP.base = 0;
    ov.hidden = false;
    var wr = $('tp-wpm'); if (wr) { wr.value = TP.wpm; }
    var wv = $('tp-wpm-val'); if (wv) wv.textContent = TP.wpm + ' ppm';
    // measure after layout
    requestAnimationFrame(function () { requestAnimationFrame(function () { tpRecalc(); tpUpdateTC(); tpSetPlay(); }); });
  }
  function tpWords() { var t = 0; BEAT_IDS.forEach(function (id) { t += wordCount(DATA.beats[id].narracao); }); return t; }
  function tpRecalc() {
    var scroll = $('tp-scroll'); var vp = document.querySelector('.tp-viewport'); if (!scroll || !vp) return;
    TP.maxTr = Math.max(1, scroll.scrollHeight - vp.clientHeight);
    TP.dur = Math.max(1, tpWords() / TP.wpm * 60) * 1000;
  }
  function tpUpdateTC() {
    var t = tpEl('tp-time'); var tt = tpEl('tp-total');
    if (t) t.textContent = tc(TP.prog * TP.dur / 1000);
    if (tt) tt.textContent = tc(TP.dur / 1000);
  }
  function tpSetPlay() {
    var b = $('tp-play'); var tcEl = $('tp-tc');
    if (b) b.textContent = TP.playing ? '⏸ Pausar' : '▶ Reproduzir';
    if (tcEl) tcEl.className = 'tp-tc' + (TP.playing ? '' : ' paused');
  }
  function tpFrame(now) {
    if (!TP.playing) return;
    TP.prog = TP.base + (now - TP.startT) / TP.dur;
    if (TP.prog >= 1) { TP.prog = 1; TP.playing = false; tpSetPlay(); }
    var scroll = $('tp-scroll'); if (scroll) scroll.style.transform = 'translateY(' + (-TP.maxTr * TP.prog) + 'px)';
    tpUpdateTC();
    if (TP.playing) TP.raf = requestAnimationFrame(tpFrame);
  }
  function tpPlay() { tpRecalc(); if (TP.prog >= 1) TP.prog = 0; TP.base = TP.prog; TP.startT = performance.now(); TP.playing = true; tpSetPlay(); TP.raf = requestAnimationFrame(tpFrame); }
  function tpPause() { TP.playing = false; TP.base = TP.prog; cancelAnimationFrame(TP.raf); tpSetPlay(); }
  function tpClose() { tpPause(); var ov = $('teleprompter'); if (ov) ov.hidden = true; }

  function wireTeleprompter() {
    var play = $('tp-play'); if (play) play.addEventListener('click', function () { TP.playing ? tpPause() : tpPlay(); });
    var close = $('tp-close'); if (close) close.addEventListener('click', tpClose);
    var restart = $('tp-restart'); if (restart) restart.addEventListener('click', function () {
      tpPause(); TP.prog = 0; TP.base = 0; var s = $('tp-scroll'); if (s) s.style.transform = 'translateY(0)'; tpUpdateTC();
    });
    var mirror = $('tp-mirror'); if (mirror) mirror.addEventListener('click', function () { var s = $('tp-scroll'); if (s) s.classList.toggle('mirror'); });
    var wr = $('tp-wpm'); if (wr) wr.addEventListener('input', function () {
      TP.wpm = parseInt(wr.value, 10) || 150; var wv = $('tp-wpm-val'); if (wv) wv.textContent = TP.wpm + ' ppm';
      TP.base = TP.prog; TP.startT = performance.now(); tpRecalc(); tpUpdateTC();
    });
    document.addEventListener('keydown', function (e) {
      var ov = $('teleprompter'); if (!ov || ov.hidden) return;
      if (e.key === 'Escape') tpClose();
      else if (e.key === ' ') { e.preventDefault(); TP.playing ? tpPause() : tpPlay(); }
    });
    window.addEventListener('resize', function () {
      var ov = $('teleprompter'); if (!ov || ov.hidden) return;
      var p = TP.prog; tpRecalc(); var s = $('tp-scroll'); if (s) s.style.transform = 'translateY(' + (-TP.maxTr * p) + 'px)';
    });
  }

  // ============================================================ chips + init
  function wireChips(groupId) {
    var g = $(groupId); if (!g) return;
    g.addEventListener('click', function (e) {
      var t = e.target.closest('.chip'); if (!t) return;
      Array.prototype.forEach.call(g.querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
      t.classList.add('active'); g.setAttribute('data-value', t.getAttribute('data-v'));
    });
  }

  var _inited = false;
  function init() {
    if (_inited) return; _inited = true;
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select'); // COR-041 studio picker
    wireChips('chips-tom'); wireChips('chips-dur');
    var form = $('brief-form'); if (form) form.addEventListener('submit', function (e) { e.preventDefault(); generate(); });
    wireTeleprompter();
    renderOutput();
  }

  document.addEventListener('maestria:app-ready', init);
  document.addEventListener('DOMContentLoaded', function () {
    // if the app screen is already active (returning member), init now
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) init();
  });
})();
