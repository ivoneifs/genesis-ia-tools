/**
 * Slides IA — Main Application Logic
 *
 * Turns a structured briefing into a REAL, navigable, exportable presentation
 * deck. The LLM (BYOK, routed via OpenRouter) returns a strict JSON deck; this
 * tool's OWN renderer produces a complete self-contained 16:9 slide deck
 * (cover + agenda + content slides with per-type layouts + CTA) with live
 * preview, keyboard navigation, 4 visual themes, and export to PDF (print) +
 * self-contained .html. It delivers the finished artifact, not an outline.
 *
 * Architecture (Hard Rules #1/#7/#13): BYOK only — the user's key stays in the
 * browser; no Supabase in the frontend; membership/feedback go through n8n.
 */

const App = (function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  const state = {
    goal: 'Webinar',
    count: '8',
    theme: 'spotlight',
    deck: null,        // parsed JSON deck
    html: '',          // rendered self-contained deck HTML
    index: 0,
    total: 0
  };

  const BRIEF_STORE = 'slides-ia_brief_v1';   // localStorage slot (COR-025: not "*KEY")

  /* ---------- small utilities ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // COR-015 — LLM JSON often returns the literal string "null"/"n/a"/"-" etc.
  function clean(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—|none|nenhum|nenhuma)$/i.test(s)) return '';
    return s;
  }
  function cleanArr(a) {
    if (!Array.isArray(a)) return [];
    return a.map(clean).filter(function (x) { return x.length; });
  }

  let toastTimer = null;
  function toast(msg, isError) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, isError ? 4200 : 2400);
  }

  /* ---------- chip groups ---------- */
  function wireChips(groupId, onPick) {
    const group = $(groupId);
    if (!group) return;
    group.addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      onPick(chip.getAttribute('data-value'));
    });
  }

  /* ---------- read inputs ---------- */
  function getInputs() {
    return {
      topic: ($('in-topic').value || '').trim(),
      audience: ($('in-audience').value || '').trim(),
      author: ($('in-author').value || '').trim(),
      goal: state.goal,
      count: parseInt(state.count, 10) || 8,
      tone: $('in-tone').value,
      theme: state.theme
    };
  }

  function saveBrief(inp) {
    try { localStorage.setItem(BRIEF_STORE, JSON.stringify(inp)); } catch (e) {}
  }
  function loadBrief() {
    try {
      const raw = localStorage.getItem(BRIEF_STORE);
      if (!raw) return;
      const b = JSON.parse(raw);
      if (b.topic) $('in-topic').value = b.topic;
      if (b.audience) $('in-audience').value = b.audience;
      if (b.author) $('in-author').value = b.author;
      if (b.tone) $('in-tone').value = b.tone;
    } catch (e) {}
  }

  /* ---------- prompt ---------- */
  function buildMessages(inp) {
    const sys = [
      'Você é um designer de apresentações e copywriter sênior. Cria pitch decks e',
      'apresentações de altíssima qualidade em português do Brasil. Você devolve SOMENTE',
      'um objeto JSON válido (sem markdown, sem comentários, sem texto fora do JSON).',
      'Use aspas tipográficas (“ ” ‘ ’) dentro dos textos para nunca quebrar o JSON.',
      '',
      'Formato EXATO do JSON:',
      '{',
      '  "title": "título principal do deck (curto e forte)",',
      '  "subtitle": "subtítulo de uma linha",',
      '  "author": "nome do apresentador ou marca",',
      '  "slides": [ ...objetos de slide... ]',
      '}',
      '',
      'Cada slide é um objeto com um "type". Tipos disponíveis e seus campos:',
      '- {"type":"cover","title":"...","subtitle":"..."}  // SEMPRE o primeiro slide',
      '- {"type":"agenda","title":"Agenda","items":["item 1","item 2", ...]}',
      '- {"type":"section","title":"Título da seção","subtitle":"opcional"}  // divisor de seção',
      '- {"type":"bullets","title":"...","subtitle":"opcional","bullets":["ponto 1","ponto 2","ponto 3"]}',
      '- {"type":"twocol","title":"...","left":{"heading":"...","items":["..."]},"right":{"heading":"...","items":["..."]}}',
      '- {"type":"quote","quote":"frase de impacto","attribution":"quem disse / fonte"}',
      '- {"type":"stat","stat":"73%","statLabel":"rótulo curto","statDesc":"frase explicando o número"}',
      '- {"type":"cta","title":"chamada para ação","subtitle":"reforço","bullets":["próximo passo 1","próximo passo 2"],"button":"texto do botão/CTA"}  // SEMPRE o último slide',
      '',
      'Regras de qualidade:',
      '- Os bullets devem ser frases completas, específicas e valiosas (não rótulos genéricos). 3 a 5 por slide.',
      '- Varie os tipos de slide para um deck dinâmico (não use só bullets). Inclua ao menos um "stat" e um "quote" quando fizer sentido.',
      '- Títulos curtos e fortes. Nada de "Slide 1", numeração ou meta-texto.',
      '- Conteúdo real e aplicável ao tema/público, pronto para apresentar.'
    ].join('\n');

    const user = [
      'Crie uma apresentação completa com EXATAMENTE ' + inp.count + ' slides (incluindo capa e CTA final).',
      'Tema: ' + (inp.topic || '(defina um tema relevante)'),
      'Público-alvo: ' + (inp.audience || 'público geral interessado no tema'),
      'Objetivo do deck: ' + inp.goal,
      'Tom: ' + inp.tone,
      inp.author ? ('Apresentador/marca: ' + inp.author) : 'Apresentador/marca: (use um placeholder elegante)',
      '',
      'Devolva SOMENTE o objeto JSON no formato especificado.'
    ].join('\n');

    return [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];
  }

  /* ---------- JSON parsing (repair ladder, COR-015/032) ---------- */
  function stripToObject(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const i = t.indexOf('{'); const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    return t;
  }
  function repairJson(text) {
    // State machine: escape stray double-quotes inside string values + raw control chars.
    let s = stripToObject(text);
    let out = ''; let inStr = false; let esc2 = false;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (esc2) { out += c; esc2 = false; continue; }
      if (c === '\\') { out += c; esc2 = true; continue; }
      if (inStr) {
        if (c === '"') {
          // look ahead: is this a real closing quote? (next non-space is , } ] :)
          let n = k + 1; while (n < s.length && /\s/.test(s[n])) n++;
          const nc = s[n];
          if (nc === ',' || nc === '}' || nc === ']' || nc === ':' || n >= s.length) { inStr = false; out += c; }
          else { out += '\\"'; }   // stray quote inside the string
        } else if (c === '\n' || c === '\r' || c === '\t') {
          out += (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t');
        } else { out += c; }
      } else {
        if (c === '"') { inStr = true; out += c; }
        else { out += c; }
      }
    }
    return out;
  }
  function parseJSON(text) {
    const attempts = [];
    attempts.push(function () { return JSON.parse(stripToObject(text)); });
    attempts.push(function () { return JSON.parse(stripToObject(text).replace(/,(\s*[}\]])/g, '$1')); }); // trailing commas
    attempts.push(function () { return JSON.parse(repairJson(text)); });
    attempts.push(function () { return JSON.parse(repairJson(text).replace(/,(\s*[}\]])/g, '$1')); });
    for (let i = 0; i < attempts.length; i++) {
      try { const r = attempts[i](); if (r && typeof r === 'object') return r; } catch (e) {}
    }
    return null;
  }

  /* ---------- LLM call (auto-reroll on parse failure, COR-032) ---------- */
  function endpointFor(service) {
    return service === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
  }
  function modelIdFor(service, modelId) {
    if (service === 'openai') {
      // native OpenAI API expects un-prefixed ids; only openai/* models work.
      if (modelId.indexOf('openai/') === 0) return modelId.slice('openai/'.length);
      return 'gpt-5.5'; // fallback when the user only has an OpenAI key
    }
    return modelId; // OpenRouter uses provider-prefixed ids
  }

  async function rawCall(messages, opts) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + opts.key
    };
    if (opts.service === 'openrouter') {
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Slides IA - Gênesis IA';
    }
    const body = {
      model: modelIdFor(opts.service, opts.model),
      messages: messages,
      temperature: opts.temperature == null ? 0.7 : opts.temperature,
      max_tokens: 8000
    };
    const res = await fetch(endpointFor(opts.service), {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
      const err = new Error(detail || ('Erro HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return content || '';
  }

  async function callLLM(messages, opts) {
    // attempt 1
    let text = await rawCall(messages, opts);
    let parsed = parseJSON(text);
    if (parsed) return parsed;
    // COR-032 — auto-reroll ONCE, stricter + lower temperature
    const reroll = messages.concat([
      { role: 'assistant', content: text.slice(0, 4000) },
      { role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda NOVAMENTE com APENAS o objeto JSON no formato pedido, usando aspas tipográficas dentro dos textos, sem markdown e sem nenhum texto fora do JSON.' }
    ]);
    text = await rawCall(reroll, Object.assign({}, opts, { temperature: 0.4 }));
    parsed = parseJSON(text);
    return parsed; // may be null → caller surfaces the friendly error
  }

  /* ---------- normalize parsed deck ---------- */
  function normalizeDeck(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const slides = Array.isArray(raw.slides) ? raw.slides : [];
    const out = {
      title: clean(raw.title) || 'Apresentação',
      subtitle: clean(raw.subtitle),
      author: clean(raw.author),
      slides: []
    };
    slides.forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      const t = (clean(s.type) || 'bullets').toLowerCase();
      const slide = { type: t };
      slide.title = clean(s.title);
      slide.subtitle = clean(s.subtitle);
      slide.bullets = cleanArr(s.bullets);
      slide.items = cleanArr(s.items);
      slide.quote = clean(s.quote);
      slide.attribution = clean(s.attribution);
      slide.stat = clean(s.stat);
      slide.statLabel = clean(s.statLabel);
      slide.statDesc = clean(s.statDesc);
      slide.button = clean(s.button);
      if (s.left && typeof s.left === 'object') slide.left = { heading: clean(s.left.heading), items: cleanArr(s.left.items) };
      if (s.right && typeof s.right === 'object') slide.right = { heading: clean(s.right.heading), items: cleanArr(s.right.items) };
      out.slides.push(slide);
    });
    if (!out.slides.length) return null;
    return out;
  }

  /* ---------- deck themes (embedded in the exported HTML) ---------- */
  const THEME_CSS = {
    spotlight: ':root{--s-bg:#0c0c11;--s-bg2:#16121b;--s-text:#f3f0e9;--s-muted:#b5b0a6;--s-accent:#f5b740;--s-accent2:#ffd479;--s-line:rgba(245,183,64,.28);--s-cover:radial-gradient(120% 90% at 50% -10%, rgba(245,183,64,.22), transparent 55%), linear-gradient(180deg,#16121b,#0a0a0d);}',
    minimal: ':root{--s-bg:#ffffff;--s-bg2:#f6f5f2;--s-text:#16161a;--s-muted:#5a5a63;--s-accent:#ff5a3c;--s-accent2:#ff8466;--s-line:rgba(0,0,0,.12);--s-cover:linear-gradient(180deg,#fbfbfa,#f1f0ec);}',
    executive: ':root{--s-bg:#fbf9f4;--s-bg2:#f1ece0;--s-text:#10233f;--s-muted:#4a5a72;--s-accent:#b8902f;--s-accent2:#d8b85a;--s-line:rgba(16,35,63,.16);--s-cover:linear-gradient(160deg,#fbf9f4,#efe7d6);}',
    vibrant: ':root{--s-bg:#160d28;--s-bg2:#231043;--s-text:#f7f2ff;--s-muted:#c4b3e0;--s-accent:#ff4d8d;--s-accent2:#ffb347;--s-line:rgba(255,77,141,.32);--s-cover:linear-gradient(135deg,#ff4d8d22,transparent), radial-gradient(120% 90% at 80% -10%, #ffb34733, transparent 55%), linear-gradient(180deg,#231043,#120920);}'
  };

  /* ---------- render a single slide → HTML ---------- */
  function slideHTML(s, idx, total) {
    const foot = '<div class="s-foot"><span class="s-foot-mark"></span><span>' + esc(DECK_FOOT) + '</span><span class="s-num">' + (idx + 1) + ' / ' + total + '</span></div>';
    function list(items) {
      return '<ul class="s-list">' + items.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>';
    }
    let inner = '';
    switch (s.type) {
      case 'cover':
        return '<section class="slide slide-cover"><div class="s-cover-wrap">' +
          (s.subtitle ? '' : '') +
          '<div class="s-kicker">' + esc(DECK_KICKER) + '</div>' +
          '<h1 class="s-cover-title">' + esc(s.title || DECK_TITLE) + '</h1>' +
          (s.subtitle ? '<p class="s-cover-sub">' + esc(s.subtitle) + '</p>' : '') +
          (DECK_AUTHOR ? '<div class="s-author">' + esc(DECK_AUTHOR) + '</div>' : '') +
          '</div></section>';
      case 'section':
        return '<section class="slide slide-section"><div class="s-sec-rule"></div>' +
          '<h2 class="s-sec-title">' + esc(s.title) + '</h2>' +
          (s.subtitle ? '<p class="s-sec-sub">' + esc(s.subtitle) + '</p>' : '') + foot + '</section>';
      case 'agenda':
        inner = '<h2 class="s-title">' + esc(s.title || 'Agenda') + '</h2>' +
          '<ol class="s-agenda">' + s.items.map(function (it, i) {
            return '<li><span class="s-agenda-n">' + String(i + 1).padStart(2, '0') + '</span><span>' + esc(it) + '</span></li>';
          }).join('') + '</ol>';
        return '<section class="slide slide-body">' + inner + foot + '</section>';
      case 'twocol': {
        const L = s.left || { heading: '', items: [] };
        const R = s.right || { heading: '', items: [] };
        inner = '<h2 class="s-title">' + esc(s.title) + '</h2>' +
          '<div class="s-cols">' +
          '<div class="s-col"><h3 class="s-colhead">' + esc(L.heading) + '</h3>' + list(L.items) + '</div>' +
          '<div class="s-col"><h3 class="s-colhead">' + esc(R.heading) + '</h3>' + list(R.items) + '</div>' +
          '</div>';
        return '<section class="slide slide-body">' + inner + foot + '</section>';
      }
      case 'quote':
        return '<section class="slide slide-quote">' +
          '<div class="s-quote-mark">“</div>' +
          '<blockquote class="s-quote">' + esc(s.quote) + '</blockquote>' +
          (s.attribution ? '<cite class="s-cite">— ' + esc(s.attribution) + '</cite>' : '') + foot + '</section>';
      case 'stat':
        return '<section class="slide slide-stat">' +
          '<div class="s-stat-num">' + esc(s.stat) + '</div>' +
          (s.statLabel ? '<div class="s-stat-label">' + esc(s.statLabel) + '</div>' : '') +
          (s.statDesc ? '<p class="s-stat-desc">' + esc(s.statDesc) + '</p>' : '') + foot + '</section>';
      case 'cta':
        inner = '<div class="s-cta-kicker">' + esc(DECK_KICKER) + '</div>' +
          '<h2 class="s-cta-title">' + esc(s.title || 'Vamos começar') + '</h2>' +
          (s.subtitle ? '<p class="s-cta-sub">' + esc(s.subtitle) + '</p>' : '') +
          (s.bullets.length ? list(s.bullets) : '') +
          (s.button ? '<div class="s-cta-btn">' + esc(s.button) + '</div>' : '');
        return '<section class="slide slide-cta">' + inner + '</section>';
      case 'bullets':
      default:
        inner = '<h2 class="s-title">' + esc(s.title) + '</h2>' +
          (s.subtitle ? '<p class="s-sub">' + esc(s.subtitle) + '</p>' : '') +
          (s.bullets.length ? list(s.bullets) : (s.items.length ? list(s.items) : ''));
        return '<section class="slide slide-body">' + inner + foot + '</section>';
    }
  }

  // module-scope deck meta used by slideHTML (set in renderDeck)
  let DECK_TITLE = '', DECK_KICKER = '', DECK_AUTHOR = '', DECK_FOOT = '';

  function renderDeck(deck, theme) {
    DECK_TITLE = deck.title;
    DECK_AUTHOR = deck.author;
    DECK_KICKER = (deck.subtitle || 'Apresentação').toUpperCase();
    DECK_FOOT = deck.title;
    const total = deck.slides.length;
    const slidesHTML = deck.slides.map(function (s, i) { return slideHTML(s, i, total); }).join('\n');
    const themeCss = THEME_CSS[theme] || THEME_CSS.spotlight;

    const deckScript =
      '(function(){var sl=[].slice.call(document.querySelectorAll(".slide"));var i=0;' +
      'function show(n){i=Math.max(0,Math.min(sl.length-1,n));sl.forEach(function(s,k){s.classList.toggle("on",k===i);});' +
      'try{parent.postMessage({__deck:1,type:"state",index:i,total:sl.length},"*");}catch(e){}}' +
      'window.addEventListener("message",function(e){var d=e.data||{};if(!d.__deck)return;' +
      'if(d.type==="nav")show(i+(d.dir==="next"?1:-1));else if(d.type==="goto")show(d.i|0);else if(d.type==="ask")show(i);});' +
      'document.addEventListener("keydown",function(e){if(e.key==="ArrowRight"||e.key===" "||e.key==="PageDown"){show(i+1);e.preventDefault();}' +
      'else if(e.key==="ArrowLeft"||e.key==="PageUp"){show(i-1);e.preventDefault();}});' +
      'show(0);})();';

    return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>' + esc(deck.title) + '</title><style>' +
      themeCss +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'html,body{width:100%;height:100%;background:var(--s-bg);font-family:"Helvetica Neue",Arial,system-ui,sans-serif;color:var(--s-text);}' +
      '.slide{display:none;width:100vw;height:100vh;padding:7vh 8vw;flex-direction:column;justify-content:center;position:relative;overflow:hidden;background:var(--s-bg);}' +
      '.slide.on{display:flex;}' +
      '.s-foot{position:absolute;left:8vw;right:8vw;bottom:4vh;display:flex;align-items:center;gap:1.4vw;font-size:1.5vh;color:var(--s-muted);letter-spacing:.04em;}' +
      '.s-foot-mark{width:1.3vh;height:1.3vh;border-radius:50%;background:var(--s-accent);box-shadow:0 0 1.4vh var(--s-accent);flex:none;}' +
      '.s-num{margin-left:auto;font-variant-numeric:tabular-nums;}' +
      '.s-kicker,.s-cta-kicker{font-size:1.7vh;letter-spacing:.32em;text-transform:uppercase;color:var(--s-accent);font-weight:700;margin-bottom:3vh;}' +
      '.s-title{font-size:5.4vh;font-weight:800;letter-spacing:-.02em;line-height:1.04;margin-bottom:2.4vh;max-width:84%;}' +
      '.s-sub{font-size:2.7vh;color:var(--s-muted);margin-bottom:3.4vh;max-width:80%;line-height:1.4;}' +
      '.s-list{list-style:none;display:flex;flex-direction:column;gap:2.2vh;max-width:88%;}' +
      '.s-list li{position:relative;padding-left:4vh;font-size:2.7vh;line-height:1.4;}' +
      '.s-list li::before{content:"";position:absolute;left:0;top:1.1vh;width:1.7vh;height:1.7vh;border-radius:4px;background:var(--s-accent);box-shadow:0 0 1.6vh -.2vh var(--s-accent);}' +
      // cover
      '.slide-cover{background:var(--s-cover);justify-content:center;}' +
      '.s-cover-title{font-size:8.4vh;font-weight:900;letter-spacing:-.03em;line-height:.98;max-width:92%;}' +
      '.s-cover-sub{font-size:3vh;color:var(--s-muted);margin-top:3vh;max-width:80%;line-height:1.4;}' +
      '.s-author{margin-top:5vh;font-size:2.1vh;color:var(--s-accent);letter-spacing:.04em;font-weight:600;}' +
      // section divider
      '.slide-section{justify-content:center;background:var(--s-bg2);}' +
      '.s-sec-rule{width:8vh;height:.7vh;border-radius:2px;background:var(--s-accent);margin-bottom:3vh;}' +
      '.s-sec-title{font-size:7vh;font-weight:900;letter-spacing:-.02em;line-height:1.02;max-width:86%;}' +
      '.s-sec-sub{font-size:2.7vh;color:var(--s-muted);margin-top:2vh;max-width:74%;}' +
      // agenda
      '.s-agenda{list-style:none;display:flex;flex-direction:column;gap:2vh;max-width:82%;}' +
      '.s-agenda li{display:flex;align-items:baseline;gap:2.4vw;font-size:3vh;border-bottom:1px solid var(--s-line);padding-bottom:1.8vh;}' +
      '.s-agenda-n{font-size:2vh;font-weight:800;color:var(--s-accent);font-variant-numeric:tabular-nums;}' +
      // two columns
      '.s-cols{display:grid;grid-template-columns:1fr 1fr;gap:5vw;}' +
      '.s-colhead{font-size:2.4vh;font-weight:800;color:var(--s-accent);margin-bottom:2.2vh;letter-spacing:-.01em;}' +
      '.s-cols .s-list li{font-size:2.4vh;}' +
      // quote
      '.slide-quote{justify-content:center;background:var(--s-bg2);}' +
      '.s-quote-mark{font-size:16vh;line-height:.6;color:var(--s-accent);opacity:.5;font-family:Georgia,serif;height:9vh;}' +
      '.s-quote{font-size:5vh;font-weight:700;line-height:1.22;letter-spacing:-.01em;max-width:88%;}' +
      '.s-cite{display:block;margin-top:4vh;font-size:2.4vh;color:var(--s-accent);font-style:normal;font-weight:600;}' +
      // stat
      '.slide-stat{justify-content:center;align-items:flex-start;background:var(--s-bg2);}' +
      '.s-stat-num{font-size:18vh;font-weight:900;line-height:.9;letter-spacing:-.04em;color:var(--s-accent);}' +
      '.s-stat-label{font-size:3.4vh;font-weight:800;margin-top:1.5vh;}' +
      '.s-stat-desc{font-size:2.7vh;color:var(--s-muted);margin-top:2vh;max-width:74%;line-height:1.4;}' +
      // cta
      '.slide-cta{justify-content:center;background:var(--s-cover);}' +
      '.s-cta-title{font-size:6.6vh;font-weight:900;letter-spacing:-.02em;line-height:1.02;max-width:86%;}' +
      '.s-cta-sub{font-size:2.9vh;color:var(--s-muted);margin:2.4vh 0 3.4vh;max-width:74%;line-height:1.4;}' +
      '.slide-cta .s-list{margin-bottom:4vh;}' +
      '.s-cta-btn{display:inline-block;align-self:flex-start;background:var(--s-accent);color:#1a1205;font-weight:800;font-size:2.5vh;padding:1.8vh 4vh;border-radius:1.2vh;box-shadow:0 1.4vh 3vh -1vh var(--s-accent);}' +
      // print: one slide per page
      '@page{size:1280px 720px;margin:0;}' +
      '@media print{html,body{width:1280px;}.slide{display:flex!important;width:1280px;height:720px;page-break-after:always;break-after:page;}.slide:last-child{page-break-after:auto;}}' +
      '</style></head><body>' + slidesHTML +
      '<script>' + deckScript + '<\/script></body></html>';
  }

  /* ---------- preview + navigation ---------- */
  function showPreview(html) {
    const frame = $('deck-frame');
    $('deck-empty').style.display = 'none';
    $('deck-loading').style.display = 'none';
    frame.style.display = 'block';
    frame.srcdoc = html;
    $('deck-controls').style.display = 'flex';
    $('export-bar').style.display = 'flex';
  }

  function navTo(dir) {
    const frame = $('deck-frame');
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ __deck: 1, type: 'nav', dir: dir }, '*');
  }

  function wirePreviewMessaging() {
    window.addEventListener('message', function (e) {
      const d = e.data || {};
      if (!d.__deck || d.type !== 'state') return;
      state.index = d.index; state.total = d.total;
      $('cur-slide').textContent = (d.index + 1);
      $('total-slides').textContent = d.total;
      $('prev-slide').disabled = d.index <= 0;
      $('next-slide').disabled = d.index >= d.total - 1;
    });
  }

  /* ---------- outline (Estrutura) ---------- */
  const TYPE_LABEL = { cover: 'Capa', agenda: 'Agenda', section: 'Seção', bullets: 'Tópicos', twocol: 'Duas colunas', quote: 'Citação', stat: 'Estatística', cta: 'Chamada (CTA)' };
  function renderOutline(deck) {
    const html = deck.slides.map(function (s, i) {
      let title = s.title || s.quote || s.stat || (s.type === 'cover' ? deck.title : '') || TYPE_LABEL[s.type] || 'Slide';
      let desc = '';
      if (s.bullets && s.bullets.length) desc = s.bullets.length + ' tópicos';
      else if (s.items && s.items.length) desc = s.items.length + ' itens';
      else if (s.type === 'twocol') desc = 'Duas colunas';
      else if (s.statDesc) desc = s.statDesc;
      else if (s.subtitle) desc = s.subtitle;
      return '<div class="outline-item"><div class="outline-num">' + String(i + 1).padStart(2, '0') + '</div>' +
        '<div class="outline-body"><div class="otype">' + esc(TYPE_LABEL[s.type] || s.type) + '</div>' +
        '<h4>' + esc(title) + '</h4>' + (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div></div>';
    }).join('');
    $('outline-list').innerHTML = html;
  }

  /* ---------- tabs ---------- */
  function wireTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        const name = tab.getAttribute('data-tab');
        ['preview', 'outline', 'html'].forEach(function (n) {
          $('panel-' + n).style.display = (n === name) ? 'block' : 'none';
        });
      });
    });
  }

  /* ---------- export ---------- */
  function exportPDF() {
    const frame = $('deck-frame');
    if (!frame || !state.html) return;
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch (e) { toast('Não foi possível abrir a impressão.', true); }
  }
  /* ---------- export → real .pptx (PptxGenJS, self-hosted, client-side) ---------- */
  // Theme → PPTX colors (hex without '#'). Mirrors the 4 THEME_CSS decks.
  const PPTX_THEME = {
    spotlight: { bg: '0C0C11', panel: '16121B', text: 'F3F0E9', muted: 'B5B0A6', accent: 'F5B740' },
    minimal:   { bg: 'FFFFFF', panel: 'F6F5F2', text: '16161A', muted: '5A5A63', accent: 'FF5A3C' },
    executive: { bg: 'FBF9F4', panel: 'F1ECE0', text: '10233F', muted: '4A5A72', accent: 'B8902F' },
    vibrant:   { bg: '160D28', panel: '231043', text: 'F7F2FF', muted: 'C4B3E0', accent: 'FF4D8D' }
  };

  function slug50(s, fallback) {
    return (clean(s) || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || (fallback || 'apresentacao');
  }

  function exportPPTX() {
    if (!state.deck || !state.deck.slides || !state.deck.slides.length) { toast('Gere uma apresentação primeiro.', true); return; }
    if (typeof window.PptxGenJS === 'undefined') { toast('Motor de PPTX indisponível. Recarregue a página.', true); return; }
    const deck = state.deck;
    const T = PPTX_THEME[state.theme] || PPTX_THEME.spotlight;
    const btn = $('export-pptx');
    if (btn) { btn.disabled = true; btn.dataset.lbl = btn.textContent; btn.textContent = 'Gerando PPTX…'; }

    try {
      const pptx = new window.PptxGenJS();
      pptx.defineLayout({ name: 'MAESTRO_WIDE', width: 13.333, height: 7.5 });
      pptx.layout = 'MAESTRO_WIDE';
      pptx.author = 'Gênesis IA';
      pptx.company = 'Gênesis IA';
      pptx.title = deck.title || 'Apresentação';

      const W = 13.333, H = 7.5, MX = 0.85, CW = W - MX * 2;
      const kicker = (deck.subtitle || 'Apresentação').toUpperCase();
      const foot = deck.title || '';

      function footer(slide, idx, total) {
        slide.addShape(pptx.ShapeType.ellipse, { x: MX, y: H - 0.62, w: 0.12, h: 0.12, fill: { color: T.accent } });
        slide.addText(foot, { x: MX + 0.22, y: H - 0.72, w: CW - 2, h: 0.3, fontSize: 9, color: T.muted, align: 'left', valign: 'middle' });
        slide.addText((idx + 1) + ' / ' + total, { x: W - MX - 1.5, y: H - 0.72, w: 1.5, h: 0.3, fontSize: 9, color: T.muted, align: 'right', valign: 'middle' });
      }
      function bulletsToObjs(arr) {
        return arr.map(function (b) { return { text: b, options: { bullet: { indent: 18 }, color: T.text, fontSize: 16, paraSpaceAfter: 10 } }; });
      }

      const total = deck.slides.length;
      deck.slides.forEach(function (s, idx) {
        const slide = pptx.addSlide();
        const isCover = s.type === 'cover';
        const isSection = s.type === 'section';
        slide.background = { color: (isSection ? T.panel : T.bg) };

        if (isCover) {
          slide.addText(kicker, { x: MX, y: 2.0, w: CW, h: 0.5, fontSize: 14, color: T.accent, bold: true, charSpacing: 3, align: 'left' });
          slide.addText(s.title || deck.title || 'Apresentação', { x: MX, y: 2.5, w: CW, h: 2.2, fontSize: 44, bold: true, color: T.text, align: 'left', valign: 'top' });
          if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 4.7, w: CW - 1, h: 1, fontSize: 20, color: T.muted, align: 'left' });
          if (deck.author) slide.addText(deck.author, { x: MX, y: H - 1.4, w: CW, h: 0.4, fontSize: 14, color: T.accent, bold: true, align: 'left' });
          return;
        }
        if (isSection) {
          slide.addShape(pptx.ShapeType.rect, { x: MX, y: 2.7, w: 1.1, h: 0.14, fill: { color: T.accent } });
          slide.addText(s.title || '', { x: MX, y: 3.0, w: CW, h: 1.8, fontSize: 40, bold: true, color: T.text, align: 'left', valign: 'top' });
          if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 4.7, w: CW - 1, h: 1, fontSize: 18, color: T.muted, align: 'left' });
          footer(slide, idx, total);
          return;
        }

        // Body slides share a title band
        const title = s.title || s.quote || (s.stat ? s.stat : '') || TYPE_LABEL[s.type] || 'Slide';
        let bodyY = 1.9;
        if (s.type !== 'quote' && s.type !== 'stat') {
          slide.addText(title, { x: MX, y: 0.7, w: CW, h: 1.0, fontSize: 30, bold: true, color: T.text, align: 'left', valign: 'top' });
          if (s.subtitle) { slide.addText(s.subtitle, { x: MX, y: 1.65, w: CW - 1, h: 0.6, fontSize: 16, color: T.muted, align: 'left' }); bodyY = 2.5; }
        }

        if (s.type === 'agenda' && s.items && s.items.length) {
          const rows = s.items.map(function (it, i) { return { text: (String(i + 1).padStart(2, '0') + '   ' + it), options: { color: T.text, fontSize: 18, paraSpaceAfter: 12 } }; });
          slide.addText(rows, { x: MX, y: bodyY, w: CW - 0.5, h: H - bodyY - 1, align: 'left', valign: 'top' });
        } else if (s.type === 'twocol' && (s.left || s.right)) {
          const L = s.left || { heading: '', items: [] }, R = s.right || { heading: '', items: [] };
          const colW = (CW - 0.6) / 2;
          if (L.heading) slide.addText(L.heading, { x: MX, y: bodyY, w: colW, h: 0.5, fontSize: 18, bold: true, color: T.accent });
          slide.addText(bulletsToObjs(L.items || []), { x: MX, y: bodyY + 0.55, w: colW, h: H - bodyY - 1.5, align: 'left', valign: 'top' });
          if (R.heading) slide.addText(R.heading, { x: MX + colW + 0.6, y: bodyY, w: colW, h: 0.5, fontSize: 18, bold: true, color: T.accent });
          slide.addText(bulletsToObjs(R.items || []), { x: MX + colW + 0.6, y: bodyY + 0.55, w: colW, h: H - bodyY - 1.5, align: 'left', valign: 'top' });
        } else if (s.type === 'stat') {
          slide.addText(s.stat || '', { x: MX, y: 1.9, w: CW, h: 2.4, fontSize: 96, bold: true, color: T.accent, align: 'left', valign: 'middle' });
          if (s.statLabel) slide.addText(s.statLabel, { x: MX, y: 4.4, w: CW, h: 0.7, fontSize: 24, bold: true, color: T.text, align: 'left' });
          if (s.statDesc) slide.addText(s.statDesc, { x: MX, y: 5.1, w: CW - 1, h: 1, fontSize: 16, color: T.muted, align: 'left' });
        } else if (s.type === 'quote') {
          slide.addText('“' + (s.quote || '') + '”', { x: MX, y: 1.6, w: CW, h: 3.6, fontSize: 34, italic: true, bold: true, color: T.text, align: 'left', valign: 'middle' });
          if (s.attribution) slide.addText('— ' + s.attribution, { x: MX, y: 5.3, w: CW, h: 0.6, fontSize: 18, color: T.accent, align: 'left' });
        } else if (s.type === 'cta') {
          slide.addText(kicker, { x: MX, y: 1.4, w: CW, h: 0.4, fontSize: 13, color: T.accent, bold: true, charSpacing: 3 });
          slide.addText(title, { x: MX, y: 1.85, w: CW, h: 1.4, fontSize: 34, bold: true, color: T.text, align: 'left', valign: 'top' });
          if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 3.2, w: CW - 1, h: 0.8, fontSize: 18, color: T.muted });
          if (s.bullets && s.bullets.length) slide.addText(bulletsToObjs(s.bullets), { x: MX, y: 4.0, w: CW - 1, h: 1.8, align: 'left', valign: 'top' });
          if (s.button) slide.addText(s.button, { x: MX, y: H - 1.5, w: 4.2, h: 0.7, fontSize: 16, bold: true, color: T.bg, fill: { color: T.accent }, align: 'center', valign: 'middle', rectRadius: 0.08, shape: pptx.ShapeType.roundRect });
        } else {
          // bullets (default)
          const items = (s.bullets && s.bullets.length) ? s.bullets : (s.items || []);
          slide.addText(bulletsToObjs(items), { x: MX, y: bodyY, w: CW - 0.5, h: H - bodyY - 1, align: 'left', valign: 'top' });
        }
        footer(slide, idx, total);
      });

      const fname = 'slides-ia-' + slug50(deck.title, 'apresentacao') + '.pptx';
      pptx.writeFile({ fileName: fname }).then(function () {
        toast('PPTX baixado — ' + total + ' slides.');
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.lbl || 'Baixar PPTX'; }
      }).catch(function (err) {
        toast('Não foi possível gerar o PPTX.', true);
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.lbl || 'Baixar PPTX'; }
      });
    } catch (err) {
      toast('Não foi possível gerar o PPTX.', true);
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.lbl || 'Baixar PPTX'; }
    }
  }

  function downloadHTML() {
    if (!state.html) return;
    const blob = new Blob([state.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = (state.deck && state.deck.title ? state.deck.title : 'apresentacao')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'apresentacao';
    a.href = url; a.download = 'slides-ia-' + slug + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('HTML baixado.');
  }
  function copyHTML() {
    if (!state.html) return;
    navigator.clipboard.writeText(state.html)
      .then(function () { toast('HTML copiado.'); })
      .catch(function () { toast('Não foi possível copiar.', true); });
  }
  function openFullscreen() {
    if (!state.html) return;
    const w = window.open('', '_blank');
    if (!w) { toast('Permita pop-ups para abrir em tela cheia.', true); return; }
    w.document.open(); w.document.write(state.html); w.document.close();
  }

  /* ---------- generate ---------- */
  let generating = false;
  async function generate(e) {
    if (e) e.preventDefault();
    if (generating) return;

    const inp = getInputs();
    if (!inp.topic) { toast('Descreva o tema da apresentação.', true); $('in-topic').focus(); return; }

    const active = window.ApiKeyManager.getActiveKey();
    if (!active) { toast('Configure sua chave de API primeiro.', true); window.MembershipGate.showScreen('key-screen'); return; }

    const model = window.ApiKeyManager.getModel();
    saveBrief(inp);
    generating = true;
    const btn = $('generate-btn');
    btn.disabled = true; btn.textContent = 'Gerando…';

    // switch to preview tab + loading state
    document.querySelector('.tab[data-tab="preview"]').click();
    $('deck-frame').style.display = 'none';
    $('deck-empty').style.display = 'none';
    $('deck-controls').style.display = 'none';
    $('export-bar').style.display = 'none';
    $('deck-loading').style.display = 'flex';
    $('loading-text').textContent = 'Montando ' + inp.count + ' slides com ' + (active.service === 'openai' ? 'OpenAI' : 'OpenRouter') + '…';

    try {
      const messages = buildMessages(inp);
      const parsed = await window.RateLimiter.executeWithLimit('generate-deck', function () {
        return callLLM(messages, { key: active.key, service: active.service, model: model });
      });
      if (!parsed) throw new Error('PARSE');

      const deck = normalizeDeck(parsed);
      if (!deck) throw new Error('PARSE');

      state.deck = deck;
      state.theme = inp.theme;
      state.html = renderDeck(deck, inp.theme);
      renderOutline(deck);
      $('html-code').textContent = state.html;
      showPreview(state.html);
      toast('Apresentação pronta — ' + deck.slides.length + ' slides.');
    } catch (err) {
      $('deck-loading').style.display = 'none';
      if (!state.html) $('deck-empty').style.display = 'flex';
      let msg = 'Não foi possível gerar a apresentação.';
      if (err && err.message === 'PARSE') msg = 'O modelo não devolveu um JSON válido. Tente gerar novamente.';
      else if (err && err.status === 401) msg = 'Chave de API inválida ou sem permissão. Verifique sua chave.';
      else if (err && err.status === 402) msg = 'Sua conta no provedor está sem créditos.';
      else if (err && err.status === 429) msg = 'Muitas requisições. Aguarde alguns segundos e tente novamente.';
      else if (err && err.message && err.message !== 'PARSE') msg = err.message;
      toast(msg, true);
    } finally {
      generating = false;
      btn.disabled = false; btn.textContent = 'Gerar apresentação';
    }
  }

  /* ---------- init ---------- */
  function init() {
    const session = window.MembershipGate.getSession();
    if (session) {
      const nameEl = $('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }

    if (window.ApiKeyManager && window.ApiKeyManager.renderModelPicker) {
      window.ApiKeyManager.renderModelPicker('model-select');
    }

    wireChips('chips-goal', function (v) { state.goal = v; });
    wireChips('chips-count', function (v) { state.count = v; });
    wireChips('chips-theme', function (v) {
      state.theme = v;
      // live re-render if a deck already exists
      if (state.deck) {
        state.html = renderDeck(state.deck, v);
        $('html-code').textContent = state.html;
        showPreview(state.html);
      }
    });

    wireTabs();
    wirePreviewMessaging();
    loadBrief();

    $('deck-form').addEventListener('submit', generate);
    $('prev-slide').addEventListener('click', function () { navTo('prev'); });
    $('next-slide').addEventListener('click', function () { navTo('next'); });
    $('export-pptx').addEventListener('click', exportPPTX);
    $('export-pdf').addEventListener('click', exportPDF);
    $('export-html').addEventListener('click', downloadHTML);
    $('open-fullscreen').addEventListener('click', openFullscreen);
    $('copy-html').addEventListener('click', copyHTML);
  }

  return { init: init };
})();

(function () {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    if (window.MembershipGate && window.MembershipGate.getSession()) {
      _appInitialized = true;
      App.init();
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(tryAppInit, 150); });
})();
