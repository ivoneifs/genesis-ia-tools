/**
 * Roteiros IA — Main Application Logic
 *
 * Short-form video script generator (Reels / TikTok / YouTube Shorts). The user
 * fills a brief; the AI returns a structured JSON script rendered as a cinematic
 * storyboard. ALL AI calls use the END-USER's own key (Hard Rule #1 BYOK), routed
 * through OpenRouter (model picker) or native OpenAI. There is NO Supabase client
 * in the browser and nothing here persists to a backend.
 */

const App = (function() {
  var BRIEF_STORE = 'roteiros-ia_brief_v1';

  var brief = {
    tema: '',
    plataforma: 'Instagram Reels',
    duracao: '15',
    objetivo: 'Educar / ensinar',
    tom: 'Direto e enérgico',
    publico: '',
    cta: ''
  };

  var lastScript = null;

  // ---------- persistence ----------
  function saveBrief() {
    try { localStorage.setItem(BRIEF_STORE, JSON.stringify(brief)); } catch (e) {}
  }
  function loadBrief() {
    try {
      var raw = localStorage.getItem(BRIEF_STORE);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') brief = Object.assign(brief, parsed);
    } catch (e) {}
  }

  // ---------- escaping ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // LLMs sometimes return the literal string "null"/"undefined" (COR-015).
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na)$/i.test(s)) return '';
    return s;
  }

  // ---------- brief bindings ----------
  function bindBrief() {
    var tema = document.getElementById('f-tema');
    if (tema) { tema.value = brief.tema; tema.addEventListener('input', function() { brief.tema = tema.value; saveBrief(); }); }

    var publico = document.getElementById('f-publico');
    if (publico) { publico.value = brief.publico; publico.addEventListener('input', function() { brief.publico = publico.value; saveBrief(); }); }

    var cta = document.getElementById('f-cta');
    if (cta) { cta.value = brief.cta; cta.addEventListener('input', function() { brief.cta = cta.value; saveBrief(); }); }

    var tom = document.getElementById('f-tom');
    if (tom) { tom.value = brief.tom; tom.addEventListener('change', function() { brief.tom = tom.value; saveBrief(); }); }

    bindSeg('seg-plataforma', 'plataforma');
    bindSeg('seg-duracao', 'duracao');
    bindSeg('seg-objetivo', 'objetivo');
  }

  function bindSeg(containerId, key) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var btns = container.querySelectorAll('button');
    btns.forEach(function(b) {
      b.classList.toggle('active', b.dataset.val === brief[key]);
      b.addEventListener('click', function() {
        brief[key] = b.dataset.val;
        btns.forEach(function(x) { x.classList.toggle('active', x === b); });
        saveBrief();
      });
    });
  }

  // ============================================================
  // AI call (BYOK — user's own key, routed via OpenRouter/OpenAI)
  // ============================================================
  function endpointFor(service) {
    if (service === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
  }
  function modelFor(service) {
    if (service === 'openrouter') return (window.ApiKeyManager ? ApiKeyManager.getModel() : 'anthropic/claude-sonnet-4.6');
    return 'gpt-4o-mini';
  }

  function systemPrompt() {
    return [
      'Você é um roteirista profissional brasileiro especializado em vídeos curtos verticais para redes sociais (Instagram Reels, TikTok e YouTube Shorts).',
      'Você domina ganchos de retenção, ritmo, narração para câmera, texto na tela e chamadas para ação que convertem.',
      'A partir de um briefing, você escreve um roteiro completo, estruturado cena a cena, em português do Brasil, pronto para gravar.',
      '',
      'Regras OBRIGATÓRIAS:',
      '1. O roteiro deve caber na duração informada. Calcule timecodes realistas (uma pessoa fala ~2,5 a 3 palavras por segundo). A soma das durações das cenas deve bater com a duração total.',
      '2. A PRIMEIRA cena é o GANCHO: os 3 primeiros segundos precisam prender. Crie 1 gancho principal forte + 2 alternativas.',
      '3. Para CADA cena dê: timecode de início (formato 0:00), duração em segundos, narração (o que a pessoa fala), texto-na-tela (legenda/caption curta que aparece) e ação visual (o que mostrar/fazer na câmera).',
      '4. NÃO invente dados, números ou estatísticas falsas. Se precisar de um exemplo, deixe claro que é um exemplo genérico.',
      '5. Respeite o tom, o objetivo e o público informados. Se houver CTA, a última cena deve incorporá-lo.',
      '6. Escreva uma legenda sugerida para o post (com quebras de linha curtas) e de 5 a 10 hashtags relevantes (sem o símbolo #, só a palavra).',
      '7. Dê de 2 a 4 dicas práticas de gravação/edição específicas para este roteiro.',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes/depois, sem cercas markdown), neste formato exato:',
      '{',
      '  "titulo": "título curto e chamativo do vídeo",',
      '  "conceito": "1-2 frases explicando a ideia central do vídeo",',
      '  "gancho": { "principal": "o gancho de abertura", "alternativas": ["alt 1", "alt 2"] },',
      '  "cenas": [',
      '    { "n": 1, "timecode": "0:00", "duracao": 3, "narracao": "...", "texto_tela": "...", "visual": "..." }',
      '  ],',
      '  "cta": "a chamada para ação final",',
      '  "legenda": "legenda sugerida para o post",',
      '  "hashtags": ["palavra1", "palavra2"],',
      '  "dicas": ["dica 1", "dica 2"]',
      '}'
    ].join('\n');
  }

  function userPrompt() {
    return [
      'BRIEFING DO VÍDEO:',
      '- Tema/assunto: ' + brief.tema,
      '- Plataforma: ' + brief.plataforma,
      '- Duração alvo: ' + brief.duracao + ' segundos',
      '- Objetivo: ' + brief.objetivo,
      '- Tom: ' + brief.tom,
      '- Público-alvo: ' + (brief.publico || 'geral'),
      '- CTA desejado: ' + (brief.cta || '(escolha um CTA adequado ao objetivo)'),
      '',
      'Gere o roteiro completo em JSON conforme as regras.'
    ].join('\n');
  }

  async function doAICall(activeKey) {
    var body = {
      model: modelFor(activeKey.service),
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt() }
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' }
    };
    var headers = { 'Authorization': 'Bearer ' + activeKey.key, 'Content-Type': 'application/json' };
    if (activeKey.service === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'Roteiros IA - Gênesis IA';
    }
    var resp = await fetch(endpointFor(activeKey.service), { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var errText = ''; try { errText = await resp.text(); } catch (e) {}
      var msg = 'Falha na API (' + resp.status + ').';
      try { var p = JSON.parse(errText); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
      if (resp.status === 401) msg = 'Chave de API inválida ou sem créditos. Verifique sua chave.';
      throw new Error(msg);
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!content) throw new Error('Resposta vazia da API.');
    var cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
      if (!parsed) throw new Error('A IA retornou um formato inválido. Tente novamente.');
    }
    return parsed;
  }

  // ---------- rendering ----------
  function renderScript(s) {
    lastScript = s;
    var stage = document.getElementById('stage');
    if (!stage) return;

    var titulo = clean(s.titulo) || 'Roteiro sem título';
    var conceito = clean(s.conceito);
    var gancho = s.gancho || {};
    var ganchoMain = clean(gancho.principal);
    var alts = Array.isArray(gancho.alternativas) ? gancho.alternativas.filter(function(a) { return clean(a); }) : [];
    var cenas = Array.isArray(s.cenas) ? s.cenas : [];
    var cta = clean(s.cta);
    var legenda = clean(s.legenda);
    var hashtags = Array.isArray(s.hashtags) ? s.hashtags.filter(function(h) { return clean(h); }) : [];
    var dicas = Array.isArray(s.dicas) ? s.dicas.filter(function(d) { return clean(d); }) : [];

    var totalDur = cenas.reduce(function(acc, c) { var n = parseInt(c.duracao, 10); return acc + (isNaN(n) ? 0 : n); }, 0);

    var html = '';

    html += '<div class="script-head">' +
      '<div class="script-slate">🎬 ' + esc(brief.plataforma) + ' · ' + esc(brief.duracao) + 's · ' + esc(brief.objetivo) + '</div>' +
      '<div class="script-title">' + esc(titulo) + '</div>' +
      (conceito ? '<div class="script-concept">' + esc(conceito) + '</div>' : '') +
      '<div class="meta-strip">' +
        '<span class="meta-chip"><b>' + esc(cenas.length) + '</b> cenas</span>' +
        (totalDur ? '<span class="meta-chip"><b>~' + esc(totalDur) + 's</b> total</span>' : '') +
        '<span class="meta-chip"><b>Tom</b> ' + esc(brief.tom) + '</span>' +
        (brief.publico ? '<span class="meta-chip"><b>Para</b> ' + esc(brief.publico) + '</span>' : '') +
      '</div>' +
    '</div>';

    html += '<div class="script-actions">' +
      '<button type="button" class="act-btn" id="copy-full">📋 Copiar roteiro completo</button>' +
      '<button type="button" class="act-btn" id="copy-narration">🎙️ Copiar só a narração</button>' +
      '<button type="button" class="act-btn" id="copy-caption">📝 Copiar legenda + hashtags</button>' +
    '</div>';

    if (ganchoMain || alts.length) {
      html += '<div class="hook-block">' +
        '<div class="block-label">● Gancho — primeiros 3 segundos</div>' +
        (ganchoMain ? '<div class="hook-main">' + esc(ganchoMain) + '</div>' : '') +
        (alts.length ? '<div class="hook-alts">' + alts.map(function(a) { return '<div class="hook-alt">' + esc(a) + '</div>'; }).join('') + '</div>' : '') +
      '</div>';
    }

    if (cenas.length) {
      html += '<div class="board-label">Storyboard</div>';
      html += '<div class="scenes">';
      cenas.forEach(function(c, i) {
        var n = clean(c.n) || (i + 1);
        var tc = clean(c.timecode) || '';
        var dur = clean(c.duracao);
        var narr = clean(c.narracao);
        var tela = clean(c.texto_tela);
        var vis = clean(c.visual);
        html += '<div class="scene-card">' +
          '<div class="scene-strip">' +
            '<div class="scene-num">' + esc(n) + '</div>' +
            (tc ? '<div class="scene-tc">' + esc(tc) + '</div>' : '') +
            (dur ? '<div class="scene-dur">' + esc(dur) + 's</div>' : '') +
          '</div>' +
          '<div class="scene-body">' +
            (narr ? '<div class="scene-row"><span class="scene-tag">🎙️ Narração</span><div class="scene-text">' + esc(narr) + '</div></div>' : '') +
            (tela ? '<div class="scene-row"><span class="scene-tag">📺 Texto na tela</span><div class="scene-text onscreen">' + esc(tela) + '</div></div>' : '') +
            (vis ? '<div class="scene-row"><span class="scene-tag">🎥 Ação visual</span><div class="scene-text visual">' + esc(vis) + '</div></div>' : '') +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }

    html += '<div class="tail-grid">';
    if (cta) {
      html += '<div class="tail-card">' +
        '<div class="block-label gold">▶ Chamada para ação</div>' +
        '<div class="scene-text">' + esc(cta) + '</div>' +
      '</div>';
    }
    if (legenda || hashtags.length) {
      html += '<div class="tail-card">' +
        '<div class="block-label gold">▶ Legenda do post</div>' +
        (legenda ? '<div class="scene-text">' + esc(legenda).replace(/\n/g, '<br>') + '</div>' : '') +
        (hashtags.length ? '<div class="hashtags">' + hashtags.map(function(h) { return '<span class="hashtag">#' + esc(String(h).replace(/^#/, '')) + '</span>'; }).join('') + '</div>' : '') +
      '</div>';
    }
    html += '</div>';

    if (dicas.length) {
      html += '<div class="tail-card" style="margin-top:var(--space-md)">' +
        '<div class="block-label gold">▶ Dicas de gravação</div>' +
        '<ul class="tips">' + dicas.map(function(d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' +
      '</div>';
    }

    stage.innerHTML = html;
    wireCopyButtons();
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scriptToText() {
    if (!lastScript) return '';
    var s = lastScript;
    var lines = [];
    lines.push('ROTEIRO: ' + (clean(s.titulo) || ''));
    if (clean(s.conceito)) lines.push('Conceito: ' + clean(s.conceito));
    lines.push(brief.plataforma + ' · ' + brief.duracao + 's · ' + brief.tom);
    lines.push('');
    if (s.gancho && clean(s.gancho.principal)) {
      lines.push('GANCHO: ' + clean(s.gancho.principal));
      var alts = (s.gancho.alternativas || []).filter(function(a) { return clean(a); });
      alts.forEach(function(a, i) { lines.push('  Alt ' + (i + 1) + ': ' + clean(a)); });
      lines.push('');
    }
    (s.cenas || []).forEach(function(c, i) {
      lines.push('CENA ' + (clean(c.n) || (i + 1)) + (clean(c.timecode) ? ' [' + clean(c.timecode) + (clean(c.duracao) ? ' · ' + clean(c.duracao) + 's' : '') + ']' : ''));
      if (clean(c.narracao)) lines.push('  Narração: ' + clean(c.narracao));
      if (clean(c.texto_tela)) lines.push('  Texto na tela: ' + clean(c.texto_tela));
      if (clean(c.visual)) lines.push('  Visual: ' + clean(c.visual));
      lines.push('');
    });
    if (clean(s.cta)) { lines.push('CTA: ' + clean(s.cta)); lines.push(''); }
    if (clean(s.legenda)) { lines.push('LEGENDA:'); lines.push(clean(s.legenda)); }
    var tags = (s.hashtags || []).filter(function(h) { return clean(h); });
    if (tags.length) lines.push(tags.map(function(h) { return '#' + String(h).replace(/^#/, ''); }).join(' '));
    return lines.join('\n');
  }

  function narrationToText() {
    if (!lastScript) return '';
    return (lastScript.cenas || []).map(function(c) { return clean(c.narracao); }).filter(Boolean).join('\n\n');
  }

  function captionToText() {
    if (!lastScript) return '';
    var parts = [];
    if (clean(lastScript.legenda)) parts.push(clean(lastScript.legenda));
    var tags = (lastScript.hashtags || []).filter(function(h) { return clean(h); });
    if (tags.length) parts.push(tags.map(function(h) { return '#' + String(h).replace(/^#/, ''); }).join(' '));
    return parts.join('\n\n');
  }

  function copyText(text, btn) {
    if (!text) return;
    var done = function() {
      if (!btn) return;
      var orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓ Copiado!';
      setTimeout(function() { btn.classList.remove('copied'); btn.textContent = orig; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function() { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }

  function wireCopyButtons() {
    var full = document.getElementById('copy-full');
    var narr = document.getElementById('copy-narration');
    var cap = document.getElementById('copy-caption');
    if (full) full.addEventListener('click', function() { copyText(scriptToText(), full); });
    if (narr) narr.addEventListener('click', function() { copyText(narrationToText(), narr); });
    if (cap) cap.addEventListener('click', function() { copyText(captionToText(), cap); });
  }

  // ---------- generate ----------
  function setStatus(msg, kind) {
    var el = document.getElementById('gen-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? 'var(--film-red)' : (kind === 'ok' ? 'var(--good-2)' : 'var(--text-muted)');
  }

  function showLoading() {
    var stage = document.getElementById('stage');
    if (stage) stage.innerHTML = '<div class="gen-loading"><div class="clap-anim"></div><p>Escrevendo seu roteiro…</p></div>';
  }

  function setupGenerate() {
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    var btn = document.getElementById('generate-btn');
    if (!btn) return;

    btn.addEventListener('click', async function() {
      if (!brief.tema.trim()) { setStatus('Descreva o tema do vídeo primeiro.', 'err'); return; }

      var active = window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null;
      if (!active) {
        setStatus('Configure sua chave de API (ícone da chave no topo) para gerar.', 'err');
        var mk = document.getElementById('manage-keys-btn');
        if (mk) mk.click();
        return;
      }

      btn.disabled = true;
      setStatus('Gerando com IA…', 'info');
      showLoading();
      try {
        var result = await RateLimiter.executeWithLimit('script-gen', function() { return doAICall(active); });
        if (!result) { setStatus('Limite de uso atingido. Aguarde um instante.', 'err'); restoreEmpty(); btn.disabled = false; return; }
        renderScript(result);
        setStatus('Roteiro pronto! 🎬', 'ok');
      } catch (e) {
        setStatus(e.message || 'Erro ao gerar.', 'err');
        restoreEmpty();
      } finally {
        btn.disabled = false;
      }
    });
  }

  function restoreEmpty() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    if (lastScript) { renderScript(lastScript); return; }
    stage.innerHTML = '<div class="stage-empty" id="stage-empty">' +
      '<div class="clap">🎬 Cena 1 · Take 1</div>' +
      '<p>Preencha o briefing à esquerda e clique em <strong>Gravar roteiro</strong>. Seu storyboard aparece aqui.</p>' +
    '</div>';
  }

  // ---------- init ----------
  function init() {
    var session = MembershipGate.getSession();
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
    bindBrief();
    setupGenerate();
  }

  return { init: init, _load: loadBrief };
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
