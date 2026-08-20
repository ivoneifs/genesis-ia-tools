/**
 * Carrossel IA — Main Application Logic (REAL IMAGE generation)
 *
 * Flow:
 *   1) A TEXT model (BYOK — OpenRouter/OpenAI) writes the carousel copy AND a
 *      per-slide English visual prompt + a cohesive global art-direction string.
 *   2) For EACH slide the app calls the member's chosen IMAGE provider (BYOK):
 *      • fal.ai via the QUEUE API (submit → poll status → read result), with
 *        sync_mode:true so the image comes back as a data-URI; or
 *      • OpenAI Images API (gpt-image-1 / DALL·E — model ids prefixed `openai/`),
 *        which returns b64_json → converted to the same data-URI.
 *      Either way the result is a data-URI, so it renders + downloads + composites
 *      with no CDN round-trip and no canvas taint, entirely within the existing CSP
 *      (connect-src already allows queue.fal.run AND api.openai.com).
 *   3) Optionally the app composites the slide's text over the generated image on
 *      a <canvas>, producing a finished, posting-ready PNG.
 *   4) Real images preview in a swipeable deck; each downloads individually and the
 *      whole set downloads as a .zip (built client-side, no library).
 *
 * ALL AI calls use the END-USER's own keys (Hard Rules #1/#7/#12). No key is ever
 * sent to our backend; there is NO Supabase client in the browser.
 */

const App = (function() {
  var BRIEF_STORE = 'carrossel-ia_brief_v2';

  var brief = {
    tema: '',
    plataforma: 'Instagram',
    objetivo: 'Educar',
    slides: '7',
    tom: 'Profissional e claro',
    publico: '',
    cta: '',
    handle: '',
    aspect: '1:1',
    estilo: 'Fotográfico realista',
    overlay: true
  };

  var lastDeck = null;      // last text plan from the LLM
  var slidesState = [];     // per-slide runtime state (see makeSlideState)
  var deckIndex = 0;
  var isBusy = false;

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
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return out || (fallback || 'carrossel');
  }

  // ---------- brief bindings ----------
  function bindBrief() {
    var tema = document.getElementById('f-tema');
    if (tema) { tema.value = brief.tema; tema.addEventListener('input', function() { brief.tema = tema.value; saveBrief(); }); }
    var publico = document.getElementById('f-publico');
    if (publico) { publico.value = brief.publico; publico.addEventListener('input', function() { brief.publico = publico.value; saveBrief(); }); }
    var cta = document.getElementById('f-cta');
    if (cta) { cta.value = brief.cta; cta.addEventListener('input', function() { brief.cta = cta.value; saveBrief(); }); }
    var handle = document.getElementById('f-handle');
    if (handle) { handle.value = brief.handle; handle.addEventListener('input', function() { brief.handle = handle.value; saveBrief(); }); }
    var tom = document.getElementById('f-tom');
    if (tom) { tom.value = brief.tom; tom.addEventListener('change', function() { brief.tom = tom.value; saveBrief(); }); }
    var overlay = document.getElementById('f-overlay');
    if (overlay) { overlay.checked = !!brief.overlay; overlay.addEventListener('change', function() { brief.overlay = overlay.checked; saveBrief(); }); }

    bindSeg('seg-plataforma', 'plataforma');
    bindSeg('seg-objetivo', 'objetivo');
    bindSeg('seg-slides', 'slides');
    bindSeg('seg-aspect', 'aspect');
    bindSeg('seg-estilo', 'estilo');
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

  function systemPrompt() {
    return [
      'Você é um diretor de conteúdo brasileiro especialista em CARROSSÉIS (posts de múltiplos slides) para Instagram, LinkedIn e TikTok, e também em direção de arte para as IMAGENS de cada slide.',
      'A partir de um briefing, você cria um carrossel completo em português do Brasil E descreve a imagem de cada slide para um modelo de geração de imagens.',
      '',
      'Regras OBRIGATÓRIAS:',
      '1. Gere EXATAMENTE o número de slides pedido (a capa e o slide final de CTA contam nesse total).',
      '2. Slide 1 = CAPA: gancho forte e curtíssimo que faz parar de rolar.',
      '3. Último slide = fechamento/CTA: incorpore a chamada para ação informada (ou uma adequada ao objetivo).',
      '4. Para CADA slide forneça: numero (1..N), tipo (ex: "Capa", "Conteúdo", "Passo", "CTA"), titulo (curto, é o destaque), texto (corpo conciso e escaneável, MÁXIMO ~200 caracteres) e prompt_visual.',
      '5. prompt_visual: uma descrição VISUAL da imagem de fundo do slide, ESCRITA EM INGLÊS, para um modelo de texto-para-imagem. Descreva cena, composição, luz, cores e clima. NUNCA inclua texto/letras/números/tipografia/logos/marcas d\'água na imagem — o texto será sobreposto depois. Mantenha o MESMO estilo visual em todos os slides para o carrossel ficar coeso. Deixe espaço negativo (áreas mais limpas) para o texto respirar.',
      '6. NÃO invente dados, números ou estatísticas falsas.',
      '7. Respeite tom, objetivo, plataforma, público e o ESTILO VISUAL pedido.',
      '8. Escreva uma legenda para o post (linhas curtas) e de 5 a 12 hashtags (só a palavra, sem #). Dê de 2 a 4 dicas práticas de publicação.',
      '9. estilo_visual (nível do carrossel): uma frase EM INGLÊS descrevendo a direção de arte comum a todos os slides (paleta, técnica, clima), coerente com o estilo pedido — ela é somada a cada prompt_visual para dar coesão.',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes/depois, sem cercas markdown), neste formato exato:',
      '{',
      '  "titulo": "título curto do carrossel",',
      '  "conceito": "1-2 frases com o ângulo central",',
      '  "estilo_visual": "cohesive art direction in English for all slides",',
      '  "slides": [',
      '    { "numero": 1, "tipo": "Capa", "titulo": "...", "texto": "...", "prompt_visual": "background scene in English, no text" }',
      '  ],',
      '  "legenda": "legenda sugerida",',
      '  "hashtags": ["palavra1", "palavra2"],',
      '  "dicas": ["dica 1", "dica 2"]',
      '}'
    ].join('\n');
  }

  function userPrompt() {
    return [
      'BRIEFING DO CARROSSEL:',
      '- Tema/assunto: ' + brief.tema,
      '- Plataforma: ' + brief.plataforma,
      '- Objetivo: ' + brief.objetivo,
      '- Número de slides: ' + brief.slides,
      '- Tom: ' + brief.tom,
      '- Público-alvo: ' + (brief.publico || 'geral'),
      '- CTA desejado: ' + (brief.cta || '(escolha um CTA adequado ao objetivo)'),
      '- Estilo visual das imagens: ' + brief.estilo,
      '',
      'Gere o carrossel completo em JSON conforme as regras. Gere exatamente ' + brief.slides + ' slides, cada um com seu prompt_visual em inglês e sem texto na imagem.'
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
      temperature: opts.temperature != null ? opts.temperature : 0.8,
      max_tokens: opts.maxTokens || 16000,
      response_format: { type: 'json_object' }
    };
    // COR-034: cap reasoning-token spend on OpenRouter reasoning models; COR-035:
    // never send `reasoning` to deepseek/* (routes answer into message.reasoning).
    if (isOR && !isDeepSeek && !opts.noReasoning) body.reasoning = { effort: 'low' };

    var headers = { 'Authorization': 'Bearer ' + activeKey.key, 'Content-Type': 'application/json' };
    if (isOR) {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'Carrossel IA - Gênesis IA';
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
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt() }
    ];
    var content = await rawTextCall(activeKey, messages, {});
    if (!content) {
      // COR-035 empty-content net: retry once without reasoning.
      content = await rawTextCall(activeKey, messages, { noReasoning: true });
    }
    var parsed = parseJSON(content);
    if (!parsed) {
      // COR-032: reroll once, stricter, lower temperature.
      var strict = messages.concat([{
        role: 'user',
        content: 'Sua resposta anterior não era um JSON válido. Responda de novo devolvendo APENAS o objeto JSON pedido, sem texto fora dele e com aspas normais.'
      }]);
      var content2 = await rawTextCall(activeKey, strict, { temperature: 0.4 });
      parsed = parseJSON(content2);
    }
    if (!parsed) throw new Error('A IA de texto não devolveu um JSON válido. Tente gerar novamente.');
    return parsed;
  }

  // ============================================================
  // fal.ai IMAGE generation (BYOK — user's own fal key) via QUEUE API
  // ============================================================
  var FAL_BASE = 'https://queue.fal.run/';

  function aspectDims(aspect) {
    // Export canvas (Instagram-native) + fal generation size (multiples of 32).
    if (aspect === '4:5') return { W: 1080, H: 1350, gw: 1024, gh: 1280, enum: 'portrait_4_3', ar: '4:5' };
    return { W: 1080, H: 1080, gw: 1024, gh: 1024, enum: 'square_hd', ar: '1:1' };
  }

  // Build a model-family-aware fal input payload. sync_mode:true → data-URI result.
  function buildFalInput(model, aspect, prompt) {
    var d = aspectDims(aspect);
    var base = { prompt: prompt, num_images: 1, sync_mode: true, enable_safety_checker: true };
    if (model.indexOf('flux/schnell') !== -1) {
      base.image_size = { width: d.gw, height: d.gh };
      base.num_inference_steps = 4;
    } else if (model.indexOf('flux/dev') !== -1) {
      base.image_size = { width: d.gw, height: d.gh };
      base.num_inference_steps = 28;
    } else if (model.indexOf('flux') !== -1) {
      // flux-2-pro and other flux-family: accept image_size object.
      base.image_size = { width: d.gw, height: d.gh };
    } else if (model.indexOf('seedream') !== -1) {
      base.image_size = { width: d.gw, height: d.gh };
    } else if (model.indexOf('nano-banana') !== -1) {
      base.aspect_ratio = d.ar;
      delete base.enable_safety_checker;
    } else if (model.indexOf('ideogram') !== -1 || model.indexOf('recraft') !== -1) {
      base.image_size = d.enum; // these prefer the enum presets
      delete base.enable_safety_checker;
    } else {
      base.image_size = { width: d.gw, height: d.gh };
    }
    return base;
  }

  function falHeaders(falKey) {
    return { 'Authorization': 'Key ' + falKey, 'Content-Type': 'application/json' };
  }

  function friendlyFalError(status, txt) {
    var msg = 'Falha ao gerar imagem (' + status + ').';
    try { var p = JSON.parse(txt); if (p.detail) msg = (typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail)); else if (p.error) msg = p.error; } catch (e) {}
    if (status === 401 || status === 403) msg = 'Chave fal.ai inválida ou sem permissão.';
    // fal returns 403 (not 402) with "Exhausted balance" when credits run out.
    if (/exhausted balance|top up/i.test(txt || '')) msg = 'Créditos fal.ai esgotados. Adicione créditos em fal.ai/dashboard/billing.';
    if (status === 402) msg = 'Créditos fal.ai insuficientes. Adicione créditos em fal.ai/dashboard.';
    if (status === 422) msg = 'Este modelo recusou os parâmetros. Tente outro modelo de imagem.';
    if (status === 429) msg = 'Muitas imagens em sequência. Aguarde alguns segundos.';
    return msg;
  }

  // ============================================================
  // OpenAI IMAGE generation (BYOK — user's own OpenAI key)
  // Model ids arrive prefixed `openai/` (e.g. openai/gpt-image-1); the prefix is
  // stripped before calling POST /v1/images/generations. Only the gpt-image-1
  // family is offered: it ALWAYS returns b64_json (→ data-URI, same pipeline as
  // fal sync_mode). Do NOT send `response_format` — the Images API rejects it
  // ("Unknown parameter", verified 2026-07-10).
  // ============================================================
  var OPENAI_IMG_ENDPOINT = 'https://api.openai.com/v1/images/generations';

  function openaiImageSize(aspect) {
    // gpt-image-1 family sizes: 1024x1024 | 1024x1536 | 1536x1024 | auto.
    return aspect === '4:5' ? '1024x1536' : '1024x1024';
  }

  function friendlyOpenAIImgError(status, txt) {
    var msg = 'Falha ao gerar imagem na OpenAI (' + status + ').';
    try { var p = JSON.parse(txt); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
    if (status === 401) msg = 'Chave OpenAI inválida. Verifique sua chave em platform.openai.com/api-keys.';
    if (status === 403) msg = 'Sua conta OpenAI não tem acesso a este modelo de imagem (pode exigir verificação da organização em platform.openai.com). Tente o GPT Image 1 mini.';
    if (status === 402 || status === 429) msg = 'Limite ou créditos insuficientes na sua conta OpenAI. Confira o billing em platform.openai.com.';
    if (status === 400 && /content_policy|safety|moderation/i.test(txt || '')) msg = 'A OpenAI recusou este prompt por política de conteúdo. Tente gerar novamente ou ajuste o tema.';
    return msg;
  }

  async function genImageOpenAI(key, model, prompt, aspect) {
    var m = model.replace(/^openai\//, '');
    // 'medium' balances custo/qualidade for slide backgrounds (low/medium/high/auto).
    var body = { model: m, prompt: prompt, n: 1, size: openaiImageSize(aspect), quality: 'medium' };
    var resp = await fetch(OPENAI_IMG_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      var et = ''; try { et = await resp.text(); } catch (e) {}
      throw new Error(friendlyOpenAIImgError(resp.status, et));
    }
    var data = await resp.json();
    var d0 = data && data.data && data.data[0];
    var b64 = d0 && d0.b64_json;
    if (!b64) throw new Error('A OpenAI não retornou uma imagem legível.');
    return { url: 'data:image/png;base64,' + b64, raw: data };
  }

  // Generate ONE image with the provider the selected model belongs to.
  // Returns { url } data-URI on success, throws on failure.
  async function genImage(imgKey, model, prompt, aspect) {
    if (String(model).indexOf('openai/') === 0) return genImageOpenAI(imgKey, model, prompt, aspect);
    return genImageFal(imgKey, model, prompt, aspect);
  }

  async function genImageFal(falKey, model, prompt, aspect) {
    var input = buildFalInput(model, aspect, prompt);
    // 1) submit to the queue
    var subResp = await fetch(FAL_BASE + model, { method: 'POST', headers: falHeaders(falKey), body: JSON.stringify(input) });
    if (!subResp.ok) {
      var st = ''; try { st = await subResp.text(); } catch (e) {}
      throw new Error(friendlyFalError(subResp.status, st));
    }
    var sub = await subResp.json();
    var statusUrl = sub.status_url;
    var responseUrl = sub.response_url;
    if (!statusUrl || !responseUrl) throw new Error('Resposta inesperada do fal.ai (sem status_url).');

    // 2) poll status (up to ~120s; some models are slower than schnell)
    var started = Date.now();
    var MAX_MS = 120000;
    while (Date.now() - started < MAX_MS) {
      await sleep(1200);
      var pResp = await fetch(statusUrl, { headers: falHeaders(falKey) });
      if (!pResp.ok) {
        var pt = ''; try { pt = await pResp.text(); } catch (e) {}
        throw new Error(friendlyFalError(pResp.status, pt));
      }
      var pj = await pResp.json();
      var status = pj.status;
      if (status === 'COMPLETED') break;
      if (status === 'FAILED' || status === 'ERROR') throw new Error('O fal.ai não conseguiu gerar esta imagem. Tente novamente ou troque o modelo.');
      // IN_QUEUE / IN_PROGRESS → keep polling
    }
    // 3) fetch the result
    var rResp = await fetch(responseUrl, { headers: falHeaders(falKey) });
    if (!rResp.ok) {
      var rt = ''; try { rt = await rResp.text(); } catch (e) {}
      throw new Error(friendlyFalError(rResp.status, rt));
    }
    var res = await rResp.json();
    var url = extractImageUrl(res);
    if (!url) throw new Error('O fal.ai não retornou uma imagem legível.');
    return { url: url, raw: res };
  }

  function extractImageUrl(res) {
    if (!res) return '';
    if (Array.isArray(res.images) && res.images[0]) {
      var i0 = res.images[0];
      if (typeof i0 === 'string') return i0;
      if (i0 && i0.url) return i0.url;
    }
    if (res.image && res.image.url) return res.image.url;
    if (typeof res.image === 'string') return res.image;
    return '';
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // ============================================================
  // Canvas compositing — draw the fal image + optional text overlay
  // Data-URI images are same-origin → no canvas taint → toDataURL works.
  // ============================================================
  function loadImage(src) {
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.onload = function() { resolve(img); };
      img.onerror = function() { reject(new Error('Não foi possível carregar a imagem gerada.')); };
      img.src = src;
    });
  }

  function coverDraw(ctx, img, W, H) {
    var ir = img.width / img.height, cr = W / H;
    var dw, dh, dx, dy;
    if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
    else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function wrapLines(ctx, text, maxWidth) {
    var words = String(text).split(/\s+/);
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = words[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  // Fit `text` into maxWidth at up to maxLines by shrinking font from `start` px.
  function fitText(ctx, text, maxWidth, weight, family, start, min, maxLines) {
    var size = start;
    while (size > min) {
      ctx.font = weight + ' ' + size + 'px ' + family;
      var lines = wrapLines(ctx, text, maxWidth);
      if (lines.length <= maxLines) return { size: size, lines: lines };
      size -= 2;
    }
    ctx.font = weight + ' ' + min + 'px ' + family;
    return { size: min, lines: wrapLines(ctx, text, maxWidth) };
  }

  var FONT = '"Helvetica Neue", Arial, sans-serif';

  // Compose one slide → PNG data URL. `st` is a slide state; `imgUri` its raw image.
  async function composite(st, imgUri, withOverlay) {
    var d = aspectDims(brief.aspect);
    var W = d.W, H = d.H;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = await loadImage(imgUri);
    coverDraw(ctx, img, W, H);

    if (!withOverlay) return canvas.toDataURL('image/png');

    var s = st.slide;
    var isCover = st.index === 0;
    var total = slidesState.length;
    var accent = '#2dd4bf';
    var pad = Math.round(W * 0.075);
    var contentW = W - pad * 2;

    // Bottom scrim for legibility
    var grad = ctx.createLinearGradient(0, H * 0.30, 0, H);
    grad.addColorStop(0, 'rgba(6,9,18,0)');
    grad.addColorStop(0.55, 'rgba(6,9,18,0.45)');
    grad.addColorStop(1, 'rgba(6,9,18,0.9)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Slight top scrim for the counter
    var tgrad = ctx.createLinearGradient(0, 0, 0, H * 0.22);
    tgrad.addColorStop(0, 'rgba(6,9,18,0.55)');
    tgrad.addColorStop(1, 'rgba(6,9,18,0)');
    ctx.fillStyle = tgrad;
    ctx.fillRect(0, 0, W, H * 0.22);

    // Counter pill (top-left)
    var num = (st.index + 1);
    var counter = String(num).padStart(2, '0') + ' / ' + String(total).padStart(2, '0');
    ctx.font = '700 ' + Math.round(W * 0.026) + 'px ' + FONT;
    var cw = ctx.measureText(counter).width;
    var pillH = Math.round(W * 0.055), pillPadX = Math.round(W * 0.03);
    roundRect(ctx, pad, pad, cw + pillPadX * 2, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(counter, pad + pillPadX, pad + pillH / 2 + 1);

    // Type chip (top-right)
    var tipo = clean(s.tipo);
    if (tipo) {
      ctx.font = '700 ' + Math.round(W * 0.024) + 'px ' + FONT;
      var tw = ctx.measureText(tipo.toUpperCase()).width;
      var tPadX = Math.round(W * 0.028);
      roundRect(ctx, W - pad - (tw + tPadX * 2), pad, tw + tPadX * 2, pillH, pillH / 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.fillStyle = '#04121a';
      ctx.textAlign = 'left';
      ctx.fillText(tipo.toUpperCase(), W - pad - (tw + tPadX * 2) + tPadX, pad + pillH / 2 + 1);
    }

    // Text block anchored to the bottom
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    var titulo = clean(s.titulo);
    var texto = clean(s.texto);
    var y = H - pad;

    // Handle / brand (very bottom)
    var handle = clean(brief.handle);
    if (handle) {
      if (handle[0] !== '@') handle = '@' + handle;
      ctx.font = '600 ' + Math.round(W * 0.026) + 'px ' + FONT;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(handle, pad, y);
      y -= Math.round(W * 0.06);
    }

    // Body text
    if (texto) {
      var bodyFit = fitText(ctx, texto, contentW, '500', FONT, Math.round(W * 0.042), Math.round(W * 0.030), isCover ? 3 : 5);
      ctx.font = '500 ' + bodyFit.size + 'px ' + FONT;
      ctx.fillStyle = 'rgba(238,242,249,0.94)';
      var blh = Math.round(bodyFit.size * 1.32);
      for (var bi = bodyFit.lines.length - 1; bi >= 0; bi--) {
        ctx.fillText(bodyFit.lines[bi], pad, y);
        y -= blh;
      }
      y -= Math.round(W * 0.012);
    }

    // Title / headline
    if (titulo) {
      var startSize = isCover ? Math.round(W * 0.085) : Math.round(W * 0.06);
      var titleFit = fitText(ctx, titulo, contentW, '800', FONT, startSize, Math.round(W * 0.04), isCover ? 4 : 3);
      ctx.font = '800 ' + titleFit.size + 'px ' + FONT;
      var tlh = Math.round(titleFit.size * 1.12);
      // accent underline mark above title
      for (var ti = titleFit.lines.length - 1; ti >= 0; ti--) {
        ctx.fillStyle = '#ffffff';
        ctx.fillText(titleFit.lines[ti], pad, y);
        y -= tlh;
      }
      y -= Math.round(W * 0.008);
      ctx.fillStyle = accent;
      roundRect(ctx, pad, y - Math.round(W * 0.012), Math.round(W * 0.12), Math.round(W * 0.014), Math.round(W * 0.007));
      ctx.fill();
    }

    return canvas.toDataURL('image/png');
  }

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

  // ============================================================
  // Generation orchestration
  // ============================================================
  function makeSlideState(slide, index) {
    return { slide: slide, index: index, status: 'pending', rawUri: '', finalUri: '', error: '' };
  }

  function fullVisualPrompt(st) {
    var s = st.slide;
    var estilo = clean(lastDeck.estilo_visual) || (brief.estilo + ' style');
    var pv = clean(s.prompt_visual) || (clean(s.titulo) + ' — ' + brief.tema);
    return estilo + '. ' + pv +
      '. Social media carousel slide background, ' + brief.estilo.toLowerCase() +
      ', clean negative space for text, high quality, cohesive series. ' +
      'Absolutely no text, no words, no letters, no numbers, no typography, no logos, no watermark.';
  }

  async function generateAll(activeKey, imgKey) {
    setProgress(0, slidesState.length, 'Escrevendo o roteiro do carrossel…');

    // 1) TEXT plan
    var plan;
    try {
      plan = await RateLimiter.executeWithLimit('carousel-text', function() { return generatePlan(activeKey); });
    } catch (e) {
      throw e;
    }
    if (!plan) throw new Error('Limite de uso atingido. Aguarde um instante e tente novamente.');
    lastDeck = plan;

    var slides = Array.isArray(plan.slides) ? plan.slides.filter(function(s) { return s && (clean(s.titulo) || clean(s.texto) || clean(s.prompt_visual)); }) : [];
    if (!slides.length) throw new Error('A IA não retornou slides. Tente novamente.');
    slidesState = slides.map(makeSlideState);

    renderStage();       // deck skeleton with placeholders + tail
    deckGo(0);

    // 2) IMAGES — sequential, progressive reveal
    var withOverlay = !!brief.overlay;
    var done = 0;
    for (var i = 0; i < slidesState.length; i++) {
      var st = slidesState[i];
      st.status = 'gen';
      updateSlideCard(i);
      setProgress(done, slidesState.length, 'Gerando imagem ' + (i + 1) + ' de ' + slidesState.length + '…');
      try {
        var prompt = fullVisualPrompt(st);
        var out = await RateLimiter.executeWithLimit('carousel-image', (function(p) {
          return function() { return genImage(imgKey, ApiKeyManager.getFalModel(), p, brief.aspect); };
        })(prompt));
        if (!out) { st.status = 'error'; st.error = 'Limite de uso atingido. Aguarde e tente novamente este slide.'; updateSlideCard(i); continue; }
        st.rawUri = out.url;
        st.status = 'compositing';
        updateSlideCard(i);
        st.finalUri = await composite(st, out.url, withOverlay);
        st.status = 'done';
        done++;
        updateSlideCard(i);
        setProgress(done, slidesState.length, done < slidesState.length ? ('Gerando imagem ' + (done + 1) + ' de ' + slidesState.length + '…') : 'Finalizando…');
      } catch (e) {
        st.status = 'error';
        st.error = (e && e.message) ? e.message : 'Erro ao gerar esta imagem.';
        updateSlideCard(i);
      }
    }

    updateDeckActions();
    var ok = slidesState.filter(function(s) { return s.status === 'done'; }).length;
    if (ok === 0) {
      setProgress(0, slidesState.length, '');
      var prov = ApiKeyManager.imageProviderFor(ApiKeyManager.getFalModel());
      throw new Error('Nenhuma imagem foi gerada. Confira sua chave ' + (prov === 'openai' ? 'OpenAI' : 'fal.ai') + ' e os créditos.');
    }
    setProgress(slidesState.length, slidesState.length, '');
    setStatus(ok + ' de ' + slidesState.length + ' imagens prontas!' + (ok < slidesState.length ? ' Você pode tentar novamente os slides com erro.' : ''), 'ok');
  }

  // Retry a single failed/individual slide's image
  async function retrySlide(i) {
    if (isBusy) return;
    var st = slidesState[i];
    if (!st) return;
    var ik = ApiKeyManager.getImageKey();
    if (!ik.key) {
      setStatus(ik.provider === 'openai'
        ? 'Adicione sua chave OpenAI para gerar imagens com este modelo.'
        : 'Adicione sua chave fal.ai para gerar imagens.', 'err');
      return;
    }
    st.status = 'gen'; st.error = ''; updateSlideCard(i);
    try {
      var prompt = fullVisualPrompt(st);
      var out = await RateLimiter.executeWithLimit('carousel-image', function() { return genImage(ik.key, ApiKeyManager.getFalModel(), prompt, brief.aspect); });
      if (!out) { st.status = 'error'; st.error = 'Limite de uso atingido.'; updateSlideCard(i); return; }
      st.rawUri = out.url;
      st.status = 'compositing'; updateSlideCard(i);
      st.finalUri = await composite(st, out.url, !!brief.overlay);
      st.status = 'done'; updateSlideCard(i);
      updateDeckActions();
    } catch (e) {
      st.status = 'error';
      st.error = (e && e.message) ? e.message : 'Erro ao gerar.';
      updateSlideCard(i);
    }
  }

  // ============================================================
  // Rendering — image deck + tail
  // ============================================================
  function renderStage() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    var d = lastDeck || {};
    var titulo = clean(d.titulo) || 'Seu carrossel';
    var conceito = clean(d.conceito);

    var html = '';
    html += '<div class="deck-head">' +
      '<div class="deck-slate">' + esc(brief.plataforma) + ' · ' + esc(brief.objetivo) + ' · ' + esc(brief.aspect) + ' · ' + esc(slidesState.length) + ' slides</div>' +
      '<div class="deck-title">' + esc(titulo) + '</div>' +
      (conceito ? '<div class="deck-concept">' + esc(conceito) + '</div>' : '') +
    '</div>';

    html += '<div class="deck-actions" id="deck-actions"></div>';

    html += '<div class="deck-viewport">';
    html += '<button type="button" class="deck-nav prev" id="deck-prev" aria-label="Slide anterior">‹</button>';
    html += '<div class="deck-track" id="deck-track">';
    slidesState.forEach(function(st, i) {
      html += '<article class="img-card" data-idx="' + i + '" id="img-card-' + i + '">' + slideCardInner(st) + '</article>';
    });
    html += '</div>';
    html += '<button type="button" class="deck-nav next" id="deck-next" aria-label="Próximo slide">›</button>';
    html += '</div>';

    html += '<div class="deck-dots" id="deck-dots">';
    slidesState.forEach(function(st, i) {
      html += '<button type="button" class="dot' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '" aria-label="Ir para o slide ' + (i + 1) + '"></button>';
    });
    html += '</div>';

    // tail (caption / hashtags / tips)
    html += renderTail();

    stage.innerHTML = html;
    wireDeck();
    wireTail();
    updateDeckActions();
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function slideCardInner(st) {
    var i = st.index;
    var aspectCls = brief.aspect === '4:5' ? ' a45' : ' a11';
    var media;
    if (st.status === 'done' && st.finalUri) {
      media = '<img class="img-real" src="' + st.finalUri + '" alt="Slide ' + (i + 1) + '" loading="lazy">';
    } else if (st.status === 'error') {
      media = '<div class="img-ph err">' +
        '<div class="ph-ico">⚠</div>' +
        '<div class="ph-msg">' + esc(st.error || 'Erro ao gerar.') + '</div>' +
        '<button type="button" class="retry-btn" data-idx="' + i + '">Tentar novamente</button>' +
      '</div>';
    } else {
      var label = st.status === 'compositing' ? 'Aplicando o texto…' : (st.status === 'gen' ? 'Gerando imagem…' : 'Na fila…');
      media = '<div class="img-ph"><div class="ph-spinner"></div><div class="ph-msg">' + esc(label) + '</div></div>';
    }
    var cap = '<div class="img-cap">' +
      '<span class="ic-num">' + String(i + 1).padStart(2, '0') + '/' + String(slidesState.length).padStart(2, '0') + '</span>' +
      (clean(st.slide.titulo) ? '<span class="ic-title">' + esc(clean(st.slide.titulo)) + '</span>' : '') +
    '</div>';
    var tools = '';
    if (st.status === 'done' && st.finalUri) {
      tools = '<div class="img-tools">' +
        '<button type="button" class="it-btn dl-one" data-idx="' + i + '">Baixar PNG</button>' +
        (brief.overlay && st.rawUri ? '<button type="button" class="it-btn dl-raw" data-idx="' + i + '">Imagem sem texto</button>' : '') +
      '</div>';
    }
    return '<div class="img-frame' + aspectCls + '">' + media + '</div>' + cap + tools;
  }

  function updateSlideCard(i) {
    var card = document.getElementById('img-card-' + i);
    if (!card) return;
    card.innerHTML = slideCardInner(slidesState[i]);
    wireCardButtons(card);
  }

  function wireCardButtons(scope) {
    (scope || document).querySelectorAll('.retry-btn').forEach(function(b) {
      b.onclick = function() { retrySlide(parseInt(b.dataset.idx, 10)); };
    });
    (scope || document).querySelectorAll('.dl-one').forEach(function(b) {
      b.onclick = function() { downloadOne(parseInt(b.dataset.idx, 10), false); };
    });
    (scope || document).querySelectorAll('.dl-raw').forEach(function(b) {
      b.onclick = function() { downloadOne(parseInt(b.dataset.idx, 10), true); };
    });
  }

  function updateDeckActions() {
    var el = document.getElementById('deck-actions');
    if (!el) return;
    var okCount = slidesState.filter(function(s) { return s.status === 'done'; }).length;
    var html = '';
    html += '<button type="button" class="act-btn primary" id="dl-zip"' + (okCount ? '' : ' disabled') + '>⬇ Baixar todas (.zip)</button>';
    html += '<button type="button" class="act-btn" id="copy-caption">Copiar legenda + hashtags</button>';
    html += '<button type="button" class="act-btn" id="download-txt">Baixar roteiro .txt</button>';
    el.innerHTML = html;
    var zip = document.getElementById('dl-zip');
    if (zip) zip.onclick = downloadAllZip;
    var cap = document.getElementById('copy-caption');
    if (cap) cap.onclick = function() { copyText(captionToText(), cap); };
    var txt = document.getElementById('download-txt');
    if (txt) txt.onclick = downloadTxt;
  }

  function renderTail() {
    var d = lastDeck || {};
    var legenda = clean(d.legenda);
    var hashtags = Array.isArray(d.hashtags) ? d.hashtags.filter(function(h) { return clean(h); }) : [];
    var dicas = Array.isArray(d.dicas) ? d.dicas.filter(function(x) { return clean(x); }) : [];
    var html = '<div class="tail-grid">';
    if (legenda || hashtags.length) {
      html += '<div class="tail-card">' +
        '<div class="block-label">Legenda do post</div>' +
        (legenda ? '<div class="tail-text">' + esc(legenda).replace(/\n/g, '<br>') + '</div>' : '') +
        (hashtags.length ? '<div class="hashtags">' + hashtags.map(function(h) { return '<span class="hashtag">#' + esc(String(h).replace(/^#/, '')) + '</span>'; }).join('') + '</div>' : '') +
      '</div>';
    }
    if (dicas.length) {
      html += '<div class="tail-card">' +
        '<div class="block-label">Dicas de publicação</div>' +
        '<ul class="tips">' + dicas.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  function wireTail() {
    // buttons wired in updateDeckActions
  }

  function wireDeck() {
    var track = document.getElementById('deck-track');
    var prev = document.getElementById('deck-prev');
    var next = document.getElementById('deck-next');
    var dots = Array.prototype.slice.call(document.querySelectorAll('#deck-dots .dot'));
    if (!track) return;

    if (prev) prev.addEventListener('click', function() { deckGo(deckIndex - 1); });
    if (next) next.addEventListener('click', function() { deckGo(deckIndex + 1); });
    dots.forEach(function(dot) { dot.addEventListener('click', function() { deckGo(parseInt(dot.dataset.idx, 10)); }); });

    var scrollTimer = null;
    track.addEventListener('scroll', function() {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function() {
        var cards = Array.prototype.slice.call(track.querySelectorAll('.img-card'));
        var center = track.scrollLeft + track.clientWidth / 2;
        var best = 0, bestDist = Infinity;
        cards.forEach(function(c, i) {
          var c2 = c.offsetLeft - track.offsetLeft + c.clientWidth / 2;
          var dist = Math.abs(c2 - center);
          if (dist < bestDist) { bestDist = dist; best = i; }
        });
        setActive(best);
      }, 90);
    });

    wireCardButtons(track);
  }

  function setActive(idx) {
    deckIndex = Math.max(0, Math.min(slidesState.length - 1, idx));
    var dots = Array.prototype.slice.call(document.querySelectorAll('#deck-dots .dot'));
    dots.forEach(function(dot, i) { dot.classList.toggle('active', i === deckIndex); });
    var prev = document.getElementById('deck-prev');
    var next = document.getElementById('deck-next');
    if (prev) prev.disabled = deckIndex === 0;
    if (next) next.disabled = deckIndex === slidesState.length - 1;
  }

  function deckGo(idx) {
    var track = document.getElementById('deck-track');
    if (!track) return;
    setActive(idx);
    var card = track.querySelector('.img-card[data-idx="' + deckIndex + '"]');
    if (card) track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: 'smooth' });
  }

  // ============================================================
  // Downloads
  // ============================================================
  function dataURItoBytes(dataURI) {
    var comma = dataURI.indexOf(',');
    var b64 = dataURI.slice(comma + 1);
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function triggerDownload(blobOrUrl, filename) {
    var url = (typeof blobOrUrl === 'string') ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if (typeof blobOrUrl !== 'string') setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
  }

  function baseSlug() {
    return slugify(lastDeck && lastDeck.titulo, 'carrossel');
  }

  function downloadOne(i, raw) {
    var st = slidesState[i];
    if (!st) return;
    var uri = raw ? st.rawUri : (st.finalUri || st.rawUri);
    if (!uri) return;
    var ext = uri.indexOf('data:image/png') === 0 ? 'png' : 'jpg';
    triggerDownload(uri, baseSlug() + '-slide-' + String(i + 1).padStart(2, '0') + (raw ? '-sem-texto' : '') + '.' + ext);
  }

  // ---- minimal ZIP (STORE method, no library) ----
  var CRC_TABLE = (function() {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function strBytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
    return out;
  }
  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  function buildZip(files) {
    // files: [{ name, bytes }]
    var chunks = [];
    var central = [];
    var offset = 0;
    files.forEach(function(f) {
      var nameBytes = strBytes(f.name);
      var crc = crc32(f.bytes);
      var size = f.bytes.length;
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
        nameBytes
      );
      var localArr = new Uint8Array(local.length + size);
      localArr.set(local, 0);
      localArr.set(f.bytes, local.length);
      chunks.push(localArr);

      var cen = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), nameBytes
      );
      central.push(new Uint8Array(cen));
      offset += localArr.length;
    });
    var centralSize = central.reduce(function(a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(offset), u16(0)
    ));
    var all = chunks.concat(central).concat([eocd]);
    return new Blob(all, { type: 'application/zip' });
  }

  function downloadAllZip() {
    var done = slidesState.filter(function(s) { return s.status === 'done' && (s.finalUri || s.rawUri); });
    if (!done.length) return;
    var files = done.map(function(st) {
      var uri = st.finalUri || st.rawUri;
      var ext = uri.indexOf('data:image/png') === 0 ? 'png' : 'jpg';
      return { name: baseSlug() + '-slide-' + String(st.index + 1).padStart(2, '0') + '.' + ext, bytes: dataURItoBytes(uri) };
    });
    try {
      var blob = buildZip(files);
      triggerDownload(blob, baseSlug() + '-carrossel.zip');
    } catch (e) {
      setStatus('Não foi possível montar o .zip. Baixe as imagens uma a uma.', 'err');
    }
  }

  // ---------- text exports ----------
  function captionToText() {
    if (!lastDeck) return '';
    var parts = [];
    if (clean(lastDeck.legenda)) parts.push(clean(lastDeck.legenda));
    var tags = (lastDeck.hashtags || []).filter(function(h) { return clean(h); });
    if (tags.length) parts.push(tags.map(function(h) { return '#' + String(h).replace(/^#/, ''); }).join(' '));
    return parts.join('\n\n');
  }

  function deckToText() {
    if (!lastDeck) return '';
    var d = lastDeck;
    var lines = [];
    lines.push('CARROSSEL: ' + (clean(d.titulo) || ''));
    if (clean(d.conceito)) lines.push('Conceito: ' + clean(d.conceito));
    lines.push(brief.plataforma + ' · ' + brief.objetivo + ' · ' + brief.tom + ' · ' + brief.aspect);
    lines.push('');
    slidesState.forEach(function(st, i) {
      var s = st.slide;
      lines.push('SLIDE ' + (i + 1) + (clean(s.tipo) ? ' — ' + clean(s.tipo) : ''));
      if (clean(s.titulo)) lines.push(clean(s.titulo));
      if (clean(s.texto)) lines.push(clean(s.texto));
      if (clean(s.prompt_visual)) lines.push('[Imagem: ' + clean(s.prompt_visual) + ']');
      lines.push('');
    });
    if (clean(d.legenda)) { lines.push('LEGENDA:'); lines.push(clean(d.legenda)); lines.push(''); }
    var tags = (d.hashtags || []).filter(function(h) { return clean(h); });
    if (tags.length) lines.push(tags.map(function(h) { return '#' + String(h).replace(/^#/, ''); }).join(' '));
    var dicas = (d.dicas || []).filter(function(x) { return clean(x); });
    if (dicas.length) { lines.push(''); lines.push('DICAS:'); dicas.forEach(function(x) { lines.push('- ' + clean(x)); }); }
    return lines.join('\n');
  }

  function downloadTxt() {
    var text = deckToText();
    if (!text) return;
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    triggerDownload(blob, baseSlug() + '.txt');
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

  // ============================================================
  // Status / progress
  // ============================================================
  function setStatus(msg, kind) {
    var el = document.getElementById('gen-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? 'var(--danger)' : (kind === 'ok' ? 'var(--good)' : 'var(--text-muted)');
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

  // Warn when the key needed by the SELECTED image model is missing.
  function refreshFalWarn() {
    var warn = document.getElementById('fal-warn');
    if (!warn || !window.ApiKeyManager) return;
    var ik = ApiKeyManager.getImageKey();
    if (ik.key) { warn.style.display = 'none'; return; }
    warn.innerHTML = ik.provider === 'openai'
      ? 'O modelo de imagem escolhido usa a sua chave <strong>OpenAI</strong>. Adicione-a no ícone da chave (topo) para gerar as imagens.'
      : 'Adicione sua chave <strong>fal.ai</strong> (ícone da chave no topo) para gerar as imagens reais — ou escolha um modelo de imagem da OpenAI, se você já tem uma chave OpenAI.';
    warn.style.display = 'block';
  }

  // ============================================================
  // Setup
  // ============================================================
  function setupGenerate() {
    if (window.ApiKeyManager) {
      if (ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
      if (ApiKeyManager.renderFalModelPicker) ApiKeyManager.renderFalModelPicker('fal-model-select', ['image', 'openaiImage']);
    }
    refreshFalWarn();
    document.addEventListener('carrossel:keys-updated', refreshFalWarn);
    var imgSelect = document.getElementById('fal-model-select');
    if (imgSelect) imgSelect.addEventListener('change', refreshFalWarn);

    var btn = document.getElementById('generate-btn');
    if (!btn) return;

    btn.addEventListener('click', async function() {
      if (isBusy) return;
      if (!brief.tema.trim()) { setStatus('Descreva o tema do carrossel primeiro.', 'err'); return; }

      var active = window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null;
      if (!active) {
        setStatus('Configure sua chave de texto (OpenRouter/OpenAI) no ícone da chave.', 'err');
        var mk = document.getElementById('manage-keys-btn'); if (mk) mk.click();
        return;
      }
      var ik = ApiKeyManager.getImageKey();
      if (!ik.key) {
        setStatus(ik.provider === 'openai'
          ? 'O modelo de imagem escolhido usa a chave OpenAI. Adicione-a no ícone da chave.'
          : 'Adicione sua chave fal.ai (ícone da chave) para gerar as imagens.', 'err');
        refreshFalWarn();
        var mk2 = document.getElementById('manage-keys-btn'); if (mk2) mk2.click();
        return;
      }

      isBusy = true;
      btn.disabled = true;
      var origLabel = btn.textContent;
      btn.textContent = 'Gerando…';
      setStatus('', 'info');
      try {
        await generateAll(active, ik.key);
      } catch (e) {
        setStatus((e && e.message) ? e.message : 'Erro ao gerar.', 'err');
        setProgress(0, 0, '');
        if (!slidesState.length) restoreEmpty();
      } finally {
        isBusy = false;
        btn.disabled = false;
        btn.textContent = origLabel;
      }
    });
  }

  function restoreEmpty() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    stage.innerHTML = '<div class="stage-empty" id="stage-empty">' +
      '<div class="empty-deck"><span></span><span></span><span></span></div>' +
      '<p>Preencha o briefing à esquerda e clique em <strong>Gerar carrossel com imagens</strong>. A IA escreve o roteiro e um prompt visual por slide; o modelo de imagem escolhido (fal.ai ou OpenAI, com a sua chave) renderiza a <strong>imagem real</strong> de cada slide, prontas para baixar (uma a uma ou em .zip) e publicar.</p>' +
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
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(tryAppInit, 150);
  });
})();
