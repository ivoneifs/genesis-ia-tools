/**
 * Thumbnail IA — Main Application Logic (REAL thumbnail generation)
 *
 * Flow:
 *   1) A TEXT model (BYOK — OpenRouter/OpenAI) writes N thumbnail CONCEPTS: for each,
 *      a punchy 2–4 word PT-BR headline, an optional highlight word + subtitle + emoji,
 *      an English visual prompt for the background SCENE (no text), and a cohesive
 *      global art-direction string.
 *   2) For EACH variation the app calls the member's chosen IMAGE provider (BYOK):
 *      • fal.ai via the QUEUE API (submit → poll → read) with sync_mode:true → data-URI; or
 *      • OpenAI Images API (gpt-image-1, ids prefixed `openai/`) → b64_json → data-URI.
 *   3) A <canvas> composites the HIGH-CTR headline over the scene (giant condensed
 *      stroke+shadow text, a color-popped word, subtitle, channel handle), exported as a
 *      finished PNG at the EXACT platform dimensions (1280×720 / 1080×1920 / 1440×1440).
 *   4) Each thumbnail renders inside a realistic VIDEO-PLAYER card; every variation can be
 *      regenerated (scene only OR text only), the headline edited inline, downloaded as a
 *      PNG (or raw, textless), and all downloaded together as a .zip (built client-side).
 *
 * ALL AI calls use the END-USER's own keys (Hard Rules #1/#7/#12). No key is ever sent to
 * our backend; there is NO Supabase client in the browser.
 */

const App = (function() {
  var BRIEF_STORE = 'thumbnail-ia_brief_v1';

  var brief = {
    tema: '',
    plataforma: 'YouTube',
    emocao: 'Choque / curiosidade',
    variacoes: '3',
    publico: '',
    canal: '',
    estilo: 'Fotográfico realista',
    cor: '',
    rosto: true,
    overlay: true
  };

  var lastPlan = null;   // last text plan from the LLM
  var thumbs = [];       // per-variation runtime state (see makeThumbState)
  var isBusy = false;
  var fontReady = false;

  // ---------- persistence ----------
  function saveBrief() { try { localStorage.setItem(BRIEF_STORE, JSON.stringify(brief)); } catch (e) {} }
  function loadBrief() {
    try {
      var raw = localStorage.getItem(BRIEF_STORE);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') brief = Object.assign(brief, parsed);
    } catch (e) {}
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // LLMs sometimes return the literal string "null"/"undefined" (COR-015).
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }
  function slugify(s, fallback) {
    var out = (clean(s) || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return out || (fallback || 'thumbnail');
  }

  // ---------- platform → dimensions ----------
  function aspectFor(plataforma) {
    if (plataforma === 'Shorts/Reels') return '9:16';
    if (plataforma === 'Podcast') return '1:1';
    return '16:9'; // YouTube, Capa de curso
  }
  // Export canvas (exact platform size) + fal generation size (mult of 32) + OpenAI size.
  function dimsFor(plataforma) {
    var a = aspectFor(plataforma);
    if (a === '9:16') return { a: a, W: 1080, H: 1920, gw: 864, gh: 1536, enum: 'portrait_16_9', ar: '9:16', oa: '1024x1536' };
    if (a === '1:1')  return { a: a, W: 1440, H: 1440, gw: 1024, gh: 1024, enum: 'square_hd', ar: '1:1', oa: '1024x1024' };
    return { a: '16:9', W: 1280, H: 720, gw: 1536, gh: 864, enum: 'landscape_16_9', ar: '16:9', oa: '1536x1024' };
  }

  // ---------- brief bindings ----------
  function bindBrief() {
    bindInput('f-tema', 'tema');
    bindInput('f-publico', 'publico');
    bindInput('f-canal', 'canal');
    bindInput('f-cor', 'cor');
    var rosto = document.getElementById('f-rosto');
    if (rosto) { rosto.checked = !!brief.rosto; rosto.addEventListener('change', function() { brief.rosto = rosto.checked; saveBrief(); }); }
    var overlay = document.getElementById('f-overlay');
    if (overlay) { overlay.checked = !!brief.overlay; overlay.addEventListener('change', function() { brief.overlay = overlay.checked; saveBrief(); }); }
    bindSeg('seg-plataforma', 'plataforma');
    bindSeg('seg-emocao', 'emocao');
    bindSeg('seg-variacoes', 'variacoes');
    bindSeg('seg-estilo', 'estilo');
  }
  function bindInput(id, key) {
    var el = document.getElementById(id);
    if (!el) return;
    el.value = brief[key];
    el.addEventListener('input', function() { brief[key] = el.value; saveBrief(); });
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
  // TEXT AI call (BYOK — OpenRouter/OpenAI) — resilient
  // Folds in COR-032 (reroll once on bad JSON), COR-034/035 (reasoning budget).
  // ============================================================
  function endpointFor(service) {
    if (service === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
  }
  function modelFor(service) {
    if (service === 'openrouter') return (window.ApiKeyManager ? ApiKeyManager.getModel() : 'anthropic/claude-sonnet-4.6');
    return 'gpt-4o-mini';
  }

  function planSystemPrompt() {
    var n = brief.variacoes;
    return [
      'Você é um diretor de arte brasileiro especialista em THUMBNAILS / CAPAS de vídeo de ALTÍSSIMO CTR (a imagem que decide se um vídeo do YouTube, um Short/Reel, uma capa de curso ou um podcast é clicado).',
      'A partir de um briefing, você cria ' + n + ' CONCEITOS distintos de thumbnail para o MESMO vídeo e descreve a cena de fundo de cada um para um modelo de geração de imagens.',
      '',
      'Regras OBRIGATÓRIAS de thumbnail que converte:',
      '1. titulo_overlay: o TEXTO GRANDE da thumbnail, em português do Brasil, CURTÍSSIMO — de 2 a 4 palavras de forte impacto emocional. NÃO repita o título inteiro do vídeo; destile a ideia mais clicável. Evite ponto final.',
      '2. palavra_destaque: UMA palavra do titulo_overlay que merece cor de destaque (a mais emocional/numérica). Pode ser vazia.',
      '3. subtitulo: opcional, curtíssimo (até ~18 caracteres) — um selo/kicker (ex.: "PASSO A PASSO", "EM 2026", "NINGUÉM CONTA"). Pode ser vazio.',
      '4. emoji: opcional, UM único emoji ou seta (ex.: 🔥, 😱, ➡️) que reforce a emoção — ou vazio.',
      '5. prompt_visual: descrição VISUAL da cena de fundo, ESCRITA EM INGLÊS, para um modelo texto-para-imagem. Descreva sujeito, expressão, composição, luz, cores e clima com forte contraste e apelo emocional. NUNCA inclua texto/letras/números/tipografia/logos/marcas d\'água na imagem — o título será sobreposto depois. Deixe ESPAÇO NEGATIVO no lado onde o texto vai entrar.',
      '6. posicao_texto: onde o título grande deve ficar — "left", "right" ou "bottom" — escolha o lado com espaço negativo na sua cena.',
      '7. Mantenha o MESMO estilo visual (estilo_visual) coeso entre as ' + n + ' variações, mas com ângulos/composições diferentes entre si.',
      '8. NÃO invente números ou promessas falsas; respeite o ângulo emocional, a plataforma, o público e o estilo pedido.',
      brief.rosto ? '9. Quando fizer sentido para o tema, inclua um ROSTO humano com EXPRESSÃO forte (surpresa, choque, alegria) — rostos expressivos aumentam muito o CTR.' : '9. Evite rostos humanos; foque em objetos, cenários ou conceitos visuais.',
      '10. Dê de 3 a 5 dicas práticas de thumbnail (dicas).',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes/depois, sem cercas markdown), neste formato EXATO:',
      '{',
      '  "titulo_video": "título/tema do vídeo (curto)",',
      '  "estilo_visual": "cohesive art direction in English for all scenes",',
      '  "thumbnails": [',
      '    { "titulo_overlay": "TEXTO GRANDE", "palavra_destaque": "PALAVRA", "subtitulo": "selo curto", "emoji": "🔥", "prompt_visual": "background scene in English, no text", "posicao_texto": "left" }',
      '  ],',
      '  "dicas": ["dica 1", "dica 2", "dica 3"]',
      '}'
    ].join('\n');
  }

  function planUserPrompt() {
    return [
      'BRIEFING DA THUMBNAIL:',
      '- Título/tema do vídeo: ' + brief.tema,
      '- Plataforma/formato: ' + brief.plataforma + ' (proporção ' + aspectFor(brief.plataforma) + ')',
      '- Ângulo emocional (CTR): ' + brief.emocao,
      '- Número de variações: ' + brief.variacoes,
      '- Público-alvo: ' + (brief.publico || 'geral'),
      '- Estilo visual da cena: ' + brief.estilo,
      '- Cor de destaque preferida: ' + (brief.cor || '(escolha uma cor de alto contraste adequada)'),
      '',
      'Gere ' + brief.variacoes + ' conceitos de thumbnail em JSON conforme as regras, cada um com seu prompt_visual em inglês e sem texto na imagem.'
    ].join('\n');
  }

  function textSystemPrompt() {
    // for regenerate-text-only of a single thumbnail
    return [
      'Você é especialista em títulos de THUMBNAIL de altíssimo CTR em português do Brasil.',
      'Reescreva APENAS o texto grande de UMA thumbnail para o vídeo informado, com um ângulo diferente do atual.',
      'Regras: titulo_overlay de 2 a 4 palavras de impacto (sem ponto final); palavra_destaque = uma palavra dele para colorir (ou vazio); subtitulo curtíssimo até ~18 caracteres (ou vazio); emoji único opcional (ou vazio); posicao_texto = "left", "right" ou "bottom".',
      'Devolva SOMENTE este JSON: {"titulo_overlay":"...","palavra_destaque":"...","subtitulo":"...","emoji":"...","posicao_texto":"left"}'
    ].join('\n');
  }

  function parseJSON(raw) {
    if (!raw) return null;
    var cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(cleaned); } catch (e) {}
    var m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
    return null;
  }

  async function rawTextCall(activeKey, messages, opts) {
    opts = opts || {};
    var isOR = activeKey.service === 'openrouter';
    var model = modelFor(activeKey.service);
    var isDeepSeek = isOR && model.indexOf('deepseek/') === 0;
    var body = {
      model: model,
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.85,
      max_tokens: opts.maxTokens || 8000,
      response_format: { type: 'json_object' }
    };
    // COR-034: cap reasoning-token spend on OpenRouter reasoning models; COR-035:
    // never send `reasoning` to deepseek/* (routes answer into message.reasoning).
    if (isOR && !isDeepSeek && !opts.noReasoning) body.reasoning = { effort: 'low' };

    var headers = { 'Authorization': 'Bearer ' + activeKey.key, 'Content-Type': 'application/json' };
    if (isOR) {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'Thumbnail IA - Gênesis IA';
    }
    var resp = await fetch(endpointFor(activeKey.service), { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var errText = ''; try { errText = await resp.text(); } catch (e) {}
      var msg = 'Falha na API de texto (' + resp.status + ').';
      try { var p = JSON.parse(errText); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
      if (resp.status === 401) msg = 'Chave de texto inválida ou sem créditos. Verifique sua chave (OpenRouter/OpenAI).';
      throw new Error(msg);
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return content || '';
  }

  async function generatePlan(activeKey) {
    var messages = [
      { role: 'system', content: planSystemPrompt() },
      { role: 'user', content: planUserPrompt() }
    ];
    var content = await rawTextCall(activeKey, messages, {});
    if (!content) content = await rawTextCall(activeKey, messages, { noReasoning: true }); // COR-035 empty-content net
    var parsed = parseJSON(content);
    if (!parsed) {
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior não era um JSON válido. Responda de novo devolvendo APENAS o objeto JSON pedido, sem texto fora dele e com aspas normais.' }]);
      var content2 = await rawTextCall(activeKey, strict, { temperature: 0.4 }); // COR-032 reroll
      parsed = parseJSON(content2);
    }
    if (!parsed) throw new Error('A IA de texto não devolveu um JSON válido. Tente gerar novamente.');
    return parsed;
  }

  async function generateHeadline(activeKey, currentTitle) {
    var messages = [
      { role: 'system', content: textSystemPrompt() },
      { role: 'user', content: 'Vídeo: ' + brief.tema + '\nÂngulo emocional: ' + brief.emocao + '\nTítulo atual (evite repetir): ' + (currentTitle || '(nenhum)') + '\nGere um novo texto de thumbnail.' }
    ];
    var content = await rawTextCall(activeKey, messages, { maxTokens: 1500 });
    if (!content) content = await rawTextCall(activeKey, messages, { maxTokens: 1500, noReasoning: true });
    var parsed = parseJSON(content);
    if (!parsed) {
      var content2 = await rawTextCall(activeKey, messages, { maxTokens: 1500, temperature: 0.4 });
      parsed = parseJSON(content2);
    }
    if (!parsed || !clean(parsed.titulo_overlay)) throw new Error('Não consegui reescrever o texto. Tente novamente.');
    return parsed;
  }

  // ============================================================
  // fal.ai IMAGE generation (BYOK) via QUEUE API — COR-037 pipeline
  // ============================================================
  var FAL_BASE = 'https://queue.fal.run/';

  function buildFalInput(model, dims, prompt) {
    var base = { prompt: prompt, num_images: 1, sync_mode: true, enable_safety_checker: true };
    if (model.indexOf('flux/schnell') !== -1) { base.image_size = { width: dims.gw, height: dims.gh }; base.num_inference_steps = 4; }
    else if (model.indexOf('flux/dev') !== -1) { base.image_size = { width: dims.gw, height: dims.gh }; base.num_inference_steps = 28; }
    else if (model.indexOf('flux') !== -1) { base.image_size = { width: dims.gw, height: dims.gh }; }
    else if (model.indexOf('seedream') !== -1) { base.image_size = { width: dims.gw, height: dims.gh }; }
    else if (model.indexOf('nano-banana') !== -1) { base.aspect_ratio = dims.ar; delete base.enable_safety_checker; }
    else if (model.indexOf('ideogram') !== -1 || model.indexOf('recraft') !== -1) { base.image_size = dims.enum; delete base.enable_safety_checker; }
    else { base.image_size = { width: dims.gw, height: dims.gh }; }
    return base;
  }
  function falHeaders(falKey) { return { 'Authorization': 'Key ' + falKey, 'Content-Type': 'application/json' }; }

  function friendlyFalError(status, txt) {
    var msg = 'Falha ao gerar a cena (' + status + ').';
    try { var p = JSON.parse(txt); if (p.detail) msg = (typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail)); else if (p.error) msg = p.error; } catch (e) {}
    if (status === 401 || status === 403) msg = 'Chave fal.ai inválida ou sem permissão.';
    if (/exhausted balance|top up/i.test(txt || '')) msg = 'Créditos fal.ai esgotados. Adicione créditos em fal.ai/dashboard/billing.';
    if (status === 402) msg = 'Créditos fal.ai insuficientes. Adicione créditos em fal.ai/dashboard.';
    if (status === 422) msg = 'Este modelo recusou os parâmetros. Tente outro modelo de imagem.';
    if (status === 429) msg = 'Muitas imagens em sequência. Aguarde alguns segundos.';
    return msg;
  }

  async function genImageFal(falKey, model, prompt, dims) {
    var input = buildFalInput(model, dims, prompt);
    var subResp = await fetch(FAL_BASE + model, { method: 'POST', headers: falHeaders(falKey), body: JSON.stringify(input) });
    if (!subResp.ok) { var st = ''; try { st = await subResp.text(); } catch (e) {} throw new Error(friendlyFalError(subResp.status, st)); }
    var sub = await subResp.json();
    var statusUrl = sub.status_url, responseUrl = sub.response_url;
    if (!statusUrl || !responseUrl) throw new Error('Resposta inesperada do fal.ai (sem status_url).');
    var started = Date.now(), MAX_MS = 120000;
    while (Date.now() - started < MAX_MS) {
      await sleep(1200);
      var pResp = await fetch(statusUrl, { headers: falHeaders(falKey) });
      if (!pResp.ok) { var pt = ''; try { pt = await pResp.text(); } catch (e) {} throw new Error(friendlyFalError(pResp.status, pt)); }
      var pj = await pResp.json();
      if (pj.status === 'COMPLETED') break;
      if (pj.status === 'FAILED' || pj.status === 'ERROR') throw new Error('O fal.ai não conseguiu gerar esta cena. Tente novamente ou troque o modelo.');
    }
    var rResp = await fetch(responseUrl, { headers: falHeaders(falKey) });
    if (!rResp.ok) { var rt = ''; try { rt = await rResp.text(); } catch (e) {} throw new Error(friendlyFalError(rResp.status, rt)); }
    var res = await rResp.json();
    var url = extractImageUrl(res);
    if (!url) throw new Error('O fal.ai não retornou uma imagem legível.');
    return { url: url };
  }
  function extractImageUrl(res) {
    if (!res) return '';
    if (Array.isArray(res.images) && res.images[0]) { var i0 = res.images[0]; if (typeof i0 === 'string') return i0; if (i0 && i0.url) return i0.url; }
    if (res.image && res.image.url) return res.image.url;
    if (typeof res.image === 'string') return res.image;
    return '';
  }

  // ============================================================
  // OpenAI IMAGE generation (BYOK) — gpt-image-1 family (b64_json). COR-040.
  // ============================================================
  var OPENAI_IMG_ENDPOINT = 'https://api.openai.com/v1/images/generations';
  function friendlyOpenAIImgError(status, txt) {
    var msg = 'Falha ao gerar a cena na OpenAI (' + status + ').';
    try { var p = JSON.parse(txt); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
    if (status === 401) msg = 'Chave OpenAI inválida. Verifique em platform.openai.com/api-keys.';
    if (status === 403) msg = 'Sua conta OpenAI não tem acesso a este modelo (pode exigir verificação da organização). Tente o GPT Image 1 mini.';
    if (status === 402 || status === 429) msg = 'Limite ou créditos insuficientes na sua conta OpenAI. Confira o billing.';
    if (status === 400 && /content_policy|safety|moderation/i.test(txt || '')) msg = 'A OpenAI recusou este prompt por política de conteúdo. Ajuste o tema.';
    return msg;
  }
  async function genImageOpenAI(key, model, prompt, dims) {
    var m = model.replace(/^openai\//, '');
    var body = { model: m, prompt: prompt, n: 1, size: dims.oa, quality: 'medium' };
    var resp = await fetch(OPENAI_IMG_ENDPOINT, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) { var et = ''; try { et = await resp.text(); } catch (e) {} throw new Error(friendlyOpenAIImgError(resp.status, et)); }
    var data = await resp.json();
    var d0 = data && data.data && data.data[0];
    var b64 = d0 && d0.b64_json;
    if (!b64) throw new Error('A OpenAI não retornou uma imagem legível.');
    return { url: 'data:image/png;base64,' + b64 };
  }

  async function genImage(imgKey, model, prompt, dims) {
    if (String(model).indexOf('openai/') === 0) return genImageOpenAI(imgKey, model, prompt, dims);
    return genImageFal(imgKey, model, prompt, dims);
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // ============================================================
  // Canvas compositing — scene + HIGH-CTR headline overlay
  // Data-URI images are same-origin → no canvas taint → toDataURL works.
  // ============================================================
  function ensureFont() {
    if (fontReady) return Promise.resolve();
    var p = [];
    try {
      if (document.fonts && document.fonts.load) {
        p.push(document.fonts.load('400 120px "Anton"'));
        p.push(document.fonts.load('400 48px "Anton"'));
      }
    } catch (e) {}
    return Promise.all(p).then(function() { fontReady = true; }).catch(function() { fontReady = true; });
  }

  function loadImage(src) {
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.onload = function() { resolve(img); };
      img.onerror = function() { reject(new Error('Não foi possível carregar a cena gerada.')); };
      img.src = src;
    });
  }
  function coverDraw(ctx, img, W, H) {
    var ir = img.width / img.height, cr = W / H, dw, dh, dx, dy;
    if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
    else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  var DISPLAY_FONT = '"Anton", "Arial Narrow", "Oswald", sans-serif';
  var BODY_FONT = '"Helvetica Neue", Arial, sans-serif';

  function wrapWords(ctx, text, maxWidth) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [], line = [];
    for (var i = 0; i < words.length; i++) {
      var test = line.concat([words[i]]).join(' ');
      if (ctx.measureText(test).width > maxWidth && line.length) { lines.push(line); line = [words[i]]; }
      else line.push(words[i]);
    }
    if (line.length) lines.push(line);
    return lines;
  }
  // Fit uppercase headline into maxWidth at up to maxLines by shrinking from `start` px.
  function fitHeadline(ctx, text, maxWidth, start, min, maxLines) {
    var size = start;
    while (size > min) {
      ctx.font = '400 ' + size + 'px ' + DISPLAY_FONT;
      var lines = wrapWords(ctx, text, maxWidth);
      if (lines.length <= maxLines) return { size: size, lines: lines };
      size -= 3;
    }
    ctx.font = '400 ' + min + 'px ' + DISPLAY_FONT;
    return { size: min, lines: wrapWords(ctx, text, maxWidth) };
  }

  var COLOR_MAP = {
    'amarelo': '#ffd21f', 'amarela': '#ffd21f', 'vermelho': '#ff2e2e', 'vermelha': '#ff2e2e',
    'verde': '#22c55e', 'azul': '#3b82f6', 'ciano': '#22d3ee', 'laranja': '#ff7a1a',
    'rosa': '#ff5fa2', 'roxo': '#a855f7', 'branco': '#ffffff', 'branca': '#ffffff',
    'preto': '#111111', 'dourado': '#e8b53a', 'ouro': '#e8b53a'
  };
  function resolveAccent(cor) {
    var c = clean(cor).toLowerCase();
    if (!c) return '#ffd21f'; // default high-CTR yellow pop
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
    for (var k in COLOR_MAP) { if (c.indexOf(k) !== -1) return COLOR_MAP[k]; }
    return '#ffd21f';
  }
  function normWord(w) { return String(w).toUpperCase().replace(/[^0-9A-ZÀ-ÿ]/g, ''); }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Compose one thumbnail → PNG data URL.
  async function compositeThumb(st, sceneUri, withOverlay) {
    var dims = dimsFor(brief.plataforma);
    var W = dims.W, H = dims.H;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = await loadImage(sceneUri);
    coverDraw(ctx, img, W, H);
    if (!withOverlay) return canvas.toDataURL('image/png');

    await ensureFont();

    var s = st.slide;
    var titulo = clean(s.titulo_overlay).toUpperCase();
    if (!titulo) return canvas.toDataURL('image/png');
    var sub = clean(s.subtitulo).toUpperCase();
    var emoji = clean(s.emoji);
    var highlight = normWord(s.palavra_destaque);
    var accent = resolveAccent(brief.cor);

    var isLandscape = dims.a === '16:9';
    var placement = clean(s.posicao_texto).toLowerCase();
    if (!isLandscape) placement = 'bottom';
    else if (placement !== 'left' && placement !== 'right' && placement !== 'bottom') placement = 'left';

    var pad = Math.round(W * (isLandscape ? 0.05 : 0.06));
    var blockW = isLandscape && placement !== 'bottom' ? Math.round(W * 0.60) : (W - pad * 2);
    var bx = pad;
    if (placement === 'right') bx = W - pad - blockW;

    // --- scrim for legibility (directional) ---
    var grad;
    if (placement === 'left') { grad = ctx.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, 'rgba(6,7,12,0.86)'); grad.addColorStop(0.55, 'rgba(6,7,12,0.30)'); grad.addColorStop(1, 'rgba(6,7,12,0)'); }
    else if (placement === 'right') { grad = ctx.createLinearGradient(W, 0, 0, 0); grad.addColorStop(0, 'rgba(6,7,12,0.86)'); grad.addColorStop(0.55, 'rgba(6,7,12,0.30)'); grad.addColorStop(1, 'rgba(6,7,12,0)'); }
    else { grad = ctx.createLinearGradient(0, H, 0, H * 0.25); grad.addColorStop(0, 'rgba(6,7,12,0.90)'); grad.addColorStop(0.6, 'rgba(6,7,12,0.35)'); grad.addColorStop(1, 'rgba(6,7,12,0)'); }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // --- headline sizing ---
    var maxLines = isLandscape ? (placement === 'bottom' ? 2 : 4) : 4;
    var startSize = Math.round(W * (isLandscape ? (placement === 'bottom' ? 0.11 : 0.115) : 0.13));
    var minSize = Math.round(W * 0.05);
    var fit = fitHeadline(ctx, titulo, blockW, startSize, minSize, maxLines);
    var size = fit.size;
    var lineH = Math.round(size * 1.02);
    var textH = fit.lines.length * lineH;

    // subtitle chip metrics
    var subH = 0, subSize = Math.round(size * 0.34);
    if (sub) subH = Math.round(subSize * 1.9);

    // total block height incl. subtitle above
    var totalH = textH + subH + Math.round(size * 0.12);

    // vertical anchor
    var topY;
    if (placement === 'bottom') topY = H - pad - textH; // baseline block above bottom padding
    else topY = Math.round((H - totalH) / 2) + subH + size; // center-ish; topY = baseline of first line

    // For non-bottom we drew subtitle above; compute a subtitle baseline
    var baseX = bx;

    // draw subtitle chip (accent pill) above the headline
    if (sub) {
      ctx.font = '800 ' + subSize + 'px ' + BODY_FONT;
      var sw = ctx.measureText(sub).width;
      var chipPadX = Math.round(subSize * 0.55), chipH = Math.round(subSize * 1.5);
      var chipY = topY - textH - (placement === 'bottom' ? 0 : 0) - chipH - Math.round(size * 0.10);
      if (placement === 'bottom') chipY = topY - textH * 0 - (fit.lines.length * lineH) - chipH - Math.round(size * 0.06);
      // simpler: place chip just above the first headline line
      var firstLineTop = (placement === 'bottom') ? (H - pad - textH) : topY - textH;
      chipY = firstLineTop - chipH - Math.round(size * 0.06);
      roundRect(ctx, baseX, chipY, sw + chipPadX * 2, chipH, Math.round(chipH * 0.28));
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.fillStyle = '#0a0a0a';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(sub, baseX + chipPadX, chipY + chipH / 2 + 1);
    }

    // draw headline lines with heavy stroke + shadow, popped highlight word
    ctx.font = '400 ' + size + 'px ' + DISPLAY_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    var strokeW = Math.max(4, Math.round(size * 0.16));

    var firstBaseline = (placement === 'bottom') ? (H - pad - textH + size) : topY;
    for (var li = 0; li < fit.lines.length; li++) {
      var words = fit.lines[li];
      var y = firstBaseline + li * lineH;
      var x = baseX;
      for (var wi = 0; wi < words.length; wi++) {
        var word = words[wi];
        var isHi = highlight && normWord(word) === highlight;
        // shadow
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = Math.round(size * 0.10);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.round(size * 0.05);
        // stroke
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = '#0a0a0a';
        ctx.strokeText(word, x, y);
        // fill
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = isHi ? accent : '#ffffff';
        ctx.fillText(word, x, y);
        x += ctx.measureText(word).width + ctx.measureText(' ').width;
      }
    }
    ctx.shadowColor = 'transparent';

    // emoji (top-right of the block region)
    if (emoji) {
      var eSize = Math.round(size * 1.1);
      ctx.font = eSize + 'px ' + BODY_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      var ex = (placement === 'right') ? bx - Math.round(W * 0.02) : (bx + blockW - eSize);
      if (placement === 'bottom') ex = W - pad - eSize;
      var ey = (placement === 'bottom') ? (H - pad - textH - Math.round(size * 0.2)) : (firstBaseline - textH * 0 - Math.round(size * 0.2));
      if (ey < eSize) ey = eSize + pad;
      try { ctx.fillText(emoji, ex, ey); } catch (e) {}
    }

    // channel handle (bottom-left corner, unobtrusive) unless it collides with bottom text
    var handle = clean(brief.canal);
    if (handle && placement !== 'bottom') {
      if (handle[0] !== '@') handle = '@' + handle;
      ctx.font = '700 ' + Math.round(W * 0.024) + 'px ' + BODY_FONT;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(handle, pad, H - pad);
      ctx.shadowColor = 'transparent';
    }

    return canvas.toDataURL('image/png');
  }

  // ============================================================
  // Generation orchestration
  // ============================================================
  function makeThumbState(slide, index) {
    return { slide: slide, index: index, status: 'pending', rawUri: '', finalUri: '', error: '', dur: durationFor(index) };
  }
  function durationFor(i) {
    var pool = ['10:24', '8:12', '14:57', '6:38', '12:04', '9:45', '18:20', '7:03'];
    return pool[i % pool.length];
  }

  function fullVisualPrompt(st) {
    var s = st.slide;
    var estilo = clean(lastPlan && lastPlan.estilo_visual) || (brief.estilo + ' style');
    var pv = clean(s.prompt_visual) || (clean(s.titulo_overlay) + ' — ' + brief.tema);
    var neg = ' Absolutely no text, no words, no letters, no numbers, no typography, no logos, no watermark, no captions.';
    return estilo + '. ' + pv +
      '. High-CTR video thumbnail background, ' + brief.estilo.toLowerCase() +
      ', bold high-contrast lighting, strong emotional subject, vivid saturated colors, clean negative space on the ' +
      (clean(s.posicao_texto).toLowerCase() || 'left') + ' side for a headline, professional, ultra sharp.' + neg;
  }

  async function generateAll(activeKey, imgKey) {
    setProgress(0, 1, 'Escrevendo os títulos de impacto…');

    var plan;
    try { plan = await RateLimiter.executeWithLimit('thumb-text', function() { return generatePlan(activeKey); }); }
    catch (e) { throw e; }
    if (!plan) throw new Error('Limite de uso atingido. Aguarde um instante e tente novamente.');
    lastPlan = plan;

    var list = Array.isArray(plan.thumbnails) ? plan.thumbnails.filter(function(s) { return s && (clean(s.titulo_overlay) || clean(s.prompt_visual)); }) : [];
    if (!list.length) throw new Error('A IA não retornou conceitos de thumbnail. Tente novamente.');
    thumbs = list.map(makeThumbState);

    renderStage();

    var withOverlay = !!brief.overlay;
    var dims = dimsFor(brief.plataforma);
    var done = 0;
    for (var i = 0; i < thumbs.length; i++) {
      var st = thumbs[i];
      st.status = 'gen';
      updateThumbCard(i);
      setProgress(done, thumbs.length, 'Gerando cena ' + (i + 1) + ' de ' + thumbs.length + '…');
      try {
        var prompt = fullVisualPrompt(st);
        var out = await RateLimiter.executeWithLimit('thumb-image', (function(p) {
          return function() { return genImage(imgKey, ApiKeyManager.getImageModel(), p, dims); };
        })(prompt));
        if (!out) { st.status = 'error'; st.error = 'Limite de uso atingido. Tente novamente esta variação.'; updateThumbCard(i); continue; }
        st.rawUri = out.url;
        st.status = 'compositing';
        updateThumbCard(i);
        st.finalUri = await compositeThumb(st, out.url, withOverlay);
        st.status = 'done';
        done++;
        updateThumbCard(i);
        setProgress(done, thumbs.length, done < thumbs.length ? ('Gerando cena ' + (done + 1) + ' de ' + thumbs.length + '…') : 'Finalizando…');
      } catch (e) {
        st.status = 'error';
        st.error = (e && e.message) ? e.message : 'Erro ao gerar esta cena.';
        updateThumbCard(i);
      }
    }

    updateDeckActions();
    var ok = thumbs.filter(function(s) { return s.status === 'done'; }).length;
    if (ok === 0) {
      setProgress(0, thumbs.length, '');
      var prov = ApiKeyManager.imageProviderFor(ApiKeyManager.getImageModel());
      throw new Error('Nenhuma thumbnail foi gerada. Confira sua chave ' + (prov === 'openai' ? 'OpenAI' : 'fal.ai') + ' e os créditos.');
    }
    setProgress(thumbs.length, thumbs.length, '');
    setStatus(ok + ' de ' + thumbs.length + ' thumbnails prontas!' + (ok < thumbs.length ? ' Você pode tentar novamente as que deram erro.' : ''), 'ok');
  }

  // Regenerate ONLY the scene of one thumbnail (keep the headline)
  async function regenScene(i) {
    if (isBusy) return;
    var st = thumbs[i]; if (!st) return;
    var ik = ApiKeyManager.getImageKey();
    if (!ik.key) { setStatus(imgKeyMsg(ik.provider), 'err'); return; }
    var dims = dimsFor(brief.plataforma);
    st.status = 'gen'; st.error = ''; updateThumbCard(i);
    try {
      var out = await RateLimiter.executeWithLimit('thumb-image', function() { return genImage(ik.key, ApiKeyManager.getImageModel(), fullVisualPrompt(st), dims); });
      if (!out) { st.status = 'error'; st.error = 'Limite de uso atingido.'; updateThumbCard(i); return; }
      st.rawUri = out.url;
      st.status = 'compositing'; updateThumbCard(i);
      st.finalUri = await compositeThumb(st, out.url, !!brief.overlay);
      st.status = 'done'; updateThumbCard(i);
      updateDeckActions();
    } catch (e) { st.status = 'error'; st.error = (e && e.message) ? e.message : 'Erro ao gerar.'; updateThumbCard(i); }
  }

  // Regenerate ONLY the headline text of one thumbnail (keep the scene), then recomposite
  async function regenText(i) {
    if (isBusy) return;
    var st = thumbs[i]; if (!st) return;
    if (!st.rawUri) { regenScene(i); return; }
    var active = ApiKeyManager.getActiveKey();
    if (!active) { setStatus('Configure sua chave de texto (OpenRouter/OpenAI).', 'err'); return; }
    var prevStatus = st.status;
    st.status = 'compositing'; updateThumbCard(i);
    try {
      var h = await RateLimiter.executeWithLimit('thumb-text', function() { return generateHeadline(active, clean(st.slide.titulo_overlay)); });
      if (!h) { st.status = prevStatus; setStatus('Limite de uso atingido.', 'err'); updateThumbCard(i); return; }
      st.slide.titulo_overlay = clean(h.titulo_overlay) || st.slide.titulo_overlay;
      st.slide.palavra_destaque = clean(h.palavra_destaque);
      st.slide.subtitulo = clean(h.subtitulo);
      st.slide.emoji = clean(h.emoji);
      if (clean(h.posicao_texto)) st.slide.posicao_texto = clean(h.posicao_texto);
      st.finalUri = await compositeThumb(st, st.rawUri, !!brief.overlay);
      st.status = 'done'; updateThumbCard(i);
    } catch (e) { st.status = prevStatus; setStatus((e && e.message) ? e.message : 'Erro ao reescrever.', 'err'); updateThumbCard(i); }
  }

  // Apply an inline manual edit of the headline, recomposite
  async function applyEdit(i) {
    var st = thumbs[i]; if (!st) return;
    var card = document.getElementById('thumb-card-' + i);
    if (!card) return;
    var t = card.querySelector('.te-titulo');
    var sub = card.querySelector('.te-sub');
    var hi = card.querySelector('.te-hi');
    if (t) st.slide.titulo_overlay = t.value;
    if (sub) st.slide.subtitulo = sub.value;
    if (hi) st.slide.palavra_destaque = hi.value;
    if (!st.rawUri) { updateThumbCard(i); return; }
    st.status = 'compositing'; updateThumbCard(i);
    try {
      st.finalUri = await compositeThumb(st, st.rawUri, !!brief.overlay);
      st.status = 'done'; updateThumbCard(i);
    } catch (e) { st.status = 'done'; updateThumbCard(i); }
  }

  function imgKeyMsg(provider) {
    return provider === 'openai'
      ? 'O modelo de imagem escolhido usa a sua chave OpenAI. Adicione-a no ícone da chave.'
      : 'Adicione sua chave fal.ai (ícone da chave) para gerar as cenas.';
  }

  // ============================================================
  // Rendering — player-card grid + tail
  // ============================================================
  function renderStage() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    var p = lastPlan || {};
    var titulo = clean(p.titulo_video) || clean(brief.tema) || 'Suas thumbnails';
    var portrait = aspectFor(brief.plataforma) === '9:16';

    var html = '';
    html += '<div class="deck-head">' +
      '<div class="deck-slate">' + esc(brief.plataforma) + ' · ' + esc(aspectFor(brief.plataforma)) + ' · ' + esc(brief.emocao) + ' · ' + thumbs.length + ' variações</div>' +
      '<div class="deck-title">' + esc(titulo) + '</div>' +
    '</div>';
    html += '<div class="deck-actions" id="deck-actions"></div>';
    html += '<div class="thumb-grid' + (portrait ? ' portrait' : '') + '" id="thumb-grid">';
    thumbs.forEach(function(st, i) {
      html += '<article class="thumb-card" id="thumb-card-' + i + '" data-idx="' + i + '">' + thumbCardInner(st) + '</article>';
    });
    html += '</div>';
    html += renderTail();

    stage.innerHTML = html;
    wireAllCards();
    updateDeckActions();
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function screenAspectClass() {
    var a = aspectFor(brief.plataforma);
    return a === '9:16' ? 'a916' : (a === '1:1' ? 'a11' : 'a169');
  }

  function thumbCardInner(st) {
    var i = st.index;
    var aCls = screenAspectClass();
    var p = lastPlan || {};
    var vidTitle = clean(p.titulo_video) || clean(brief.tema) || 'Meu vídeo';
    var chan = clean(brief.canal) || 'Seu Canal';
    var chanInit = (chan.replace(/^@/, '')[0] || 'S').toUpperCase();

    var screen;
    if (st.status === 'done' && st.finalUri) {
      screen = '<img class="thumb-img" src="' + st.finalUri + '" alt="Thumbnail ' + (i + 1) + '" loading="lazy">' +
        '<div class="play-center" aria-hidden="true"><svg viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5z"/></svg></div>' +
        '<span class="dur-badge">' + esc(st.dur) + '</span>' +
        '<div class="player-scrub"><span class="scrub-fill"></span><span class="scrub-head"></span></div>';
    } else if (st.status === 'error') {
      screen = '<div class="player-ph err"><div class="ph-ico">⚠</div><div class="ph-msg">' + esc(st.error || 'Erro ao gerar.') + '</div><button type="button" class="retry-mini" data-act="scene" data-idx="' + i + '">Tentar de novo</button></div>';
    } else {
      var label = st.status === 'compositing' ? 'Aplicando o título…' : (st.status === 'gen' ? 'Gerando cena…' : 'Na fila…');
      screen = '<div class="player-ph"><div class="ph-spinner"></div><div class="ph-msg">' + esc(label) + '</div></div>';
    }

    var meta = '<div class="player-meta">' +
      '<div class="chan-dot">' + esc(chanInit) + '</div>' +
      '<div class="meta-text">' +
        '<div class="vid-title">' + esc(vidTitle) + '</div>' +
        '<div class="vid-sub">' + esc(chan.replace(/^@/, '')) + ' · 1,2 mil visualizações · há 2 horas</div>' +
      '</div>' +
    '</div>';

    var tools = '';
    if (st.status === 'done' || st.status === 'compositing') {
      var busy = st.status === 'compositing';
      tools = '<div class="thumb-tools">' +
        '<button type="button" class="tt-btn dl" data-act="dl" data-idx="' + i + '"' + (busy ? ' disabled' : '') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>PNG</button>' +
        '<button type="button" class="tt-btn" data-act="scene" data-idx="' + i + '"' + (busy ? ' disabled' : '') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>Cena</button>' +
        (brief.overlay ? '<button type="button" class="tt-btn" data-act="text" data-idx="' + i + '"' + (busy ? ' disabled' : '') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>Texto</button>' : '') +
        (brief.overlay ? '<button type="button" class="tt-btn" data-act="edit" data-idx="' + i + '"' + (busy ? ' disabled' : '') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Editar</button>' : '') +
        (brief.overlay && st.rawUri ? '<button type="button" class="tt-btn" data-act="raw" data-idx="' + i + '"' + (busy ? ' disabled' : '') + '>Sem texto</button>' : '') +
      '</div>';
      if (brief.overlay) {
        tools += '<div class="txt-edit" id="te-' + i + '">' +
          '<label>Título grande</label><input type="text" class="te-titulo" value="' + esc(clean(st.slide.titulo_overlay)) + '" maxlength="60">' +
          '<div class="te-row"><input type="text" class="te-hi" placeholder="palavra em destaque" value="' + esc(clean(st.slide.palavra_destaque)) + '" maxlength="24"><input type="text" class="te-sub" placeholder="selo (opcional)" value="' + esc(clean(st.slide.subtitulo)) + '" maxlength="22"></div>' +
          '<div class="te-row"><button type="button" class="tt-btn" data-act="apply" data-idx="' + i + '">Aplicar</button></div>' +
          '<div class="te-hint">Dica: 2 a 4 palavras. A palavra em destaque ganha a cor escolhida.</div>' +
        '</div>';
      }
    }

    return '<div class="player"><div class="player-screen ' + aCls + '">' + screen + '</div></div>' + meta + tools;
  }

  function updateThumbCard(i) {
    var card = document.getElementById('thumb-card-' + i);
    if (!card) return;
    card.innerHTML = thumbCardInner(thumbs[i]);
    wireCard(card);
  }

  function wireAllCards() {
    document.querySelectorAll('.thumb-card').forEach(wireCard);
  }
  function wireCard(card) {
    card.querySelectorAll('[data-act]').forEach(function(btn) {
      btn.onclick = function() {
        var i = parseInt(btn.dataset.idx, 10);
        var act = btn.dataset.act;
        if (act === 'dl') downloadOne(i, false);
        else if (act === 'raw') downloadOne(i, true);
        else if (act === 'scene') regenScene(i);
        else if (act === 'text') regenText(i);
        else if (act === 'apply') applyEdit(i);
        else if (act === 'edit') { var te = document.getElementById('te-' + i); if (te) te.classList.toggle('open'); }
      };
    });
  }

  function updateDeckActions() {
    var el = document.getElementById('deck-actions');
    if (!el) return;
    var okCount = thumbs.filter(function(s) { return s.status === 'done'; }).length;
    var html = '';
    html += '<button type="button" class="act-btn primary" id="dl-zip"' + (okCount ? '' : ' disabled') + '>⬇ Baixar todas (.zip)</button>';
    html += '<button type="button" class="act-btn" id="copy-titles">Copiar títulos</button>';
    html += '<button type="button" class="act-btn" id="download-txt">Baixar roteiro .txt</button>';
    el.innerHTML = html;
    var zip = document.getElementById('dl-zip'); if (zip) zip.onclick = downloadAllZip;
    var ct = document.getElementById('copy-titles'); if (ct) ct.onclick = function() { copyText(titlesToText(), ct); };
    var txt = document.getElementById('download-txt'); if (txt) txt.onclick = downloadTxt;
  }

  function renderTail() {
    var d = lastPlan || {};
    var dicas = Array.isArray(d.dicas) ? d.dicas.filter(function(x) { return clean(x); }) : [];
    if (!dicas.length) return '';
    return '<div class="tail"><div class="tail-card"><div class="block-label">Dicas de thumbnail</div><ul class="tips">' +
      dicas.map(function(x) { return '<li>' + esc(clean(x)) + '</li>'; }).join('') + '</ul></div></div>';
  }

  // ============================================================
  // Downloads
  // ============================================================
  function dataURItoBytes(dataURI) {
    var comma = dataURI.indexOf(',');
    var bin = atob(dataURI.slice(comma + 1));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function triggerDownload(blobOrUrl, filename) {
    var url = (typeof blobOrUrl === 'string') ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if (typeof blobOrUrl !== 'string') setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
  }
  function baseSlug() { return slugify(lastPlan && lastPlan.titulo_video, 'thumbnail'); }

  function downloadOne(i, raw) {
    var st = thumbs[i]; if (!st) return;
    var uri = raw ? st.rawUri : (st.finalUri || st.rawUri);
    if (!uri) return;
    var ext = uri.indexOf('data:image/png') === 0 ? 'png' : 'jpg';
    triggerDownload(uri, baseSlug() + '-thumb-' + String(i + 1).padStart(2, '0') + (raw ? '-sem-texto' : '') + '.' + ext);
  }

  // ---- minimal ZIP (STORE method, no library) — COR-037 ----
  var CRC_TABLE = (function() {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function strBytes(s) { var out = []; for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF); return out; }
  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
  function buildZip(files) {
    var chunks = [], central = [], offset = 0;
    files.forEach(function(f) {
      var nameBytes = strBytes(f.name), crc = crc32(f.bytes), size = f.bytes.length;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes);
      var localArr = new Uint8Array(local.length + size);
      localArr.set(local, 0); localArr.set(f.bytes, local.length);
      chunks.push(localArr);
      var cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes);
      central.push(new Uint8Array(cen));
      offset += localArr.length;
    });
    var centralSize = central.reduce(function(a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)));
    return new Blob(chunks.concat(central).concat([eocd]), { type: 'application/zip' });
  }
  function downloadAllZip() {
    var done = thumbs.filter(function(s) { return s.status === 'done' && (s.finalUri || s.rawUri); });
    if (!done.length) return;
    var files = done.map(function(st) {
      var uri = st.finalUri || st.rawUri;
      var ext = uri.indexOf('data:image/png') === 0 ? 'png' : 'jpg';
      return { name: baseSlug() + '-thumb-' + String(st.index + 1).padStart(2, '0') + '.' + ext, bytes: dataURItoBytes(uri) };
    });
    try { triggerDownload(buildZip(files), baseSlug() + '-thumbnails.zip'); }
    catch (e) { setStatus('Não foi possível montar o .zip. Baixe as imagens uma a uma.', 'err'); }
  }

  // ---------- text exports ----------
  function titlesToText() {
    if (!thumbs.length) return '';
    var lines = [];
    lines.push('TÍTULOS DE THUMBNAIL — ' + (clean(lastPlan && lastPlan.titulo_video) || clean(brief.tema)));
    lines.push('');
    thumbs.forEach(function(st, i) {
      var s = st.slide;
      var t = clean(s.titulo_overlay);
      if (!t) return;
      lines.push((i + 1) + '. ' + t + (clean(s.subtitulo) ? ' [' + clean(s.subtitulo) + ']' : '') + (clean(s.emoji) ? ' ' + clean(s.emoji) : ''));
    });
    return lines.join('\n');
  }
  function planToText() {
    if (!lastPlan) return '';
    var lines = [];
    lines.push('THUMBNAILS: ' + (clean(lastPlan.titulo_video) || ''));
    lines.push(brief.plataforma + ' · ' + aspectFor(brief.plataforma) + ' · ' + brief.emocao);
    lines.push('');
    thumbs.forEach(function(st, i) {
      var s = st.slide;
      lines.push('VARIAÇÃO ' + (i + 1));
      if (clean(s.titulo_overlay)) lines.push('Título: ' + clean(s.titulo_overlay));
      if (clean(s.subtitulo)) lines.push('Selo: ' + clean(s.subtitulo));
      if (clean(s.palavra_destaque)) lines.push('Destaque: ' + clean(s.palavra_destaque));
      if (clean(s.prompt_visual)) lines.push('[Cena: ' + clean(s.prompt_visual) + ']');
      lines.push('');
    });
    var dicas = (lastPlan.dicas || []).filter(function(x) { return clean(x); });
    if (dicas.length) { lines.push('DICAS:'); dicas.forEach(function(x) { lines.push('- ' + clean(x)); }); }
    return lines.join('\n');
  }
  function downloadTxt() {
    var text = planToText();
    if (!text) return;
    triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), baseSlug() + '.txt');
  }

  function copyText(text, btn) {
    if (!text) return;
    var done = function() {
      if (!btn) return;
      var orig = btn.textContent;
      btn.classList.add('copied'); btn.textContent = '✓ Copiado!';
      setTimeout(function() { btn.classList.remove('copied'); btn.textContent = orig; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function() { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    try { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e) {}
  }

  // ============================================================
  // Status / progress
  // ============================================================
  function setStatus(msg, kind) {
    var el = document.getElementById('gen-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? 'var(--bad)' : (kind === 'ok' ? 'var(--good)' : 'var(--text-muted)');
  }
  function setProgress(done, total, label) {
    var wrap = document.getElementById('gen-progress');
    var fill = document.getElementById('gp-fill');
    var lab = document.getElementById('gp-label');
    if (!wrap) return;
    if (!label && (!total || done >= total)) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    var pct = total ? Math.round((done / total) * 100) : 0;
    if (fill) fill.style.width = pct + '%';
    if (lab) lab.textContent = label || '';
  }

  function refreshImgWarn() {
    var warn = document.getElementById('img-warn');
    if (!warn || !window.ApiKeyManager) return;
    var ik = ApiKeyManager.getImageKey();
    if (ik.key) { warn.style.display = 'none'; return; }
    warn.innerHTML = ik.provider === 'openai'
      ? 'O modelo de imagem escolhido usa a sua chave <strong>OpenAI</strong>. Adicione-a no ícone da chave (topo) para gerar as cenas.'
      : 'Adicione sua chave <strong>fal.ai</strong> (ícone da chave no topo) para gerar as cenas reais — ou escolha um modelo de imagem da OpenAI, se você já tem uma chave OpenAI.';
    warn.style.display = 'block';
  }

  // ============================================================
  // Setup
  // ============================================================
  function setupGenerate() {
    if (window.ApiKeyManager) {
      if (ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
      if (ApiKeyManager.renderImageModelPicker) ApiKeyManager.renderImageModelPicker('image-model-select', ['image', 'openaiImage']);
    }
    refreshImgWarn();
    document.addEventListener('thumbnail:keys-updated', refreshImgWarn);
    var imgSelect = document.getElementById('image-model-select');
    if (imgSelect) imgSelect.addEventListener('change', refreshImgWarn);

    var btn = document.getElementById('generate-btn');
    if (!btn) return;
    btn.addEventListener('click', async function() {
      if (isBusy) return;
      if (!brief.tema.trim()) { setStatus('Descreva o título/tema do vídeo primeiro.', 'err'); return; }
      var active = window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null;
      if (!active) {
        setStatus('Configure sua chave de texto (OpenRouter/OpenAI) no ícone da chave.', 'err');
        var mk = document.getElementById('manage-keys-btn'); if (mk) mk.click();
        return;
      }
      var ik = ApiKeyManager.getImageKey();
      if (!ik.key) {
        setStatus(imgKeyMsg(ik.provider), 'err');
        refreshImgWarn();
        var mk2 = document.getElementById('manage-keys-btn'); if (mk2) mk2.click();
        return;
      }
      isBusy = true; btn.disabled = true;
      var origLabel = btn.innerHTML;
      btn.textContent = 'Gerando…';
      setStatus('', 'info');
      try { await generateAll(active, ik.key); }
      catch (e) { setStatus((e && e.message) ? e.message : 'Erro ao gerar.', 'err'); setProgress(0, 0, ''); if (!thumbs.length) restoreEmpty(); }
      finally { isBusy = false; btn.disabled = false; btn.innerHTML = origLabel; }
    });
  }

  function restoreEmpty() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    stage.innerHTML = '<div class="stage-empty" id="stage-empty">' +
      '<div class="empty-player" aria-hidden="true"><div class="ep-play"><svg viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5z"/></svg></div></div>' +
      '<p>Preencha o briefing e clique em <strong>Gerar thumbnails</strong>. A IA escreve o título de impacto e o prompt visual; o modelo de imagem (fal.ai ou OpenAI, com a sua chave) renderiza a <strong>cena real</strong>; então o título de alto-CTR é composto por cima.</p>' +
    '</div>';
  }

  function init() {
    var session = MembershipGate.getSession();
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
    bindBrief();
    setupGenerate();
    ensureFont(); // warm the canvas font early
  }

  return { init: init, _load: loadBrief };
})();

App._load();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = MembershipGate.getSession();
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
