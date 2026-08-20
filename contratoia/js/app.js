/**
 * Contrato IA — Main Application Logic
 *
 * Contract render/pagination engine: BYOK LLM → strict JSON → the tool's OWN
 * renderer builds a complete, self-contained, paginated, numbered, signable
 * contract (party qualification + numbered clauses + local/date + signature
 * blocks) with a live iframe preview + PDF/HTML export. The AI never renders
 * the document — it only returns structured JSON; the renderer here is the moat.
 *
 * All AI calls use the member's OWN key (BYOK, Hard Rule #1), wrapped in the
 * client-side RateLimiter. Nothing is sent to any backend but the n8n gate.
 */
const App = (function () {
  'use strict';

  let inited = false;
  let currentDoc = null; // { json, html, theme, meta }

  // ---- tiny DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Normalize LLM null-like strings (COR-015) before rendering.
  function clean(v) {
    if (v == null) return '';
    const s = String(v).trim();
    const low = s.toLowerCase();
    if (['null', 'undefined', 'n/a', 'na', '-', '—', 'none', 'nulo'].includes(low)) return '';
    return s;
  }

  function toast(msg, isErr) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, isErr ? 5200 : 3200);
  }

  // ---------------------------------------------------------------
  // Chip selectors
  // ---------------------------------------------------------------
  function wireChips(containerId, dataAttr) {
    const c = $(containerId);
    if (!c) return;
    c.addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      c.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
      chip.classList.add('active');
      if (dataAttr === 'theme' && currentDoc) rerenderTheme(chip.getAttribute('data-theme'));
    });
  }
  function chipValue(containerId, dataAttr) {
    const c = $(containerId);
    const a = c ? c.querySelector('.chip.active') : null;
    return a ? a.getAttribute('data-' + dataAttr) : '';
  }

  // ---------------------------------------------------------------
  // Gather inputs
  // ---------------------------------------------------------------
  function gather() {
    return {
      tipo: chipValue('type-chips', 'type') || 'Prestação de Serviços',
      contratante: $('f-contratante').value.trim(),
      contratado: $('f-contratado').value.trim(),
      objeto: $('f-objeto').value.trim(),
      valor: $('f-valor').value.trim(),
      prazo: $('f-prazo').value.trim(),
      pagamento: $('f-pagamento').value.trim(),
      cidade: $('f-cidade').value.trim(),
      data: $('f-data').value.trim(),
      extra: $('f-extra').value.trim(),
      tom: chipValue('tone-chips', 'tone') || 'Formal jurídico',
      theme: chipValue('theme-chips', 'theme') || 'cartorio'
    };
  }

  // ---------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------
  function buildMessages(spec) {
    const system =
      'Você é um advogado brasileiro especialista em contratos, redigindo minutas claras, ' +
      'completas e juridicamente adequadas em português do Brasil. Você devolve SOMENTE um ' +
      'objeto JSON válido (sem markdown, sem cercas de código, sem texto antes ou depois). ' +
      'Use aspas tipográficas (“ ”) dentro dos textos, nunca aspas duplas retas. ' +
      'Quando um dado não foi informado pelo usuário (CPF, CNPJ, RG, endereço, etc.), NÃO invente: ' +
      'deixe uma lacuna para preenchimento manual usando underscores, por exemplo ' +
      '"inscrito(a) no CPF/CNPJ sob o nº ____________, com sede/residência em ____________". ' +
      'Numere as cláusulas de forma coerente e inclua os parágrafos necessários.';

    const schema = [
      'Estrutura EXATA do JSON de saída:',
      '{',
      '  "titulo": "CONTRATO DE ... (em maiúsculas)",',
      '  "preambulo": "frase de abertura do tipo: Pelo presente instrumento particular, as partes a seguir qualificadas...",',
      '  "partes": {',
      '    "contratante": { "papel": "CONTRATANTE", "qualificacao": "nome, natureza (pessoa física/jurídica), com as lacunas de documento/endereço para preenchimento" },',
      '    "contratado": { "papel": "CONTRATADO", "qualificacao": "idem" }',
      '  },',
      '  "clausulas": [',
      '    { "titulo": "DO OBJETO", "paragrafos": ["texto do caput", "Parágrafo único: ..."], "itens": ["item a", "item b"] },',
      '    ... (inclua as cláusulas adequadas ao tipo de contrato)',
      '  ],',
      '  "encerramento": "E, por estarem assim justas e contratadas, firmam o presente em 2 (duas) vias de igual teor.",',
      '  "local_data": "Cidade/UF, DD de mês de AAAA.",',
      '  "assinaturas": [',
      '    { "nome": "nome do CONTRATANTE ou lacuna", "papel": "CONTRATANTE", "documento": "CPF/CNPJ: ____________" },',
      '    { "nome": "nome do CONTRATADO ou lacuna", "papel": "CONTRATADO", "documento": "CPF/CNPJ: ____________" }',
      '  ],',
      '  "testemunhas": true',
      '}',
      '',
      'Regras de conteúdo:',
      '- Em "titulo" coloque APENAS o assunto da cláusula em maiúsculas, SEM o prefixo "CLÁUSULA PRIMEIRA/SEGUNDA/..." e SEM numeração — o app numera automaticamente. Ex.: "DO OBJETO", "DO VALOR E FORMA DE PAGAMENTO", "DA RESCISÃO".',
      '- "itens" é OPCIONAL por cláusula (use só quando fizer sentido, ex.: lista de entregáveis/obrigações).',
      '- Inclua SEMPRE, no mínimo, cláusulas de: objeto, obrigações das partes, valor e forma de pagamento, ' +
        'prazo/vigência, rescisão, multa/penalidades, confidencialidade, proteção de dados (LGPD), e foro. ' +
        'Adapte e acrescente cláusulas específicas ao tipo de contrato (ex.: exclusividade, direitos autorais/de imagem, ' +
        'gestão de contas de anúncio e verba de mídia para tráfego pago, propriedade intelectual dos criativos para social media).',
      '- Para NDA/Confidencialidade, foque nas cláusulas de sigilo, informações confidenciais, exceções, prazo de sigilo e penalidades.',
      '- Escreva textos completos e prontos para assinar; não use reticências indicando "preencher" a não ser as lacunas de dados pessoais.'
    ].join('\n');

    const dados = [
      'Tipo de contrato: ' + spec.tipo,
      'CONTRATANTE (cliente): ' + (spec.contratante || '[não informado — deixe lacuna]'),
      'CONTRATADO (prestador): ' + (spec.contratado || '[não informado — deixe lacuna]'),
      'Objeto/escopo: ' + (spec.objeto || '[descrever conforme o tipo]'),
      'Valor: ' + (spec.valor || '[deixe lacuna se não informado]'),
      'Forma de pagamento: ' + (spec.pagamento || '[deixe lacuna se não informado]'),
      'Prazo/vigência: ' + (spec.prazo || '[deixe lacuna se não informado]'),
      'Cidade/foro: ' + (spec.cidade || '[deixe lacuna]'),
      'Data do contrato: ' + (spec.data || '[deixe lacuna]'),
      'Cláusulas/observações específicas: ' + (spec.extra || 'nenhuma'),
      'Tom de redação: ' + spec.tom
    ].join('\n');

    const user = schema + '\n\n=== DADOS DO CONTRATO ===\n' + dados +
      '\n\nGere agora o contrato completo como JSON seguindo exatamente a estrutura acima.';

    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  // ---------------------------------------------------------------
  // JSON repair ladder
  // ---------------------------------------------------------------
  function parseJSON(raw) {
    if (!raw) throw new Error('empty');
    let s = String(raw).trim();
    // strip code fences
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    // slice to outermost object
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);

    const attempts = [
      function (x) { return x; },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1'); }, // trailing commas
      function (x) { return repairQuotes(x); }
    ];
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i](s)); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('parse');
  }

  // State-machine that escapes stray control chars inside strings.
  function repairQuotes(s) {
    let out = '', inStr = false, esc2 = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc2) { out += ch; esc2 = false; continue; }
      if (ch === '\\') { out += ch; esc2 = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr) {
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { continue; }
        if (ch === '\t') { out += '\\t'; continue; }
      }
      out += ch;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // LLM call (BYOK) — reroll once on parse failure (COR-032),
  // reasoning budget on OpenRouter (COR-034).
  // ---------------------------------------------------------------
  function fetchContent(messages, active, temperature, noReasoning) {
    const service = active.service;
    let url, headers, model;
    const body = { messages: messages, temperature: temperature, max_tokens: 16000 };

    if (service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      model = ApiKeyManager.getModel();
      headers = {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        // ASCII-only header values (COR: non-ISO-8859-1 chars throw in fetch)
        'HTTP-Referer': 'https://contratoia.appsbrasil.store',
        'X-Title': 'Contrato IA - Gênesis IA'
      };
      // COR-034 — cap thinking, reserve budget for JSON. COR-035 — DeepSeek (via OpenRouter)
      // routes the WHOLE answer into message.reasoning and returns message.content EMPTY when
      // reasoning is enabled — and it is slow, so never send it for deepseek/* (they return a
      // normal content string in a single fast call without it). Other reasoning models keep
      // the COR-034 cap; the empty-content retry in fetchResilient is the universal safety net.
      const isDeepSeek = model.indexOf('deepseek/') === 0;
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' };
    } else {
      // native OpenAI fallback
      url = 'https://api.openai.com/v1/chat/completions';
      const picked = ApiKeyManager.getModel();
      model = picked.indexOf('openai/') === 0 ? picked.slice('openai/'.length) : 'gpt-4o';
      headers = {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json'
      };
    }
    body.model = model;

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) {
            const m = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status);
            throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
          }
          const msg = data && data.choices && data.choices[0] && data.choices[0].message;
          const content = msg && msg.content;
          if (!content || !content.trim()) {
            // Empty content. COR-035: reasoning models can place the whole answer in
            // message.reasoning and leave content empty (finish_reason 'stop'). Signal the
            // caller to retry once WITHOUT the reasoning param, which restores a normal content.
            const err = new Error('Resposta vazia do modelo (verifique créditos/limite da sua chave).');
            err.emptyContent = true;
            err.hadReasoning = !!(msg && msg.reasoning);
            throw err;
          }
          return content;
        });
      });
  }

  // Empty-content recovery (COR-035): on the OpenRouter path, if a model returns empty
  // content (answer stuck in message.reasoning), retry the SAME request once without the
  // reasoning param before giving up. Safe/additive — only fires on the failure case.
  function fetchResilient(messages, active, temperature) {
    return fetchContent(messages, active, temperature, false).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') {
        return fetchContent(messages, active, temperature, true);
      }
      throw e;
    });
  }

  function generateJSON(messages, active) {
    // first attempt
    return fetchResilient(messages, active, 0.5).then(function (content) {
      try { return parseJSON(content); }
      catch (e) {
        // reroll once, stricter + lower temperature (COR-032)
        const strict = messages.concat([{
          role: 'user',
          content: 'Sua resposta anterior NÃO era um JSON válido. Responda NOVAMENTE com APENAS o ' +
                   'objeto JSON completo, sem markdown e sem texto fora do JSON, usando aspas ' +
                   'tipográficas (“ ”) dentro dos valores.'
        }]);
        return fetchResilient(strict, active, 0.3).then(function (c2) { return parseJSON(c2); });
      }
    });
  }

  // ---------------------------------------------------------------
  // Contract renderer — builds a complete self-contained HTML document
  // ---------------------------------------------------------------
  const THEMES = {
    cartorio: {
      page: '#ffffff', ink: '#1b2b3a', accent: '#8a2b2b', rule: '#c9bfa8',
      bodyFont: "Georgia, 'Times New Roman', serif",
      headFont: "Georgia, 'Times New Roman', serif",
      titleTransform: 'uppercase', letter: '0.5px'
    },
    clean: {
      page: '#ffffff', ink: '#1a1a1a', accent: '#1a1a1a', rule: '#dddddd',
      bodyFont: "-apple-system, 'Segoe UI', Arial, sans-serif",
      headFont: "-apple-system, 'Segoe UI', Arial, sans-serif",
      titleTransform: 'uppercase', letter: '0.3px'
    },
    executivo: {
      page: '#ffffff', ink: '#12243a', accent: '#12243a', rule: '#c7d0da',
      bodyFont: "'Segoe UI', Arial, sans-serif",
      headFont: "Georgia, serif",
      titleTransform: 'uppercase', letter: '0.4px'
    }
  };

  function ordinal(n) {
    // 1ª, 2ª ... clause numbering
    return n + 'ª';
  }

  function renderContract(json, themeKey) {
    const t = THEMES[themeKey] || THEMES.cartorio;
    const titulo = clean(json.titulo) || 'CONTRATO';
    const preambulo = clean(json.preambulo);
    const partes = json.partes || {};
    const ct = partes.contratante || {};
    const cd = partes.contratado || {};
    const clausulas = Array.isArray(json.clausulas) ? json.clausulas : [];
    const encerramento = clean(json.encerramento);
    const localData = clean(json.local_data);
    const assinaturas = Array.isArray(json.assinaturas) ? json.assinaturas : [];
    const testemunhas = json.testemunhas !== false;

    function paras(arr) {
      if (!Array.isArray(arr)) return '';
      return arr.map(function (p) {
        const txt = clean(p);
        if (!txt) return '';
        return '<p class="cl-p">' + esc(txt) + '</p>';
      }).join('');
    }
    function items(arr) {
      if (!Array.isArray(arr) || !arr.length) return '';
      const lis = arr.map(function (it) {
        const txt = clean(it);
        return txt ? '<li>' + esc(txt) + '</li>' : '';
      }).join('');
      return lis ? '<ul class="cl-items">' + lis + '</ul>' : '';
    }

    const clausulasHtml = clausulas.map(function (cl, i) {
      // strip a redundant "CLÁUSULA PRIMEIRA – " / "CLÁUSULA 1ª - " prefix the model may include
      const ctitle = clean(cl.titulo).replace(/^cl[áa]usula\b[^–—\-:]*[–—\-:]\s*/i, '').trim();
      const head = 'CLÁUSULA ' + ordinal(i + 1) + (ctitle ? ' — ' + esc(ctitle) : '');
      return '<section class="clause">' +
        '<h2 class="cl-h">' + head + '</h2>' +
        paras(cl.paragrafos) + items(cl.itens) +
        '</section>';
    }).join('');

    function qualif(role, obj) {
      const q = clean(obj.qualificacao);
      const papel = clean(obj.papel) || role;
      return '<p class="party"><strong>' + esc(papel) + ':</strong> ' + (q ? esc(q) : '____________') + '</p>';
    }

    const signBlocks = (assinaturas.length ? assinaturas : [
      { papel: 'CONTRATANTE', nome: '', documento: 'CPF/CNPJ: ____________' },
      { papel: 'CONTRATADO', nome: '', documento: 'CPF/CNPJ: ____________' }
    ]).map(function (s) {
      const nome = clean(s.nome);
      const papel = clean(s.papel);
      const doc = clean(s.documento);
      return '<div class="sign">' +
        '<div class="sign-line"></div>' +
        '<div class="sign-name">' + (nome ? esc(nome) : '____________________') + '</div>' +
        (papel ? '<div class="sign-role">' + esc(papel) + '</div>' : '') +
        (doc ? '<div class="sign-doc">' + esc(doc) + '</div>' : '') +
        '</div>';
    }).join('');

    const witnessBlock = testemunhas ?
      '<div class="witnesses"><h3 class="w-h">TESTEMUNHAS</h3><div class="sign-grid">' +
        '<div class="sign"><div class="sign-line"></div><div class="sign-name">____________________</div><div class="sign-doc">Nome: ____________  CPF: ____________</div></div>' +
        '<div class="sign"><div class="sign-line"></div><div class="sign-name">____________________</div><div class="sign-doc">Nome: ____________  CPF: ____________</div></div>' +
      '</div></div>' : '';

    const css =
      '*{box-sizing:border-box}' +
      'html,body{margin:0;padding:0}' +
      'body{font-family:' + t.bodyFont + ';color:' + t.ink + ';background:#e9e4d8;line-height:1.65;font-size:15px}' +
      '.sheet{max-width:820px;margin:24px auto;background:' + t.page + ';padding:64px 72px;box-shadow:0 6px 30px rgba(0,0,0,.18)}' +
      '.doc-title{font-family:' + t.headFont + ';text-align:center;font-size:22px;font-weight:700;text-transform:' + t.titleTransform + ';letter-spacing:' + t.letter + ';margin:0 0 6px;color:' + t.ink + '}' +
      '.title-rule{width:70px;height:3px;background:' + t.accent + ';margin:0 auto 26px}' +
      '.preamble{text-align:justify;margin:0 0 18px}' +
      '.party{text-align:justify;margin:0 0 12px}' +
      '.parties{margin:0 0 26px}' +
      '.clause{margin:0 0 16px;page-break-inside:avoid}' +
      '.cl-h{font-family:' + t.headFont + ';font-size:14px;font-weight:700;letter-spacing:.4px;color:' + t.accent + ';margin:0 0 6px;text-transform:uppercase}' +
      '.cl-p{text-align:justify;margin:0 0 8px}' +
      '.cl-items{margin:0 0 8px 22px;padding:0}' +
      '.cl-items li{text-align:justify;margin:0 0 4px}' +
      '.closing{text-align:justify;margin:26px 0 30px}' +
      '.localdata{margin:0 0 44px}' +
      '.sign-grid{display:flex;flex-wrap:wrap;gap:40px 60px;margin-top:10px}' +
      '.sign{flex:1;min-width:230px;text-align:center;page-break-inside:avoid}' +
      '.sign-line{border-top:1px solid ' + t.ink + ';margin:0 0 6px}' +
      '.sign-name{font-weight:700;font-size:14px}' +
      '.sign-role{font-size:12px;color:' + t.accent + ';letter-spacing:.5px;text-transform:uppercase;margin-top:2px}' +
      '.sign-doc{font-size:12px;color:#555;margin-top:2px}' +
      '.witnesses{margin-top:44px}' +
      '.w-h{font-family:' + t.headFont + ';font-size:13px;letter-spacing:.5px;color:' + t.accent + ';margin:0 0 8px}' +
      '.seal-foot{margin-top:40px;text-align:center;color:#9a7b3f;font-size:11px;letter-spacing:2px;text-transform:uppercase}' +
      '@page{size:A4;margin:20mm 18mm}' +
      '@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:0}}';

    const partiesHtml =
      '<div class="parties">' + qualif('CONTRATANTE', ct) + qualif('CONTRATADO', cd) + '</div>';

    const html =
      '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>' + esc(titulo) + '</title><style>' + css + '</style></head><body>' +
      '<div class="sheet">' +
      '<h1 class="doc-title">' + esc(titulo) + '</h1>' +
      '<div class="title-rule"></div>' +
      (preambulo ? '<p class="preamble">' + esc(preambulo) + '</p>' : '') +
      partiesHtml +
      clausulasHtml +
      (encerramento ? '<p class="closing">' + esc(encerramento) + '</p>' : '') +
      (localData ? '<p class="localdata">' + esc(localData) + '</p>' : '') +
      '<div class="sign-grid">' + signBlocks + '</div>' +
      witnessBlock +
      '<div class="seal-foot">Documento gerado com Contrato IA · Gênesis IA</div>' +
      '</div></body></html>';

    return html;
  }

  // ---------------------------------------------------------------
  // Show result
  // ---------------------------------------------------------------
  function showResult(json, theme) {
    const html = renderContract(json, theme);
    currentDoc = { json: json, html: html, theme: theme, meta: clean(json.titulo) || 'Contrato' };

    // preview
    const empty = $('doc-empty');
    const iframe = $('doc-preview');
    if (empty) empty.style.display = 'none';
    iframe.style.display = 'block';
    iframe.srcdoc = html;

    // mark it a proper document (remove MINUTA once generated? keep — it's a draft until signed)
    // The MINUTA stamp stays as an honest "draft/minuta" marker on the on-screen preview only.

    // clauses outline
    const outline = $('clauses-outline');
    outline.innerHTML = '';
    const cls = Array.isArray(json.clausulas) ? json.clausulas : [];
    cls.forEach(function (cl, i) {
      const li = document.createElement('li');
      li.className = 'outline-item';
      const firstP = (Array.isArray(cl.paragrafos) && cl.paragrafos[0]) ? clean(cl.paragrafos[0]) : '';
      li.innerHTML = '<span class="outline-num">' + (i + 1) + 'ª</span>' +
        '<div class="outline-body"><h4>' + esc(clean(cl.titulo) || 'Cláusula') + '</h4>' +
        '<p>' + esc(firstP.slice(0, 140)) + (firstP.length > 140 ? '…' : '') + '</p></div>';
      outline.appendChild(li);
    });

    // html tab
    $('doc-html').value = html;

    // enable tabs + exports
    ['tab-clauses', 'tab-html'].forEach(function (id) { $(id).disabled = false; });
    ['export-pdf', 'export-html', 'copy-html'].forEach(function (id) { $(id).disabled = false; });

    // meta
    $('doc-meta').textContent = cls.length + ' cláusulas · ' + Math.round(html.length / 1024) + ' KB';

    switchTab('preview');
  }

  function rerenderTheme(themeKey) {
    if (!currentDoc) return;
    const html = renderContract(currentDoc.json, themeKey);
    currentDoc.html = html;
    currentDoc.theme = themeKey;
    $('doc-preview').srcdoc = html;
    $('doc-html').value = html;
    $('doc-meta').textContent = (Array.isArray(currentDoc.json.clausulas) ? currentDoc.json.clausulas.length : 0) +
      ' cláusulas · ' + Math.round(html.length / 1024) + ' KB';
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    ['preview', 'clauses', 'html'].forEach(function (n) {
      const pane = $('pane-' + n);
      if (pane) pane.style.display = (n === name ? 'block' : 'none');
    });
  }

  // ---------------------------------------------------------------
  // Generate
  // ---------------------------------------------------------------
  function generate() {
    const active = ApiKeyManager.getActiveKey();
    if (!active) {
      toast('Configure sua chave de API primeiro.', true);
      MembershipGate.showScreen('key-screen');
      return;
    }
    const spec = gather();
    if (!spec.objeto && !spec.contratante && !spec.contratado) {
      toast('Preencha ao menos as partes e o objeto do contrato.', true);
      return;
    }

    const btn = $('generate-btn');
    const note = $('gen-note');
    btn.disabled = true;
    const empty = $('doc-empty');
    const iframe = $('doc-preview');
    iframe.style.display = 'none';
    if (empty) {
      empty.style.display = 'grid';
      empty.innerHTML = '<div class="gen-loading"><span class="seal-spin"></span><span>Redigindo o contrato… selando as cláusulas.</span></div>';
    }
    note.textContent = 'Gerando…';

    const messages = buildMessages(spec);

    RateLimiter.executeWithLimit('generate-contract', function () {
      return generateJSON(messages, active);
    }).then(function (json) {
      showResult(json, spec.theme);
      toast('Contrato gerado. Revise e exporte em PDF.');
    }).catch(function (err) {
      console.error('Falha ao gerar contrato:', err);
      if (empty) {
        empty.style.display = 'grid';
        empty.innerHTML = '<div><div class="seal-mark" aria-hidden="true"><svg viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="38" stroke="#8a2b2b" stroke-width="2.5"/></svg></div>' +
          '<h3>Não foi possível gerar</h3><p>' + esc(String(err.message || err)) + '</p></div>';
      }
      const msg = String(err.message || err);
      if (/rate|limit|429/i.test(msg)) toast('Muitas gerações em pouco tempo. Aguarde um instante.', true);
      else toast('Erro ao gerar: ' + msg.slice(0, 120), true);
    }).then(function () {
      btn.disabled = false;
      note.textContent = 'A IA roda na sua chave (BYOK)';
    });
  }

  // ---------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function slug() {
    return (currentDoc && currentDoc.meta ? currentDoc.meta : 'contrato')
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'contrato';
  }
  function exportHTML() {
    if (!currentDoc) return;
    download(slug() + '.html', currentDoc.html);
    toast('HTML baixado.');
  }
  function exportPDF() {
    if (!currentDoc) return;
    // Print the iframe directly (best fidelity + @media print page breaks).
    const iframe = $('doc-preview');
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      toast('Abrindo impressão — escolha "Salvar como PDF".');
    } catch (e) {
      // fallback: open a print window from the HTML blob
      const w = window.open('', '_blank');
      if (w) { w.document.write(currentDoc.html); w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 400); }
      else toast('Permita pop-ups para exportar o PDF.', true);
    }
  }
  function copyHTML() {
    if (!currentDoc) return;
    const ta = $('doc-html');
    ta.select();
    navigator.clipboard.writeText(currentDoc.html).then(function () {
      toast('HTML copiado.');
    }).catch(function () {
      try { document.execCommand('copy'); toast('HTML copiado.'); }
      catch (e) { toast('Não foi possível copiar.', true); }
    });
  }

  // ---------------------------------------------------------------
  // No-key warning sync (COR-008) + init
  // ---------------------------------------------------------------
  function syncKeyState() {
    const note = $('gen-note');
    if (!note) return;
    if (ApiKeyManager.getActiveKey()) note.textContent = 'A IA roda na sua chave (BYOK)';
    else note.textContent = 'Configure sua chave (ícone 🔑) para gerar';
  }

  function prefillDate() {
    const f = $('f-data');
    if (f && !f.value) {
      // dd/mm/aaaa from the browser's current date
      const d = new Date();
      const p = function (n) { return String(n).padStart(2, '0'); };
      f.value = p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    }
  }

  function init() {
    if (inited) { syncKeyState(); return; }
    inited = true;

    wireChips('type-chips', 'type');
    wireChips('tone-chips', 'tone');
    wireChips('theme-chips', 'theme');

    if (ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    $('generate-btn').addEventListener('click', generate);
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { if (!b.disabled) switchTab(b.getAttribute('data-tab')); });
    });
    $('export-pdf').addEventListener('click', exportPDF);
    $('export-html').addEventListener('click', exportHTML);
    $('copy-html').addEventListener('click', copyHTML);

    prefillDate();
    syncKeyState();
  }

  // COR-008: run on app-ready AND DOMContentLoaded fallback; re-sync each time.
  document.addEventListener('maestria:app-ready', function () { init(); syncKeyState(); });
  document.addEventListener('DOMContentLoaded', function () {
    const app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) init();
  });

  return { init: init };
})();

window.App = App;
