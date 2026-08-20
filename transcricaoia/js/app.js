/**
 * Transcrição IA — Main Application Logic
 * ---------------------------------------------------------------------------
 * Upload de áudio/vídeo → transcrição com timestamps via OpenAI Whisper (BYOK)
 * → construtores determinísticos de legendas .SRT / .VTT / .TXT → cues editáveis
 * → camada opcional de IA (traduzir legendas mantendo o tempo; transcrição limpa).
 *
 * BYOK (Hard Rule #1): a transcrição roda na chave OpenAI do próprio usuário; o
 * arquivo vai direto para api.openai.com — nunca passa por nenhum servidor nosso.
 * A tradução/limpeza usa a chave OpenAI (padrão) ou uma chave OpenRouter (mais modelos).
 * LLM plumbing: COR-032 (reroll) / COR-034-035 (reasoning/deepseek) / COR-015 (null-strings).
 */
(function () {
  'use strict';

  var MAX_BYTES = 25 * 1024 * 1024;           // OpenAI Whisper hard limit
  var MAXTOK = 8000;                          // per translate batch (reasoning + content, COR-034)
  var MAXTOK_CLEAN = 16000;                   // clean transcript
  var TRANSLATE_BATCH = 24;                   // segments per LLM call
  var CLEAN_INPUT_CAP = 24000;                // chars fed to the clean step

  // ── state ──
  var STATE = {
    file: null,
    duration: 0,
    tracks: { orig: null, trans: null },      // each: { label, langName, segs:[{start,end,text}] }
    active: 'orig',
    clean: ''
  };
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
  function fmtBytes(n) {
    if (!isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function pad(n, w) { n = String(Math.floor(n)); while (n.length < w) n = '0' + n; return n; }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + ':' + pad(m, 2) : m) + ':' + pad(s, 2);
  }
  function slug(s) {
    return (String(s || 'transcricao').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'transcricao').slice(0, 40);
  }

  function toast(msg, isErr) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = 'toast' + (isErr ? ' error' : ''); }, 3200);
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
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob); var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 120);
  }

  // ============================================================ timecodes + wrapping (deterministic)
  function tc(sec, sepMs) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var ms = Math.round(sec * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sepMs + pad(ms, 3);
  }
  function srtTime(sec) { return tc(sec, ','); }
  function vttTime(sec) { return tc(sec, '.'); }

  // wrap a cue's text into readable lines (~42 chars, break on word boundaries)
  function wrapText(text, max) {
    max = max || 42;
    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!line) { line = w; }
      else if ((line + ' ' + w).length <= max) { line += ' ' + w; }
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  }

  function buildSRT(segs) {
    return segs.map(function (s, i) {
      return (i + 1) + '\n' + srtTime(s.start) + ' --> ' + srtTime(s.end) + '\n' + wrapText(s.text) + '\n';
    }).join('\n');
  }
  function buildVTT(segs) {
    return 'WEBVTT\n\n' + segs.map(function (s, i) {
      return (i + 1) + '\n' + vttTime(s.start) + ' --> ' + vttTime(s.end) + '\n' + wrapText(s.text) + '\n';
    }).join('\n');
  }
  function buildTXT(segs) {
    return segs.map(function (s) { return String(s.text || '').trim(); }).filter(Boolean).join(' ');
  }

  // ============================================================ file handling
  function onFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast('Arquivo de ' + fmtBytes(file.size) + ' — acima do limite de 25 MB do Whisper. Comprima ou extraia só o áudio.', true);
      return;
    }
    STATE.file = file;
    var dz = $('dropzone'); dz.classList.add('has-file');
    dz.querySelector('.dz-idle').hidden = true;
    var f = dz.querySelector('.dz-file'); f.hidden = false;
    $('file-name').textContent = file.name;
    $('file-size').textContent = fmtBytes(file.size);
    // best-effort duration probe (does not block)
    probeDuration(file);
  }
  function clearFile() {
    STATE.file = null; STATE.duration = 0;
    var dz = $('dropzone'); dz.classList.remove('has-file');
    dz.querySelector('.dz-idle').hidden = false;
    dz.querySelector('.dz-file').hidden = true;
    $('file-input').value = '';
  }
  function probeDuration(file) {
    try {
      var url = URL.createObjectURL(file);
      var el = document.createElement(/^video\//.test(file.type) ? 'video' : 'audio');
      el.preload = 'metadata';
      el.onloadedmetadata = function () {
        STATE.duration = el.duration || 0; URL.revokeObjectURL(url);
        if (isFinite(el.duration) && el.duration > 0) $('file-size').textContent = fmtBytes(file.size) + ' · ' + fmtDur(el.duration);
      };
      el.onerror = function () { URL.revokeObjectURL(url); };
      el.src = url;
    } catch (e) { /* ignore */ }
  }

  // ============================================================ transcription (Whisper, BYOK OpenAI)
  function transcribe() {
    if (busy) return;
    if (!STATE.file) { toast('Envie um arquivo de áudio ou vídeo primeiro.', true); return; }
    var key = ApiKeyManager.getKey('openai');
    if (!key) { toast('Cole sua chave OpenAI (ícone de chave no topo) para transcrever.', true); flagKey(); return; }

    var lang = $('in-language').value.trim();
    var hint = $('in-hint').value.trim();

    setBusy(true, 'btn-transcribe');
    renderLoading('Transcrevendo o áudio…', 'Enviando para o Whisper (OpenAI) e sincronizando os tempos. Isso roda 100% na sua chave.');

    var run = function () { return doTranscribe(STATE.file, key, lang, hint); };
    var p = (typeof RateLimiter !== 'undefined' && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('transcrever', run) : run();

    p.then(function () {}).catch(showError).then(function () { setBusy(false, 'btn-transcribe'); });
  }

  function doTranscribe(file, key, lang, hint) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'segment');
    if (lang) fd.append('language', lang);
    if (hint) fd.append('prompt', hint);

    return fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: fd
    }).then(function (resp) {
      return resp.text().then(function (txt) {
        if (!resp.ok) {
          var msg = 'Erro ' + resp.status;
          try { var ej = JSON.parse(txt); msg = (ej.error && (ej.error.message || ej.error)) || msg; } catch (e) {}
          var er = new Error(typeof msg === 'string' ? msg : ('Erro ' + resp.status)); er.status = resp.status; throw er;
        }
        var data = {}; try { data = JSON.parse(txt); } catch (e) { throw new Error('Resposta ilegível da OpenAI.'); }
        var segs = Array.isArray(data.segments) ? data.segments.map(function (s) {
          return { start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim() };
        }).filter(function (s) { return s.text; }) : [];
        if (!segs.length) {
          var full = String(data.text || '').trim();
          if (!full) throw new Error('Não foi detectada fala no arquivo. Verifique se o áudio tem voz audível.');
          segs = [{ start: 0, end: (+data.duration || STATE.duration || 3), text: full }];
        }
        STATE.duration = +data.duration || STATE.duration || (segs[segs.length - 1] && segs[segs.length - 1].end) || 0;
        STATE.tracks = { orig: { label: 'Original', langName: langName(data.language || lang), segs: segs }, trans: null };
        STATE.active = 'orig';
        STATE.clean = '';
        renderResults();
        $('refine').hidden = false;
        toast('Transcrição pronta — ' + segs.length + ' blocos.');
      });
    });
  }

  function langName(code) {
    var map = { pt: 'Português', portuguese: 'Português', en: 'Inglês', english: 'Inglês', es: 'Espanhol', spanish: 'Espanhol',
      fr: 'Francês', french: 'Francês', it: 'Italiano', italian: 'Italiano', de: 'Alemão', german: 'Alemão',
      ja: 'Japonês', japanese: 'Japonês', zh: 'Chinês', chinese: 'Chinês' };
    var k = String(code || '').toLowerCase();
    return map[k] || (code ? String(code).charAt(0).toUpperCase() + String(code).slice(1) : 'Detectado');
  }

  // ============================================================ LLM plumbing (proven — COR-032/034/035)
  function routeForModel(model) {
    var isOpenAI = model.indexOf('openai/') === 0;
    var oa = ApiKeyManager.getKey('openai');
    var or = ApiKeyManager.getKey('openrouter');
    if (isOpenAI) {
      if (oa) return { service: 'openai', key: oa };
      if (or) return { service: 'openrouter', key: or };
      return { error: 'Cole sua chave OpenAI em “Chaves” para usar este modelo.' };
    }
    if (or) return { service: 'openrouter', key: or };
    return { error: 'Este modelo exige uma chave OpenRouter. Cole sua chave OpenRouter em “Chaves” ou escolha um modelo OpenAI.' };
  }

  function fetchContent(messages, active, model, temperature, noReasoning, maxTokens) {
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var url, headers, body;
    if (active.service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + active.key,
        'HTTP-Referer': 'https://transcricaoia.appsbrasil.store', 'X-Title': 'Transcricao IA' };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: maxTokens };
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034/035
    } else {
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

  function fetchResilient(messages, temperature, maxTokens) {
    var model = ApiKeyManager.getModel();
    var active = routeForModel(model);
    if (active.error) return Promise.reject(new Error(active.error));
    return fetchContent(messages, active, model, temperature, false, maxTokens).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') return fetchContent(messages, active, model, temperature, true, maxTokens);
      throw e;
    });
  }

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
    maxTokens = maxTokens || MAXTOK;
    return fetchResilient(messages, 0.5, maxTokens).then(function (raw) {
      var obj = tryParse(raw); if (obj) return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NAO era um JSON valido. Responda AGORA com APENAS o objeto JSON pedido — sem texto fora do JSON, sem markdown, sem crases. Use aspas retas.' }]);
      return fetchResilient(strict, 0.3, maxTokens).then(function (raw2) {
        var obj2 = tryParse(raw2); if (obj2) return obj2;
        throw new Error('O modelo nao devolveu um JSON valido. Tente novamente ou troque de modelo.');
      });
    });
  }

  // ============================================================ translate (keeps timings)
  function translate() {
    if (busy) return;
    var orig = STATE.tracks.orig; if (!orig) return;
    var target = $('in-target-lang').value.trim() || 'Inglês';
    setBusy(true, 'btn-translate');
    toast('Traduzindo legendas para ' + target + '…');

    var segs = orig.segs;
    var batches = [];
    for (var i = 0; i < segs.length; i += TRANSLATE_BATCH) batches.push(segs.slice(i, i + TRANSLATE_BATCH));
    var out = new Array(segs.length);

    var idx = 0;
    function next() {
      if (idx >= batches.length) {
        STATE.tracks.trans = { label: target, langName: target, segs: out.map(function (o, k) {
          return { start: segs[k].start, end: segs[k].end, text: clean(o) || segs[k].text };
        }) };
        STATE.active = 'trans';
        renderResults();
        toast('Legendas traduzidas para ' + target + '.');
        setBusy(false, 'btn-translate');
        return Promise.resolve();
      }
      var base = idx * TRANSLATE_BATCH;
      var batch = batches[idx];
      var bt = $('btn-translate'); if (bt) bt.textContent = 'Traduzindo… ' + (idx + 1) + '/' + batches.length;
      return translateBatch(batch, target).then(function (arr) {
        for (var k = 0; k < batch.length; k++) out[base + k] = (arr && arr[k] != null) ? arr[k] : batch[k].text;
        idx++;
        return next();
      });
    }
    next().catch(function (e) {
      showErrorToast(e);
      var bt = $('btn-translate'); if (bt) bt.textContent = 'Traduzir';
      setBusy(false, 'btn-translate');
    });
  }

  function translateBatch(batch, target) {
    var lines = batch.map(function (s, i) { return i + '␟' + s.text.replace(/\n/g, ' '); }).join('\n');
    var sys = 'Você é um tradutor profissional de legendas. Traduza cada linha para ' + target + ', preservando o sentido, o tom falado e a naturalidade. NÃO junte nem divida linhas: a saída tem exatamente o mesmo número de itens que a entrada, na mesma ordem. Responda SOMENTE com um objeto JSON válido.';
    var usr = 'Cada linha abaixo é "índice␟texto". Traduza o texto de cada uma para ' + target + '.\n\n' + lines +
      '\n\nRetorne EXATAMENTE: {"linhas":[{"i":0,"t":"<tradução>"}, ...]} com um item por índice, na ordem, sem texto fora do JSON.';
    return generateJSON([{ role: 'system', content: sys }, { role: 'user', content: usr }], MAXTOK).then(function (obj) {
      var arr = (obj && Array.isArray(obj.linhas)) ? obj.linhas : (Array.isArray(obj) ? obj : []);
      var res = new Array(batch.length);
      arr.forEach(function (it) {
        if (!it) return;
        var i = (typeof it.i === 'number') ? it.i : parseInt(it.i, 10);
        if (isFinite(i) && i >= 0 && i < batch.length) res[i] = clean(it.t != null ? it.t : it.texto);
      });
      return res;
    });
  }

  // ============================================================ clean transcript
  function cleanTranscript() {
    if (busy) return;
    var orig = STATE.tracks.orig; if (!orig) return;
    var raw = buildTXT(orig.segs);
    var truncated = false;
    if (raw.length > CLEAN_INPUT_CAP) { raw = raw.slice(0, CLEAN_INPUT_CAP); truncated = true; }

    setBusy(true, 'btn-clean');
    toast('Gerando transcrição limpa…');
    var sys = 'Você é um editor de texto. Recebe uma transcrição corrida (fala transcrita, sem pontuação adequada) e devolve o MESMO conteúdo reescrito de forma limpa e legível em português: pontuação correta, parágrafos coerentes, remoção de muletas e repetições ("é", "tipo", "né", gaguejos), SEM inventar nada e SEM resumir — apenas organizar a fala em texto de leitura. Não use markdown; separe parágrafos com uma linha em branco.';
    var usr = 'Reescreva de forma limpa e legível a transcrição a seguir, mantendo todo o conteúdo:\n\n' + raw;

    fetchResilient([{ role: 'system', content: sys }, { role: 'user', content: usr }], 0.4, MAXTOK_CLEAN)
      .then(function (text) {
        STATE.clean = clean(text) + (truncated ? '\n\n[Transcrição longa: foi limpo o início. Para o restante, gere por partes.]' : '');
        renderResults();
        toast('Transcrição limpa pronta.');
        var el = $('clean-block'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
      .catch(showErrorToast)
      .then(function () { setBusy(false, 'btn-clean'); });
  }

  // ============================================================ render
  function activeSegs() { var t = STATE.tracks[STATE.active]; return t ? t.segs : []; }

  function renderLoading(title, sub) {
    $('results').innerHTML =
      '<div class="state"><div class="spinner"></div>' +
      '<h3>' + esc(title) + '</h3><p>' + esc(sub) + '</p>' +
      '<div class="subnote">ÁUDIO · WHISPER · TIMESTAMPS</div></div>';
  }
  function showError(e) {
    var msg = friendly(e);
    $('results').innerHTML =
      '<div class="state"><div class="state-glyph"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<h3>Não foi possível transcrever</h3><p>' + esc(msg) + '</p></div>';
    toast(msg, true);
  }
  function showErrorToast(e) { toast(friendly(e), true); }
  function friendly(e) {
    var msg = (e && e.message) ? e.message : 'Falha ao processar.';
    if (/401|invalid|unauthor|incorrect api key/i.test(msg)) return 'Chave de API inválida ou sem permissão. Verifique sua chave.';
    if (/429|rate|quota|exceeded your current quota|insufficient|billing|exhaust/i.test(msg)) return 'Sua conta de IA está sem créditos ou atingiu o limite. Verifique o faturamento e tente de novo.';
    if (/413|maximum content|too large|25 ?mb/i.test(msg)) return 'Arquivo acima de 25 MB. Comprima ou extraia só o áudio.';
    return msg;
  }

  function renderResults() {
    var orig = STATE.tracks.orig; if (!orig) return;
    var segs = activeSegs();
    var lang = STATE.tracks[STATE.active].langName;
    var hasTrans = !!STATE.tracks.trans;

    var head =
      '<div class="res-head"><div class="res-title"><h2>Legendas prontas</h2>' +
        '<div class="res-sub">' +
          '<span class="chip">' + segs.length + ' blocos</span>' +
          '<span class="chip mono">' + fmtDur(STATE.duration) + '</span>' +
          '<span class="chip">' + esc(lang) + '</span>' +
        '</div></div>' +
        '<div class="res-actions">' +
          '<button class="btn-sm" id="btn-srt">⤓ .SRT</button>' +
          '<button class="btn-sm" id="btn-vtt">⤓ .VTT</button>' +
          '<button class="btn-sm" id="btn-txt">⤓ .TXT</button>' +
          '<button class="btn-sm primary" id="btn-copy">Copiar</button>' +
        '</div></div>';

    var tabs = hasTrans ?
      '<div class="track-tabs">' +
        '<button class="track-tab' + (STATE.active === 'orig' ? ' active' : '') + '" data-track="orig">Original · ' + esc(orig.langName) + '</button>' +
        '<button class="track-tab' + (STATE.active === 'trans' ? ' active' : '') + '" data-track="trans">Tradução · ' + esc(STATE.tracks.trans.langName) + '</button>' +
      '</div>' : '';

    var cues = '<div class="cue-list">' + segs.map(function (s, i) {
      return '<div class="cue">' +
        '<div class="cue-idx">' + (i + 1) + '</div>' +
        '<div class="cue-body">' +
          '<div class="cue-time mono">' + srtTime(s.start) + ' <span class="arrow">→</span> ' + srtTime(s.end) + '</div>' +
          '<div class="cue-text" contenteditable="true" spellcheck="false" data-i="' + i + '">' + esc(s.text) + '</div>' +
        '</div></div>';
    }).join('') + '</div>';

    var cleanBlock = STATE.clean ?
      '<div class="clean-block" id="clean-block">' +
        '<div class="clean-head"><h4>📄 Transcrição limpa</h4>' +
          '<span class="cb-actions"><button class="btn-sm" id="btn-clean-copy">Copiar</button></span></div>' +
        '<div class="clean-text">' + STATE.clean.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('') + '</div>' +
      '</div>' : '';

    var disclaimer = '<p class="disclaimer">Transcrição automática por IA (Whisper) — revise nomes próprios, números e trechos com ruído antes de publicar. Clique em qualquer bloco para editar o texto; a edição vale para a exportação. As legendas são geradas na sua chave e não ficam armazenadas em nenhum servidor nosso.</p>';

    $('results').innerHTML = head + tabs + cues + cleanBlock + disclaimer;
    wireResults();
  }

  function wireResults() {
    var srt = $('btn-srt'); if (srt) srt.onclick = function () { exportFile('srt'); };
    var vtt = $('btn-vtt'); if (vtt) vtt.onclick = function () { exportFile('vtt'); };
    var txt = $('btn-txt'); if (txt) txt.onclick = function () { exportFile('txt'); };
    var cp = $('btn-copy'); if (cp) cp.onclick = exportCopy;
    var cc = $('btn-clean-copy'); if (cc) cc.onclick = function () {
      copyText(STATE.clean, function (ok) { toast(ok ? 'Transcrição copiada.' : 'Não foi possível copiar.', !ok); });
    };
    // track switch
    var results = $('results');
    results.querySelectorAll('.track-tab').forEach(function (tab) {
      tab.onclick = function () { STATE.active = tab.getAttribute('data-track'); renderResults(); };
    });
    // editable cues (update state, no re-render — keeps focus)
    results.querySelectorAll('.cue-text').forEach(function (el) {
      el.addEventListener('input', function () {
        var i = parseInt(el.getAttribute('data-i'), 10);
        var segs = activeSegs();
        if (segs[i]) segs[i].text = el.innerText.replace(/\s+\n/g, '\n').trim();
      });
    });
  }

  // ============================================================ export
  function baseName() {
    var fn = STATE.file ? STATE.file.name.replace(/\.[^.]+$/, '') : 'transcricao';
    var suffix = STATE.active === 'trans' ? '-' + slug(STATE.tracks.trans.langName) : '';
    return slug(fn) + suffix;
  }
  function exportFile(kind) {
    var segs = activeSegs(); if (!segs.length) return;
    var content, mime, ext;
    if (kind === 'srt') { content = buildSRT(segs); mime = 'application/x-subrip'; ext = 'srt'; }
    else if (kind === 'vtt') { content = buildVTT(segs); mime = 'text/vtt'; ext = 'vtt'; }
    else { content = buildTXT(segs); mime = 'text/plain'; ext = 'txt'; }
    downloadBlob(new Blob([content], { type: mime + ';charset=utf-8' }), baseName() + '.' + ext);
    toast('.' + ext.toUpperCase() + ' exportado.');
  }
  function exportCopy() {
    var segs = activeSegs(); if (!segs.length) return;
    copyText(buildSRT(segs), function (ok) { toast(ok ? 'Legendas (.SRT) copiadas.' : 'Não foi possível copiar.', !ok); });
  }

  // ============================================================ busy / key hints
  function setBusy(on, btnId) {
    busy = on;
    ['btn-transcribe', 'btn-translate', 'btn-clean'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = on;
    });
    var btn = $(btnId);
    if (btn) {
      var t = btn.querySelector('.btn-text'), l = btn.querySelector('.btn-loading');
      if (t && l) { t.style.display = on ? 'none' : ''; l.style.display = on ? 'inline' : 'none'; }
    }
    if (!on) { var bt = $('btn-translate'); if (bt && !bt.querySelector('.btn-text')) bt.textContent = 'Traduzir'; }
  }
  function flagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint warn'; h.textContent = 'Configure sua chave OpenAI no ícone de chave (topo direito) para transcrever.'; }
  }
  function unflagKey() {
    var h = $('gen-hint'); if (h) { h.className = 'gen-hint'; h.textContent = 'A transcrição roda na sua chave OpenAI (Whisper). O arquivo vai direto para a OpenAI — nunca passa pelos nossos servidores.'; }
  }

  // ============================================================ wiring / init
  var App = (function () {
    function wireDropzone() {
      var dz = $('dropzone'), input = $('file-input');
      dz.addEventListener('click', function (e) { if (e.target.closest('.dzf-remove')) return; if (!dz.classList.contains('has-file')) input.click(); });
      dz.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && !dz.classList.contains('has-file')) { e.preventDefault(); input.click(); } });
      input.addEventListener('change', function () { if (input.files && input.files[0]) onFile(input.files[0]); });
      ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); }); });
      dz.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onFile(f); });
      $('file-remove').addEventListener('click', function (e) { e.stopPropagation(); clearFile(); });
    }
    function init() {
      wireDropzone();
      $('btn-transcribe').onclick = transcribe;
      $('btn-translate').onclick = translate;
      $('btn-clean').onclick = cleanTranscript;
      // studio model picker (COR-041 — every model <select> must be rendered)
      if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
      if (ApiKeyManager.getKey('openai')) unflagKey(); else flagKey();
      document.addEventListener('click', function () { if (ApiKeyManager.getKey('openai')) unflagKey(); }, true);
    }
    return { init: init };
  })();

  var _init = false;
  function tryInit() {
    if (_init) return;
    var session = (typeof MembershipGate !== 'undefined') ? MembershipGate.getSession() : null;
    if (session) { _init = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryInit);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInit, 150); });

  window.TranscricaoApp = { transcribe: transcribe }; // debug hook
})();
