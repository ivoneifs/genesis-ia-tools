/**
 * Calendário de Conteúdo IA — Main Application Logic
 *
 * Flow: member fills the briefing → the client builds the REAL posting dates for
 * the chosen month from the chosen frequency (deterministic scheduling) → the LLM
 * (BYOK, OpenRouter/OpenAI) returns EXACTLY one structured post per scheduled date
 * → this tool renders a real monthly planner GRID + a table, and EXPORTS two
 * importable files: a .csv (Google Sheets / Notion / Excel) and a .ics (each post
 * becomes a calendar event with a reminder in Google/Apple Calendar). The member
 * can regenerate any single day. The deliverable is the ready-to-use calendar, not
 * a text list describing one.
 *
 * BYOK: keys live in localStorage only (api-key-manager.js). No key leaves the
 * browser except directly to the chosen provider. No company key (Hard Rule #1).
 */

const App = (function() {
  // ---------- constants ----------
  const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const WD_SHORT = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const WD_LONG = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  // Warm-organic pillar palette (earthy, distinct, accessible on cream)
  const PILLAR_COLORS = ['#c1654a', '#6f8a6a', '#b08d3e', '#5b7a99', '#9c5a86', '#7a8a3e', '#bf7b3a', '#4f8a86'];

  let state = {
    platforms: ['Instagram'],
    goal: 'Crescer audiência e alcance',
    freq: '5',
    weekdays: [1, 3, 5],
    tone: 'Próximo e amigável',
    monthIndex: 0,   // 0-11
    year: 2026,
    schedule: [],    // array of Date
    pillars: [],     // [{name,color}]
    posts: [],       // normalized posts zipped with dates
    tab: 'grade'
  };

  // ---------- helpers ----------
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
    const s = String(v).trim();
    if (/^(null|undefined|n\/?a|none|nenhum[ao]?|-|—)$/i.test(s)) return '';
    return s;
  }
  function toast(msg, isErr) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(function() { t.className = 'toast' + (isErr ? ' err' : ''); }, 3600);
  }
  function slugify(s, fallback) {
    const out = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    return out || fallback || 'calendario';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dateBR(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }

  // ---------- schedule (deterministic real dates) ----------
  function weekdaySet() {
    if (state.freq === '3') return [1, 3, 5];
    if (state.freq === '5') return [1, 2, 3, 4, 5];
    if (state.freq === '7') return [0, 1, 2, 3, 4, 5, 6];
    return state.weekdays.slice(); // custom
  }
  function buildSchedule() {
    const set = weekdaySet();
    const dates = [];
    const y = state.year, m = state.monthIndex;
    const last = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const dt = new Date(y, m, d);
      if (set.indexOf(dt.getDay()) > -1) dates.push(dt);
    }
    return dates;
  }

  // ---------- prompt ----------
  function pillarNamesFromInput() {
    const raw = $('f-pillars').value.trim();
    if (!raw) return [];
    return raw.split(/[,;\n]/).map(function(s) { return s.trim(); }).filter(Boolean).slice(0, 8);
  }

  function buildPrompt(input, schedule) {
    const scheduleLines = schedule.map(function(d, i) {
      return '  ' + (i + 1) + ') ' + dateBR(d) + ' (' + WD_LONG[d.getDay()] + ')';
    }).join('\n');
    const givenPillars = input.pillars.length
      ? ('Use EXATAMENTE estes pilares de conteúdo (distribua bem ao longo do mês): ' + input.pillars.join(', ') + '.')
      : ('Crie de 4 a 6 pilares de conteúdo coerentes com o nicho e o objetivo, e distribua os posts entre eles.');

    return [
      'Você é um estrategista de conteúdo sênior, especialista em redes sociais e marketing para o público brasileiro.',
      'Monte um CALENDÁRIO DE CONTEÚDO completo para o mês, com base no briefing abaixo.',
      '',
      'BRIEFING:',
      '- Nicho / tema: ' + input.niche,
      '- Público-alvo: ' + (input.audience || 'não informado'),
      '- Objetivo principal: ' + input.goal,
      '- Plataformas disponíveis (use SOMENTE estas): ' + input.platforms.join(', '),
      '- Tom de voz: ' + input.tone,
      '- ' + givenPillars,
      '',
      'CRONOGRAMA (gere EXATAMENTE 1 post para CADA data abaixo, na MESMA ordem):',
      scheduleLines,
      '',
      'REGRAS:',
      '- Escreva tudo em português do Brasil, específico para o nicho (sem clichês genéricos).',
      '- Gere EXATAMENTE ' + schedule.length + ' posts, um por data, na ordem do cronograma.',
      '- "platform" de cada post deve ser uma das plataformas disponíveis. Varie as plataformas de forma equilibrada e adequada (ex.: Reels no Instagram, vídeos no YouTube, textos no LinkedIn).',
      '- "format" é o formato nativo da plataforma (ex.: Reel, Carrossel, Stories, Post estático, Vídeo, Short, Live, Artigo).',
      '- "pillar" deve ser um dos pilares definidos.',
      '- "title" é um título curto e chamativo do post (máx. ~60 caracteres).',
      '- "hook" é a primeira frase / gancho que prende a atenção.',
      '- "description" descreve a ideia do post em 1-2 frases práticas (o que mostrar/falar).',
      '- "cta" é a chamada para ação adequada ao objetivo.',
      '- "hashtags" é uma lista de 3 a 6 hashtags relevantes (sem o caractere # — só as palavras).',
      '- "best_time" é um horário sugerido de publicação no formato "HH:MM" (24h), coerente com o público.',
      '',
      'RESPONDA APENAS com um objeto JSON válido (sem markdown, sem comentários, sem texto fora do JSON), neste formato EXATO:',
      '{',
      '  "pillars": [{"name": "nome do pilar", "desc": "breve descrição"}],',
      '  "posts": [',
      '    {"platform": "Instagram", "format": "Reel", "pillar": "nome do pilar", "title": "título do post", "hook": "frase de abertura", "description": "ideia do post", "cta": "chamada para ação", "hashtags": ["palavra1","palavra2"], "best_time": "19:00"}',
      '  ]',
      '}'
    ].join('\n');
  }

  function buildSinglePrompt(input, d, current) {
    return [
      'Você é um estrategista de conteúdo sênior para o público brasileiro.',
      'Gere UM ÚNICO post de conteúdo para a data ' + dateBR(d) + ' (' + WD_LONG[d.getDay()] + ').',
      '',
      'CONTEXTO:',
      '- Nicho / tema: ' + input.niche,
      '- Público-alvo: ' + (input.audience || 'não informado'),
      '- Objetivo principal: ' + input.goal,
      '- Plataformas disponíveis (use SOMENTE uma destas): ' + input.platforms.join(', '),
      '- Tom de voz: ' + input.tone,
      '- Pilares de conteúdo: ' + (input.pillars.length ? input.pillars.join(', ') : (state.pillars.map(function(p){return p.name;}).join(', ') || 'livre')),
      current ? ('- Crie uma ideia DIFERENTE da atual ("' + current + '").') : '',
      '',
      'RESPONDA APENAS com um objeto JSON válido neste formato EXATO (sem markdown):',
      '{"platform": "Instagram", "format": "Reel", "pillar": "nome do pilar", "title": "título", "hook": "gancho", "description": "ideia", "cta": "chamada para ação", "hashtags": ["palavra1","palavra2"], "best_time": "19:00"}'
    ].filter(Boolean).join('\n');
  }

  // ---------- LLM call (COR-032: auto-reroll once on parse failure) ----------
  async function callLLM(prompt, maxTokens) {
    const active = ApiKeyManager.getActiveKey();
    if (!active) throw new Error('Nenhuma chave de API configurada. Clique em "Gerenciar chave de API".');

    let endpoint, model, headers = { 'Content-Type': 'application/json' };
    const selected = ApiKeyManager.getModel();
    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      model = selected;
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Calendario de Conteudo IA';
    } else { // openai native
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = selected.indexOf('openai/') === 0 ? selected.replace('openai/', '') : 'gpt-5.5';
      headers['Authorization'] = 'Bearer ' + active.key;
    }

    const buildBody = function(strict) {
      const messages = [
        { role: 'system', content: 'Você responde SOMENTE com JSON válido, sem markdown e sem texto fora do objeto JSON.' },
        { role: 'user', content: prompt }
      ];
      if (strict) {
        messages.push({ role: 'user', content: 'ATENÇÃO: sua resposta anterior NÃO era um JSON válido. Responda novamente com APENAS o objeto JSON completo e válido — sem markdown, sem comentários, sem texto fora do JSON, e com as aspas internas em formato tipográfico (“ ”), nunca aspas duplas retas.' });
      }
      const body = { model: model, messages: messages, temperature: strict ? 0.4 : 0.75, max_tokens: maxTokens || 8000 };
      // COR-034: reasoning models (Gemini Flash, GPT-5.x, Grok, etc.) spend the token
      // budget on hidden "reasoning" tokens; with a small max_tokens the visible content
      // comes back null/truncated (finish_reason "length") → "JSON inválido". Cap reasoning
      // to a low effort on OpenRouter (unified param, safely ignored by non-reasoning models)
      // so the budget is reserved for the actual JSON answer.
      if (active.service === 'openrouter') { body.reasoning = { effort: 'low' }; }
      return body;
    };

    const doFetch = async function(strict) {
      const res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(buildBody(strict)) });
      if (!res.ok) {
        let detail = '';
        try { const e = await res.json(); detail = (e.error && e.error.message) || ''; } catch (_) {}
        if (res.status === 401) throw new Error('Chave de API inválida ou sem créditos.');
        if (res.status === 429) throw new Error('Limite de uso atingido no provedor. Aguarde um instante e tente novamente.');
        throw new Error('Erro do provedor (' + res.status + '). ' + detail);
      }
      const json = await res.json();
      return json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    };
    const exec = function(strict) {
      return (window.RateLimiter && typeof RateLimiter.executeWithLimit === 'function')
        ? RateLimiter.executeWithLimit('generate-calendar', function() { return doFetch(strict); })
        : doFetch(strict);
    };

    let content = await exec(false);
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
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a > -1 && b > -1) t = t.slice(a, b + 1);
    return t;
  }
  function repairJSONStrings(t) {
    let out = '', inStr = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
      if (ch === '\\') { out += ch + (t[i + 1] || ''); i++; continue; }
      if (ch === '"') {
        let j = i + 1; while (j < t.length && (t[j] === ' ' || t[j] === '\t' || t[j] === '\n' || t[j] === '\r')) j++;
        const nx = t[j];
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
    const t = stripToObject(text);
    const noTrailComma = function(s) { return s.replace(/,\s*([}\]])/g, '$1'); };
    const attempts = [t, noTrailComma(t), repairJSONStrings(t), noTrailComma(repairJSONStrings(t))];
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* next */ }
    }
    throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
  }

  // ---------- normalize ----------
  function normalizePost(raw, allowedPlatforms, pillarNames) {
    const p = raw || {};
    let platform = cleanField(p.platform);
    if (allowedPlatforms.indexOf(platform) === -1) platform = allowedPlatforms[0] || 'Instagram';
    let pillar = cleanField(p.pillar);
    if (pillarNames.length && pillarNames.indexOf(pillar) === -1) {
      // soft match
      const lower = pillar.toLowerCase();
      const hit = pillarNames.filter(function(n) { return n.toLowerCase() === lower; })[0];
      pillar = hit || pillar || pillarNames[0];
    }
    let bt = cleanField(p.best_time);
    if (!/^\d{1,2}:\d{2}$/.test(bt)) bt = '19:00';
    const hh = bt.split(':'); bt = pad2(Math.min(23, parseInt(hh[0], 10) || 19)) + ':' + pad2(Math.min(59, parseInt(hh[1], 10) || 0));
    const tags = arr(p.hashtags).map(function(h) { return cleanField(h).replace(/^#/, ''); }).filter(Boolean).slice(0, 8);
    return {
      platform: platform,
      format: cleanField(p.format) || 'Post',
      pillar: pillar || (pillarNames[0] || 'Geral'),
      title: cleanField(p.title) || 'Post de conteúdo',
      hook: cleanField(p.hook),
      description: cleanField(p.description),
      cta: cleanField(p.cta),
      hashtags: tags,
      best_time: bt
    };
  }

  function normalize(raw, schedule, input) {
    const d = raw || {};
    let pillars = arr(d.pillars).map(function(p, i) {
      return { name: cleanField(p && (p.name || p.title)) || ('Pilar ' + (i + 1)), desc: cleanField(p && p.desc), color: PILLAR_COLORS[i % PILLAR_COLORS.length] };
    });
    if (input.pillars.length) {
      pillars = input.pillars.map(function(n, i) {
        const found = pillars.filter(function(x){ return x.name.toLowerCase() === n.toLowerCase(); })[0];
        return { name: n, desc: found ? found.desc : '', color: PILLAR_COLORS[i % PILLAR_COLORS.length] };
      });
    }
    if (!pillars.length) pillars = [{ name: 'Geral', desc: '', color: PILLAR_COLORS[0] }];
    const pillarNames = pillars.map(function(p) { return p.name; });

    let rawPosts = arr(d.posts);
    // zip to schedule: guarantee one post per shown date
    const n = Math.min(rawPosts.length, schedule.length);
    const posts = [];
    for (let i = 0; i < n; i++) {
      const np = normalizePost(rawPosts[i], input.platforms, pillarNames);
      np.date = schedule[i];
      // ensure pillar has a color
      const pc = pillars.filter(function(p){ return p.name.toLowerCase() === np.pillar.toLowerCase(); })[0];
      np.color = pc ? pc.color : PILLAR_COLORS[0];
      posts.push(np);
    }
    return { pillars: pillars, posts: posts };
  }

  // ====================================================================
  //  RENDER
  // ====================================================================
  function renderLegend() {
    const wrap = $('pillar-legend');
    wrap.innerHTML = '';
    state.pillars.forEach(function(p) {
      const item = document.createElement('span');
      item.className = 'pl-item';
      const dot = document.createElement('span');
      dot.className = 'pl-dot'; dot.style.background = p.color;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(p.name));
      wrap.appendChild(item);
    });
  }

  function renderGrid() {
    const weeksWrap = $('cal-weeks');
    weeksWrap.innerHTML = '';
    const y = state.year, m = state.monthIndex;
    const firstDay = new Date(y, m, 1).getDay();      // 0=Sun
    const last = new Date(y, m + 1, 0).getDate();
    // map day-of-month -> post
    const byDay = {};
    state.posts.forEach(function(p) { byDay[p.date.getDate()] = p; });
    const today = new Date();
    const isThisMonth = today.getFullYear() === y && today.getMonth() === m;

    let day = 1;
    const totalCells = Math.ceil((firstDay + last) / 7) * 7;
    let week = null;
    for (let i = 0; i < totalCells; i++) {
      if (i % 7 === 0) { week = document.createElement('div'); week.className = 'cal-week'; weeksWrap.appendChild(week); }
      const cell = document.createElement('div');
      if (i < firstDay || day > last) {
        cell.className = 'cal-cell blank';
      } else {
        const post = byDay[day];
        cell.className = 'cal-cell' + (post ? ' has-post' : '') + (isThisMonth && day === today.getDate() ? ' today' : '');
        const num = document.createElement('span');
        num.className = 'cell-daynum'; num.textContent = day;
        cell.appendChild(num);
        if (post) {
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'cell-post';
          btn.style.borderLeftColor = post.color;
          const fmt = document.createElement('span'); fmt.className = 'cp-format';
          fmt.textContent = post.platform + ' · ' + post.format;
          const ttl = document.createElement('span'); ttl.className = 'cp-title';
          ttl.textContent = post.title;
          btn.appendChild(fmt); btn.appendChild(ttl);
          (function(p) { btn.addEventListener('click', function() { openDetail(p); }); })(post);
          cell.appendChild(btn);
        }
        day++;
      }
      week.appendChild(cell);
    }
  }

  function renderTable() {
    const tb = $('cal-tbody');
    tb.innerHTML = '';
    state.posts.forEach(function(p, idx) {
      const tr = document.createElement('tr');
      function td(cls, node) { const c = document.createElement('td'); if (cls) c.className = cls; if (node != null) { if (typeof node === 'string') c.textContent = node; else c.appendChild(node); } return c; }
      tr.appendChild(td('td-date', dateBR(p.date) + ' · ' + WD_SHORT[p.date.getDay()]));
      tr.appendChild(td('', p.platform));
      const fmt = document.createElement('span'); fmt.className = 'badge-fmt'; fmt.textContent = p.format;
      tr.appendChild(td('', fmt));
      const pil = document.createElement('span'); pil.className = 'td-pillar';
      const dot = document.createElement('span'); dot.className = 'pl-dot'; dot.style.background = p.color; dot.style.width = '9px'; dot.style.height = '9px';
      pil.appendChild(dot); pil.appendChild(document.createTextNode(p.pillar));
      const pcell = document.createElement('td'); pcell.appendChild(pil); tr.appendChild(pcell);
      tr.appendChild(td('td-title', p.title));
      tr.appendChild(td('', p.hook));
      tr.appendChild(td('', p.cta));
      // actions
      const act = document.createElement('div'); act.className = 't-actions';
      const view = mkIconBtn('Ver detalhes', '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>');
      view.addEventListener('click', function() { openDetail(p); });
      const regen = mkIconBtn('Regerar este dia', '<path d="M3 2v6h6"/><path d="M21 12A9 9 0 0 0 6 5.3L3 8"/><path d="M21 22v-6h-6"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/>');
      regen.addEventListener('click', function() { regenerateOne(idx, regen); });
      act.appendChild(view); act.appendChild(regen);
      tr.appendChild(td('', act));
      tb.appendChild(tr);
    });
  }

  function mkIconBtn(title, paths) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn-sm'; b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
    return b;
  }

  // ---------- detail modal ----------
  function captionText(p) {
    const tags = p.hashtags.length ? p.hashtags.map(function(h) { return '#' + h; }).join(' ') : '';
    return [p.title, '', p.hook, '', p.description, '', p.cta, '', tags].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function openDetail(p) {
    const idx = state.posts.indexOf(p);
    const card = $('detail-card');
    card.innerHTML = '';
    const head = document.createElement('div'); head.className = 'detail-head';
    const left = document.createElement('div');
    const dt = document.createElement('div'); dt.className = 'dh-date';
    dt.textContent = dateBR(p.date) + ' · ' + WD_LONG[p.date.getDay()] + ' · ' + p.best_time;
    const h = document.createElement('h3'); h.textContent = p.title;
    left.appendChild(dt); left.appendChild(h);
    const close = document.createElement('button'); close.className = 'btn-icon'; close.innerHTML = '&times;'; close.setAttribute('aria-label', 'Fechar');
    close.addEventListener('click', closeDetail);
    head.appendChild(left); head.appendChild(close);
    card.appendChild(head);

    const tags = document.createElement('div'); tags.className = 'detail-tags';
    [p.platform, p.format, p.pillar].forEach(function(t, i) {
      const s = document.createElement('span'); s.className = 'badge-fmt'; s.textContent = t;
      if (i === 2) { s.style.background = 'transparent'; s.style.border = '1.5px solid ' + p.color; s.style.color = p.color; }
      tags.appendChild(s);
    });
    card.appendChild(tags);

    function block(label, text) {
      if (!text) return;
      const b = document.createElement('div'); b.className = 'detail-block';
      const l = document.createElement('div'); l.className = 'db-label'; l.textContent = label;
      const t = document.createElement('div'); t.className = 'db-text'; t.textContent = text;
      b.appendChild(l); b.appendChild(t); card.appendChild(b);
    }
    block('Gancho', p.hook);
    block('Ideia do post', p.description);
    block('Chamada para ação (CTA)', p.cta);
    if (p.hashtags.length) {
      const b = document.createElement('div'); b.className = 'detail-block';
      const l = document.createElement('div'); l.className = 'db-label'; l.textContent = 'Hashtags';
      const t = document.createElement('div'); t.className = 'db-text detail-hashtags'; t.textContent = p.hashtags.map(function(h){return '#'+h;}).join(' ');
      b.appendChild(l); b.appendChild(t); card.appendChild(b);
    }

    const actions = document.createElement('div'); actions.className = 'detail-actions';
    const copyBtn = document.createElement('button'); copyBtn.className = 'btn-primary'; copyBtn.textContent = 'Copiar legenda';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(captionText(p)).then(function() { toast('Legenda copiada.'); }, function() { toast('Não foi possível copiar.', true); });
    });
    const regenBtn = document.createElement('button'); regenBtn.className = 'btn-secondary'; regenBtn.textContent = 'Regerar este dia';
    regenBtn.addEventListener('click', function() { regenerateOne(idx, regenBtn, true); });
    actions.appendChild(copyBtn); actions.appendChild(regenBtn);
    card.appendChild(actions);

    $('detail-overlay').classList.add('show');
  }
  function closeDetail() { $('detail-overlay').classList.remove('show'); }

  // ---------- regenerate one ----------
  async function regenerateOne(idx, btn, reopen) {
    const p = state.posts[idx];
    if (!p) return;
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de API primeiro.', true); return; }
    const input = collectInput();
    if (!input.niche) { toast('Descreva o nicho no briefing para regerar.', true); return; }
    if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; btn.textContent = '...'; }
    try {
      const raw = await callLLM(buildSinglePrompt(input, p.date, p.title), 4000);
      const pillarNames = state.pillars.map(function(x){ return x.name; });
      const np = normalizePost(raw, input.platforms, pillarNames);
      np.date = p.date;
      const pc = state.pillars.filter(function(x){ return x.name.toLowerCase() === np.pillar.toLowerCase(); })[0];
      np.color = pc ? pc.color : PILLAR_COLORS[0];
      state.posts[idx] = np;
      renderGrid(); renderTable();
      if (reopen) openDetail(np); else closeDetail();
      toast('Post de ' + dateBR(p.date) + ' regenerado.');
    } catch (e) {
      toast(e.message || 'Falha ao regerar.', true);
    } finally {
      if (btn && btn.dataset._t) { btn.disabled = false; btn.textContent = btn.dataset._t; }
    }
  }

  // ====================================================================
  //  EXPORTS
  // ====================================================================
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1200);
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCSV() {
    if (!state.posts.length) return;
    const head = ['Data', 'Dia da semana', 'Plataforma', 'Formato', 'Pilar', 'Título', 'Gancho', 'Descrição', 'CTA', 'Horário sugerido', 'Hashtags'];
    const rows = [head.map(csvCell).join(',')];
    state.posts.forEach(function(p) {
      rows.push([
        dateBR(p.date), WD_LONG[p.date.getDay()], p.platform, p.format, p.pillar, p.title,
        p.hook, p.description, p.cta, p.best_time, p.hashtags.map(function(h){return '#'+h;}).join(' ')
      ].map(csvCell).join(','));
    });
    const csv = '﻿' + rows.join('\r\n'); // BOM for Excel
    downloadBlob(csv, fileBase() + '.csv', 'text/csv;charset=utf-8');
    toast('Planilha .csv baixada.');
  }

  function icsEscape(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsFold(line) {
    // RFC5545 75-octet folding (simple, byte-approx)
    if (line.length <= 73) return line;
    let out = '', i = 0;
    while (i < line.length) {
      const chunk = line.slice(i, i + 73);
      out += (i === 0 ? '' : '\r\n ') + chunk;
      i += 73;
    }
    return out;
  }
  function dtLocal(d, time) {
    const hh = time.split(':');
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + 'T' + pad2(parseInt(hh[0],10)) + pad2(parseInt(hh[1],10)) + '00';
  }
  function dtStamp() {
    const n = new Date();
    return n.getUTCFullYear() + pad2(n.getUTCMonth()+1) + pad2(n.getUTCDate()) + 'T' + pad2(n.getUTCHours()) + pad2(n.getUTCMinutes()) + pad2(n.getUTCSeconds()) + 'Z';
  }
  function addMinutes(time, mins) {
    const hh = time.split(':'); let t = (parseInt(hh[0],10) * 60 + parseInt(hh[1],10) + mins);
    t = Math.min(24*60 - 1, t);
    return pad2(Math.floor(t/60)) + ':' + pad2(t%60);
  }
  function exportICS() {
    if (!state.posts.length) return;
    const stamp = dtStamp();
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gênesis IA//Calendario de Conteudo IA//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    const calName = 'Conteúdo · ' + MONTHS[state.monthIndex] + ' ' + state.year;
    lines.push(icsFold('X-WR-CALNAME:' + icsEscape(calName)));
    state.posts.forEach(function(p, i) {
      const summary = '[' + p.platform + '] ' + p.title;
      const descParts = [];
      if (p.format) descParts.push('Formato: ' + p.format);
      if (p.pillar) descParts.push('Pilar: ' + p.pillar);
      if (p.hook) descParts.push('\nGancho: ' + p.hook);
      if (p.description) descParts.push('\nIdeia: ' + p.description);
      if (p.cta) descParts.push('\nCTA: ' + p.cta);
      if (p.hashtags.length) descParts.push('\n' + p.hashtags.map(function(h){return '#'+h;}).join(' '));
      const desc = descParts.join('\n');
      lines.push('BEGIN:VEVENT');
      lines.push('UID:calendarioia-' + dateISO(p.date) + '-' + i + '@appsbrasil.store');
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART:' + dtLocal(p.date, p.best_time));
      lines.push('DTEND:' + dtLocal(p.date, addMinutes(p.best_time, 30)));
      lines.push(icsFold('SUMMARY:' + icsEscape(summary)));
      lines.push(icsFold('DESCRIPTION:' + icsEscape(desc)));
      lines.push(icsFold('CATEGORIES:' + icsEscape(p.pillar)));
      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER:-PT60M');
      lines.push('ACTION:DISPLAY');
      lines.push(icsFold('DESCRIPTION:' + icsEscape('Lembrete: ' + summary)));
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    downloadBlob(lines.join('\r\n'), fileBase() + '.ics', 'text/calendar;charset=utf-8');
    toast('Agenda .ics baixada.');
  }

  function fileBase() {
    return 'calendario-' + slugify($('f-niche').value.trim() || 'conteudo', 'conteudo') + '-' + MONTHS[state.monthIndex].toLowerCase() + '-' + state.year;
  }

  // ====================================================================
  //  STATE / UI
  // ====================================================================
  function setTab(tab) {
    state.tab = tab;
    [['grade','tab-grade','stage-grade'], ['tabela','tab-tabela','stage-tabela'], ['export','tab-export','stage-export']].forEach(function(t) {
      $(t[1]).classList.toggle('active', t[0] === tab);
      $(t[2]).style.display = t[0] === tab ? 'block' : 'none';
    });
  }
  function showState(which) { // empty | loading | result
    $('state-empty').style.display = which === 'empty' ? 'flex' : 'none';
    $('state-loading').style.display = which === 'loading' ? 'flex' : 'none';
    const showResult = which === 'result';
    $('board-actions').style.display = showResult ? 'flex' : 'none';
    if (showResult) setTab(state.tab);
    else { ['stage-grade','stage-tabela','stage-export'].forEach(function(id) { $(id).style.display = 'none'; }); }
  }
  function setBusy(b) {
    const btn = $('generate-btn');
    btn.disabled = b;
    btn.querySelector('.btn-text').style.display = b ? 'none' : 'inline';
    btn.querySelector('.btn-loading').style.display = b ? 'inline' : 'none';
  }

  function collectInput() {
    return {
      niche: $('f-niche').value.trim(),
      audience: $('f-audience').value.trim(),
      goal: state.goal,
      platforms: state.platforms.slice(),
      tone: $('tone-select').value,
      pillars: pillarNamesFromInput()
    };
  }

  async function generate() {
    const input = collectInput();
    if (!input.niche) { toast('Descreva o seu nicho para começar.', true); $('f-niche').focus(); return; }
    if (!input.platforms.length) { toast('Selecione ao menos uma plataforma.', true); return; }
    if (state.freq === 'custom' && !state.weekdays.length) { toast('Escolha ao menos um dia da semana.', true); return; }
    if (!ApiKeyManager.getActiveKey()) {
      toast('Configure sua chave de API primeiro.', true);
      if (MembershipGate.showScreen) MembershipGate.showScreen('key-screen');
      return;
    }
    // read month/year from select
    const mv = $('f-month').value.split('-');
    state.year = parseInt(mv[0], 10);
    state.monthIndex = parseInt(mv[1], 10) - 1;

    const schedule = buildSchedule();
    if (!schedule.length) { toast('Nenhuma data no mês com essa frequência. Ajuste os dias.', true); return; }
    state.schedule = schedule;

    setBusy(true);
    showState('loading');
    const steps = ['Mapeando os pilares de conteúdo...', 'Distribuindo os posts pelas datas...', 'Escrevendo ganchos e CTAs...', 'Montando a grade do mês...'];
    let si = 0; $('loading-step').textContent = steps[0];
    $('loading-sub').textContent = schedule.length + ' posts para ' + MONTHS[state.monthIndex] + ' ' + state.year;
    const ticker = setInterval(function() { si = (si + 1) % steps.length; $('loading-step').textContent = steps[si]; }, 2200);

    try {
      const raw = await callLLM(buildPrompt(input, schedule), 16000);
      clearInterval(ticker);
      const data = normalize(raw, schedule, input);
      if (!data.posts.length) throw new Error('O modelo não retornou posts. Tente gerar novamente.');
      state.pillars = data.pillars;
      state.posts = data.posts;
      renderLegend(); renderGrid(); renderTable();
      $('board-month').textContent = MONTHS[state.monthIndex] + ' ' + state.year;
      $('board-meta').textContent = state.posts.length + ' posts · ' + state.platforms.join(', ');
      $('export-note').textContent = 'Calendário de ' + state.posts.length + ' posts para ' + MONTHS[state.monthIndex] + ' ' + state.year + '. O arquivo .ics cria um evento com lembrete (1h antes) para cada post no horário sugerido. O .csv abre direto no Google Sheets, Excel ou Notion.';
      ['tab-tabela', 'tab-export'].forEach(function(id) { $(id).disabled = false; });
      state.tab = 'grade';
      showState('result');
      toast('Calendário gerado! Confira a grade e exporte.');
    } catch (e) {
      clearInterval(ticker);
      showState('empty');
      toast(e.message || 'Falha ao gerar.', true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- wiring ----------
  function multiChips(groupId, attr, stateArrName, opts) {
    const group = $(groupId);
    if (!group) return;
    group.addEventListener('click', function(e) {
      const c = e.target.closest('.chip'); if (!c) return;
      const val = c.dataset[attr];
      const cur = state[stateArrName];
      const on = !c.classList.contains('active');
      if (!on && cur.length <= 1 && (!opts || opts.minOne !== false)) { toast('Mantenha ao menos uma opção.', true); return; }
      c.classList.toggle('active', on);
      const idx = cur.indexOf(attr === 'wd' ? parseInt(val,10) : val);
      const v = attr === 'wd' ? parseInt(val, 10) : val;
      if (on && idx === -1) cur.push(v);
      if (!on && idx > -1) cur.splice(idx, 1);
    });
  }
  function singleChips(groupId, attr, apply) {
    const group = $(groupId);
    if (!group) return;
    group.addEventListener('click', function(e) {
      const c = e.target.closest('.chip'); if (!c) return;
      group.querySelectorAll('.chip').forEach(function(x) { x.classList.remove('active'); });
      c.classList.add('active');
      apply(c.dataset[attr]);
    });
  }

  function populateMonths() {
    const sel = $('f-month');
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth();
    for (let i = 0; i < 7; i++) {
      const opt = document.createElement('option');
      opt.value = y + '-' + (m + 1);
      opt.textContent = MONTHS[m] + ' ' + y;
      if (i === 1) opt.selected = true; // default: next month
      sel.appendChild(opt);
      m++; if (m > 11) { m = 0; y++; }
    }
    const mv = sel.value.split('-');
    state.year = parseInt(mv[0], 10); state.monthIndex = parseInt(mv[1], 10) - 1;
  }

  function wire() {
    multiChips('platform-chips', 'platform', 'platforms');
    singleChips('goal-chips', 'goal', function(v) { state.goal = v; });
    singleChips('freq-chips', 'freq', function(v) {
      state.freq = v;
      $('weekday-chips').classList.toggle('show', v === 'custom');
    });
    // weekday multi (no min-one block here; checked at generate)
    $('weekday-chips').addEventListener('click', function(e) {
      const c = e.target.closest('.chip'); if (!c) return;
      const wd = parseInt(c.dataset.wd, 10);
      const on = !c.classList.contains('active');
      c.classList.toggle('active', on);
      const i = state.weekdays.indexOf(wd);
      if (on && i === -1) state.weekdays.push(wd);
      if (!on && i > -1) state.weekdays.splice(i, 1);
    });
    $('tone-select').addEventListener('change', function() { state.tone = $('tone-select').value; });
    $('f-month').addEventListener('change', function() {
      const mv = $('f-month').value.split('-');
      state.year = parseInt(mv[0], 10); state.monthIndex = parseInt(mv[1], 10) - 1;
    });

    $('tab-grade').addEventListener('click', function() { if (!$('tab-grade').disabled) setTab('grade'); });
    $('tab-tabela').addEventListener('click', function() { if (!$('tab-tabela').disabled) setTab('tabela'); });
    $('tab-export').addEventListener('click', function() { if (!$('tab-export').disabled) setTab('export'); });

    $('generate-btn').addEventListener('click', generate);
    $('btn-csv').addEventListener('click', exportCSV);
    $('btn-ics').addEventListener('click', exportICS);
    $('btn-csv-2').addEventListener('click', exportCSV);
    $('btn-ics-2').addEventListener('click', exportICS);

    $('detail-overlay').addEventListener('click', function(e) { if (e.target === $('detail-overlay')) closeDetail(); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeDetail(); });

    const ok = $('open-keys');
    if (ok) ok.addEventListener('click', function(e) { e.preventDefault(); const mb = $('manage-keys-btn'); if (mb) mb.click(); });
  }

  function init() {
    const session = (window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession());
    if (session) { const nameEl = $('user-name'); if (nameEl) nameEl.textContent = session.name || 'Maestro'; }
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');
    populateMonths();
    wire();
    showState('empty');
  }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = (window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession());
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
