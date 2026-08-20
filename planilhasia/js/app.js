/**
 * Planilhas IA — Main Application Logic
 *
 * Real spreadsheet generator: BYOK LLM → strict JSON workbook schema → the tool's
 * OWN engine (a) stamps CORRECT Excel formulas deterministically (row numbers are
 * computed here, never by the model), (b) renders a green-bar ledger preview with
 * best-effort evaluated values, and (c) builds a real, downloadable .xlsx
 * (multi-sheet, live formulas, cell styling, number formats) via the vendored,
 * CSP-safe xlsx-js-style (window.XLSX). Also exports the active sheet as .CSV.
 *
 * The AI only returns structured JSON describing the sheets — it never writes the
 * file. The formula-stamping + xlsx renderer here is the moat (a chat prompt can
 * only return a text table). All AI calls use the member's OWN key (BYOK, Hard
 * Rule #1), wrapped in the client-side RateLimiter. Nothing is sent to any backend
 * but the n8n membership gate.
 */
const App = (function () {
  'use strict';

  let inited = false;
  let model = null;          // computed workbook model
  let activeSheet = 0;

  // ---- tiny DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Normalize LLM null-like strings (COR-015).
  function clean(v) {
    if (v == null) return '';
    const s = String(v).trim();
    const low = s.toLowerCase();
    if (['null', 'undefined', 'n/a', 'na', 'none', 'nulo'].includes(low)) return '';
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
  function wireChips(containerId) {
    const c = $(containerId);
    if (!c) return;
    c.addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      c.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
      chip.classList.add('active');
    });
  }
  function chipVal(containerId, attr) {
    const c = $(containerId);
    const a = c ? c.querySelector('.chip.active') : null;
    return a ? a.getAttribute('data-' + attr) : '';
  }

  const TEMPLATE_LABELS = {
    'fluxo-caixa': 'Fluxo de Caixa',
    'crm-clientes': 'Controle de Clientes (CRM)',
    'calendario-editorial': 'Calendário Editorial',
    'financeiro-mei': 'Controle Financeiro (MEI)',
    'metas-kpis': 'Metas e KPIs',
    'estoque': 'Controle de Estoque',
    'lancamento': 'Planejamento de Lançamento',
    'custom': 'Planilha personalizada'
  };
  const CURRENCY = {
    BRL: { sym: 'R$', fmt: '"R$"\\ #,##0.00' },
    USD: { sym: 'US$', fmt: '"US$"\\ #,##0.00' },
    EUR: { sym: '€', fmt: '"€"\\ #,##0.00' }
  };

  function gather() {
    const tpl = chipVal('template-chips', 'tpl') || 'fluxo-caixa';
    return {
      tpl: tpl,
      tplLabel: TEMPLATE_LABELS[tpl] || 'Planilha',
      brief: ($('f-brief').value || '').trim(),
      currency: chipVal('currency-chips', 'cur') || 'BRL',
      period: chipVal('period-chips', 'per') || 'mensal',
      detail: chipVal('detail-chips', 'det') || 'completo'
    };
  }

  // ---------------------------------------------------------------
  // Prompt — asks for a strict workbook JSON. Formulas are expressed with
  // COLUMN-LETTER tokens so THIS code can stamp correct row numbers.
  // ---------------------------------------------------------------
  function buildMessages(spec) {
    const cur = CURRENCY[spec.currency] || CURRENCY.BRL;
    const rows = spec.detail === 'enxuto' ? '6 a 8' : '10 a 14';

    const system =
      'Você é um especialista brasileiro em planilhas de negócio (Excel/Google Sheets). ' +
      'Projeta planilhas práticas, prontas para uso, em português do Brasil. Você devolve ' +
      'SOMENTE um objeto JSON válido (sem markdown, sem cercas de código, sem texto antes ou ' +
      'depois). Use aspas tipográficas (“ ”) dentro dos textos, nunca aspas duplas retas.';

    const schema = [
      'Estrutura EXATA do JSON de saída:',
      '{',
      '  "titulo": "Título curto da planilha (ex.: Fluxo de Caixa — Social Media)",',
      '  "resumo": "uma frase explicando para que serve a planilha",',
      '  "abas": [',
      '    {',
      '      "nome": "Nome da aba (máx. 28 caracteres, sem barra /)",',
      '      "descricao": "1 frase explicando como preencher esta aba",',
      '      "colunas": [',
      '        { "nome": "Data", "tipo": "date" },',
      '        { "nome": "Descrição", "tipo": "text" },',
      '        { "nome": "Receitas", "tipo": "currency" },',
      '        { "nome": "Despesas", "tipo": "currency" },',
      '        { "nome": "Saldo", "tipo": "formula", "formula": "{C}-{D}", "total": "sum" }',
      '      ],',
      '      "linhas": [ ["2026-01-05","Contrato cliente A",2500,300,null], ... ],',
      '      "totalRow": true',
      '    }',
      '  ]',
      '}',
      '',
      'REGRAS OBRIGATÓRIAS:',
      '- "tipo" de cada coluna deve ser um de: "text", "number", "currency", "percent", "date", "formula".',
      '- Para colunas "formula": inclua "formula" com uma expressão usando LETRAS DE COLUNA entre chaves.',
      '  Tokens válidos: {A}..{Z} = célula da MESMA linha naquela coluna; {A_ACIMA} = célula da linha DE CIMA.',
      '  Ex.: saldo do dia = "{C}-{D}"; total = quantidade×preço = "{B}*{C}"; ' +
        'saldo acumulado (running balance) = "formula":"{E_ACIMA}+{C}-{D}" e adicione ' +
        '"formulaFirst":"{C}-{D}" (usado só na primeira linha para não referenciar o cabeçalho).',
      '- NUNCA escreva o sinal "=" nem números de linha nas fórmulas — só as chaves de coluna. O app calcula.',
      '- Em "linhas", cada linha é um array com um valor por coluna, na MESMA ordem das colunas.',
      '  Para colunas do tipo "formula", coloque null (o app preenche a fórmula).',
      '  Valores numéricos são NÚMEROS puros (ex.: 2500.50), sem "R$", sem separador de milhar, ponto decimal.',
      '  Datas no formato ISO "AAAA-MM-DD". Percentuais como fração (ex.: 0.15 para 15%).',
      '- Para somar uma coluna no rodapé, marque "total": "sum" naquela coluna e use "totalRow": true na aba.',
      '  Só marque "sum" em colunas cujo total FAZ SENTIDO (receitas, despesas, quantidades, valores, saldo do mês). ' +
        'NUNCA marque "sum" em colunas de saldo ACUMULADO / running balance (somar saldos acumulados não tem significado).',
      '- Gere ' + rows + ' linhas de EXEMPLO realistas (dados fictícios plausíveis) para o usuário ver o formato.',
      '- Máximo de 8 colunas e 5 abas. SEMPRE inclua uma última aba chamada "Instruções" com 1 coluna ' +
        '"text" e algumas linhas curtas explicando como usar a planilha (sem fórmulas, sem totalRow).',
      '- Moeda: ' + cur.sym + '. Período de referência: ' + spec.period + '.'
    ].join('\n');

    const dados = [
      'Modelo escolhido: ' + spec.tplLabel,
      'Contexto do negócio do usuário: ' + (spec.brief || '(não informado — use um exemplo genérico e útil para o modelo escolhido)'),
      'Nível de detalhe: ' + spec.detail
    ].join('\n');

    const user = schema + '\n\n=== PEDIDO ===\n' + dados +
      '\n\nGere agora a planilha completa como JSON, seguindo exatamente a estrutura e as regras acima.';

    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  // ---------------------------------------------------------------
  // JSON repair ladder (COR-032)
  // ---------------------------------------------------------------
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
  function parseJSON(raw) {
    if (!raw) throw new Error('empty');
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const attempts = [
      function (x) { return x; },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1'); },
      function (x) { return repairQuotes(x); }
    ];
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i](s)); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('parse');
  }

  // ---------------------------------------------------------------
  // LLM call (BYOK) — reroll on parse failure (COR-032), reasoning budget
  // + DeepSeek skip + empty-content retry (COR-034 / COR-035).
  // ---------------------------------------------------------------
  // Map an OpenRouter-prefixed picker id to a native Gemini model name (used only
  // when the member's ONLY key is a Google/Gemini key). Safe fallback: 2.5 Flash.
  function nativeGeminiModel(picked) {
    if (picked === 'google/gemini-2.5-pro') return 'gemini-2.5-pro';
    return 'gemini-2.5-flash';
  }

  function fetchContent(messages, active, temperature, noReasoning) {
    const service = active.service;
    const picked = ApiKeyManager.getModel();

    // ---- Google Gemini (native generateContent) ----
    if (service === 'gemini') {
      const mdl = nativeGeminiModel(picked);
      const sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n\n');
      const userText = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) { return m.content; }).join('\n\n');
      const gbody = {
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: temperature, maxOutputTokens: 12000, thinkingConfig: { thinkingBudget: 0 } }
      };
      if (sys) gbody.systemInstruction = { parts: [{ text: sys }] };
      const gurl = 'https://generativelanguage.googleapis.com/v1beta/models/' + mdl + ':generateContent?key=' + encodeURIComponent(active.key);
      return fetch(gurl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gbody) })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) {
              const m = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status);
              throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
            }
            const cand = data && data.candidates && data.candidates[0];
            const parts = cand && cand.content && cand.content.parts;
            const content = parts ? parts.map(function (p) { return p.text || ''; }).join('') : '';
            if (!content || !content.trim()) {
              const err = new Error('Resposta vazia do modelo (verifique o limite/créditos da sua chave).');
              err.emptyContent = true;
              throw err;
            }
            return content;
          });
        });
    }

    // ---- OpenAI-compatible (OpenRouter / native OpenAI) ----
    let url, headers, mdl;
    const body = { messages: messages, temperature: temperature, max_tokens: 16000 };
    if (service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      mdl = picked;
      headers = {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://planilhasia.appsbrasil.store',
        'X-Title': 'Planilhas IA - Gênesis IA'
      };
      const isDeepSeek = mdl.indexOf('deepseek/') === 0;     // COR-035
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' };  // COR-034
    } else {
      url = 'https://api.openai.com/v1/chat/completions';
      mdl = picked.indexOf('openai/') === 0 ? picked.slice('openai/'.length) : 'gpt-5-mini';
      headers = { 'Authorization': 'Bearer ' + active.key, 'Content-Type': 'application/json' };
    }
    body.model = mdl;

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
            const err = new Error('Resposta vazia do modelo (verifique créditos/limite da sua chave).');
            err.emptyContent = true;
            throw err;
          }
          return content;
        });
      });
  }
  function fetchResilient(messages, active, temperature) {
    return fetchContent(messages, active, temperature, false).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') {
        return fetchContent(messages, active, temperature, true);   // COR-035
      }
      throw e;
    });
  }
  function generateJSON(messages, active) {
    return fetchResilient(messages, active, 0.5).then(function (content) {
      try { return parseJSON(content); }
      catch (e) {
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
  // Formula engine (CSP-safe: NO eval / NO new Function)
  // ---------------------------------------------------------------
  function colLetter(i) {           // 0 -> A, 25 -> Z, 26 -> AA
    let s = '';
    i = i + 1;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  // Expand a formula template into a real Excel formula string for a given Excel row.
  // {C} -> C<row>, {C_ACIMA} -> C<row-1>.
  function expandFormula(tpl, excelRow) {
    return '=' + String(tpl).replace(/\{([A-Z]+)(_ACIMA)?\}/g, function (_, col, above) {
      const r = above ? (excelRow - 1) : excelRow;
      return col + r;
    });
  }

  // Tiny arithmetic evaluator for the PREVIEW value (best-effort). Supports
  // + - * / ( ) and SUM over a numeric list. Tokens already resolved to numbers.
  // .xlsx is the source of truth; the preview value is only a friendly display.
  function evalArith(expr) {
    const raw = expr.match(/\d+\.?\d*|[()+\-*/]/g);
    if (!raw) return NaN;
    // Fold unary +/- (at start, after an operator, or after '(') into a signed number.
    const toks = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (t === '-' || t === '+') {
        const prev = toks.length ? toks[toks.length - 1] : null;
        const unary = prev === null || prev === '(' || prev === '+' || prev === '-' || prev === '*' || prev === '/';
        if (unary) {
          const nxt = raw[i + 1];
          if (nxt && /^\d/.test(nxt)) { toks.push((t === '-' ? -1 : 1) * parseFloat(nxt)); i++; continue; }
          toks.push(0); toks.push(t); continue;   // unary before '(' → 0 ± (...)
        }
      }
      toks.push(/^\d/.test(t) ? parseFloat(t) : t);
    }
    // shunting-yard to RPN
    const out = [], ops = [];
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (typeof t === 'number') out.push(t);
      else if (t === '(') ops.push(t);
      else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()); ops.pop(); }
      else {
        while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop());
        ops.push(t);
      }
    }
    while (ops.length) out.push(ops.pop());
    const st = [];
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      if (typeof t === 'number') st.push(t);
      else { const b = st.pop(), a = st.pop(); st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : (b === 0 ? 0 : a / b)); }
    }
    return st.length ? st[0] : NaN;
  }

  // ---------------------------------------------------------------
  // Normalize the raw LLM JSON into a computed model:
  //   sheets[].cols  = [{name,type,formula?,formulaFirst?,total?}]
  //   sheets[].grid  = 2D array of { raw, display, num, isFormula, xlsxFormula }
  //   sheets[].totalRow (computed) if requested
  // ---------------------------------------------------------------
  function normalize(json, spec) {
    const cur = CURRENCY[spec.currency] || CURRENCY.BRL;
    const abas = Array.isArray(json.abas) ? json.abas.slice(0, 5) : [];
    const sheets = abas.map(function (aba) {
      const cols = (Array.isArray(aba.colunas) ? aba.colunas : []).slice(0, 8).map(function (c) {
        return {
          name: clean(c.nome) || 'Coluna',
          type: (c.tipo || 'text').toLowerCase(),
          formula: c.formula ? String(c.formula) : '',
          formulaFirst: c.formulaFirst ? String(c.formulaFirst) : '',
          total: (c.total || '').toString().toLowerCase() === 'sum' ? 'sum' : ''
        };
      });
      const rawRows = Array.isArray(aba.linhas) ? aba.linhas : [];
      const nData = rawRows.length;
      // computed grid (numeric values cached for {X}/{X_ACIMA} preview resolution)
      const numGrid = [];   // [rowIdx][colIdx] -> number|undefined
      const grid = rawRows.map(function (row, ri) {
        row = Array.isArray(row) ? row : [row];
        const excelRow = ri + 2;              // header = excel row 1
        numGrid[ri] = [];
        return cols.map(function (col, ci) {
          if (col.type === 'formula') {
            const tpl = (ri === 0 && col.formulaFirst) ? col.formulaFirst : (col.formula || '');
            const xlsxFormula = tpl ? expandFormula(tpl, excelRow) : '';
            // preview value: resolve tokens against numGrid, then eval
            let pv = NaN;
            if (tpl) {
              const resolved = tpl.replace(/\{([A-Z]+)(_ACIMA)?\}/g, function (_, c2, above) {
                const cIdx = colRef(c2);
                const rIdx = above ? ri - 1 : ri;
                const v = (numGrid[rIdx] && typeof numGrid[rIdx][cIdx] === 'number') ? numGrid[rIdx][cIdx] : 0;
                return '(' + v + ')';
              });
              pv = evalArith(resolved);
            }
            numGrid[ri][ci] = isFinite(pv) ? pv : undefined;
            return { type: 'formula', num: isFinite(pv) ? pv : null, display: isFinite(pv) ? fmtNum(pv, col.type, cur) : '', xlsxFormula: xlsxFormula };
          } else {
            const raw = row[ci];
            const num = (col.type === 'currency' || col.type === 'number' || col.type === 'percent') ? toNum(raw) : null;
            if (typeof num === 'number') numGrid[ri][ci] = num;
            return { type: col.type, raw: raw, num: num, display: fmtCell(raw, col.type, cur) };
          }
        });
      });
      // totals row
      let totals = null;
      const wantTotal = aba.totalRow === true && cols.some(function (c) { return c.total === 'sum'; });
      if (wantTotal && nData > 0) {
        const excelTotalRow = nData + 2;
        totals = cols.map(function (col, ci) {
          if (col.total === 'sum') {
            const L = colLetter(ci);
            const f = '=SUM(' + L + '2:' + L + (nData + 1) + ')';
            let sum = 0;
            for (let r = 0; r < nData; r++) { const v = numGrid[r][ci]; if (typeof v === 'number') sum += v; }
            return { type: 'formula', num: sum, display: fmtNum(sum, col.type === 'formula' ? 'currency' : col.type, cur), xlsxFormula: f, isTotal: true };
          }
          // label in the first non-sum column
          if (ci === 0) return { type: 'text', raw: 'Total', display: 'Total', isTotal: true };
          return { type: 'text', raw: '', display: '', isTotal: true };
        });
      }
      return {
        name: (clean(aba.nome) || 'Planilha').slice(0, 28),
        descricao: clean(aba.descricao),
        cols: cols, grid: grid, totals: totals, nData: nData
      };
    });
    return {
      titulo: clean(json.titulo) || spec.tplLabel,
      resumo: clean(json.resumo),
      currency: spec.currency, curSym: cur.sym, curFmt: cur.fmt,
      sheets: sheets.filter(function (s) { return s.cols.length; })
    };
  }

  function colRef(letters) {   // 'A' -> 0, 'AA' -> 26
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v == null) return null;
    const s = String(v).replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function fmtNum(n, type, cur) {
    if (!isFinite(n)) return '';
    if (type === 'percent') return (n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    const s = n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (type === 'currency') return cur.sym + ' ' + s;
    return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    return s;
  }
  function fmtCell(raw, type, cur) {
    if (raw == null || String(raw).trim() === '') return '';
    if (type === 'currency' || type === 'number' || type === 'percent') {
      const n = toNum(raw); return n == null ? esc(String(raw)) : fmtNum(n, type, cur);
    }
    if (type === 'date') return fmtDate(raw);
    return String(raw);
  }

  // ---------------------------------------------------------------
  // Render the preview
  // ---------------------------------------------------------------
  function render() {
    const body = $('preview-body');
    if (!model || !model.sheets.length) { renderEmpty(); return; }
    if (activeSheet >= model.sheets.length) activeSheet = 0;

    const tabs = model.sheets.map(function (s, i) {
      return '<button type="button" class="sheet-tab' + (i === activeSheet ? ' active' : '') +
        '" data-sheet="' + i + '"><span class="tab-ico">▤</span>' + esc(s.name) + '</button>';
    }).join('');

    body.innerHTML =
      '<div class="preview-head">' +
        '<div class="wb-title"><h3>' + esc(model.titulo) + '</h3>' +
          '<div class="wb-meta">' + model.sheets.length + ' aba(s) · moeda ' + esc(model.curSym) + ' · fórmulas ativas</div>' +
        '</div>' +
        '<div class="export-actions">' +
          '<button class="btn-export" id="dl-xlsx"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Baixar .xlsx</button>' +
          '<button class="btn-export ghost" id="dl-csv">.CSV (aba)</button>' +
        '</div>' +
      '</div>' +
      '<div class="sheet-tabs">' + tabs + '</div>' +
      renderSheet(model.sheets[activeSheet]);

    // wire tab switching
    body.querySelectorAll('.sheet-tab').forEach(function (t) {
      t.addEventListener('click', function () { activeSheet = parseInt(t.getAttribute('data-sheet'), 10) || 0; render(); });
    });
    const x = $('dl-xlsx'); if (x) x.addEventListener('click', downloadXLSX);
    const c = $('dl-csv'); if (c) c.addEventListener('click', downloadCSV);
  }

  function renderSheet(sheet) {
    const heads = sheet.cols.map(function (c) {
      const f = c.type === 'formula' ? ' <span class="fchip">ƒ</span>' : '';
      return '<th>' + esc(c.name) + f + '</th>';
    }).join('');

    let rowsHtml = sheet.grid.map(function (row, ri) {
      const cells = row.map(function (cell, ci) {
        return cellHtml(cell, sheet.cols[ci]);
      }).join('');
      return '<tr><th class="rownum">' + (ri + 2) + '</th>' + cells + '</tr>';
    }).join('');

    if (sheet.totals) {
      const tcells = sheet.totals.map(function (cell, ci) {
        return cellHtml(cell, sheet.cols[ci], true);
      }).join('');
      rowsHtml += '<tr class="total-row"><th class="rownum">' + (sheet.nData + 2) + '</th>' + tcells + '</tr>';
    }

    const note = sheet.descricao ? '<div class="ledger-note">' + esc(sheet.descricao) + '</div>' : '';
    return '<div class="ledger-scroll">' + note +
      '<table class="ledger"><thead><tr><th class="corner">#</th>' + heads + '</tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></div>';
  }

  function cellHtml(cell, col, isTotal) {
    const type = col ? col.type : 'text';
    const isNum = (type === 'currency' || type === 'number' || type === 'percent' || type === 'formula');
    let cls = isNum ? 'num' : '';
    if (isNum && typeof cell.num === 'number' && cell.num < 0) cls += ' neg';
    const f = (cell.type === 'formula' && cell.xlsxFormula) ? ' <span class="fchip" title="' + esc(cell.xlsxFormula) + '">ƒ</span>' : '';
    const disp = cell.display != null ? cell.display : '';
    return '<td class="' + cls.trim() + '">' + esc(disp) + f + '</td>';
  }

  function renderEmpty() {
    $('preview-body').innerHTML =
      '<div class="preview-empty" id="preview-empty">' +
      '<svg class="big-glyph" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="8" y="6" width="4" height="36" rx="1.5" fill="#8a6d3b"/>' +
      '<circle cx="10" cy="12" r="1.4" fill="#1f3a26"/><circle cx="10" cy="20" r="1.4" fill="#1f3a26"/><circle cx="10" cy="28" r="1.4" fill="#1f3a26"/><circle cx="10" cy="36" r="1.4" fill="#1f3a26"/>' +
      '<rect x="15" y="9" width="26" height="6" rx="1.5" fill="#2f6b43"/>' +
      '<rect x="15" y="18" width="26" height="6" rx="1.5" fill="#d7e6c6"/>' +
      '<rect x="15" y="27" width="26" height="6" rx="1.5" fill="#eef4e4" stroke="#b9cfa4"/>' +
      '<rect x="15" y="36" width="26" height="6" rx="1.5" fill="#d7e6c6"/></svg>' +
      '<h3>Sua planilha aparece aqui</h3><p>Escolha um modelo, ajuste as opções e clique em <strong>Gerar planilha</strong>.</p></div>';
  }

  function setLoading(on, stepMsg) {
    if (on) {
      $('preview-body').innerHTML =
        '<div class="preview-loading"><div class="spinner"></div>' +
        '<h3 style="margin:0;color:var(--ink-soft);font-size:16px;">Montando sua planilha…</h3>' +
        '<div class="step-log" id="step-log">' + esc(stepMsg || 'consultando a IA') + '</div></div>';
    }
    const b = $('generate-btn');
    if (b) {
      b.disabled = on;
      b.querySelector('.btn-text').style.display = on ? 'none' : '';
      b.querySelector('.btn-loading').style.display = on ? '' : 'none';
    }
  }
  function stepLog(msg) { const s = $('step-log'); if (s) s.textContent = msg; }

  // ---------------------------------------------------------------
  // Build the real .xlsx (window.XLSX = xlsx-js-style, CSP-safe)
  // ---------------------------------------------------------------
  const STYLE = {
    header: { font: { bold: true, color: { rgb: 'EEF4E4' }, name: 'Arial', sz: 11 }, fill: { fgColor: { rgb: '1F3A26' } }, alignment: { horizontal: 'left', vertical: 'center' }, border: thin('2C4A34') },
    title:  { font: { bold: true, color: { rgb: '1F3A26' }, sz: 14 } },
    note:   { font: { italic: true, color: { rgb: '6B7565' }, sz: 10 } },
    cellOdd:  { fill: { fgColor: { rgb: 'F3F7EC' } }, border: thin('E3DCC9') },
    cellEven: { fill: { fgColor: { rgb: 'E5EFD6' } }, border: thin('E3DCC9') },
    total:  { font: { bold: true, color: { rgb: '1F3A26' } }, fill: { fgColor: { rgb: 'E7D9B8' } }, border: topThick('1F3A26') }
  };
  function thin(rgb) { const b = { style: 'thin', color: { rgb: rgb } }; return { top: b, bottom: b, left: b, right: b }; }
  function topThick(rgb) { return { top: { style: 'medium', color: { rgb: rgb } }, bottom: { style: 'thin', color: { rgb: 'CFC6AD' } } }; }

  function numFmt(type, cur) {
    if (type === 'currency' || type === 'formula') return cur.fmt;
    if (type === 'percent') return '0.0%';
    if (type === 'number') return '#,##0.##';
    return '';
  }

  function buildWorkbook() {
    const cur = CURRENCY[model.currency] || CURRENCY.BRL;
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    model.sheets.forEach(function (sheet) {
      const aoa = [];
      // row 0 (excel row 1) — headers
      aoa.push(sheet.cols.map(function (c) { return c.name; }));
      // data rows
      sheet.grid.forEach(function (row) {
        aoa.push(row.map(function (cell, ci) {
          const col = sheet.cols[ci];
          if (cell.type === 'formula') return cell.xlsxFormula ? { t: 'n', f: cell.xlsxFormula.slice(1) } : '';
          if (col.type === 'currency' || col.type === 'number' || col.type === 'percent') {
            return typeof cell.num === 'number' ? cell.num : (cell.raw == null ? '' : cell.raw);
          }
          if (col.type === 'date') return fmtDate(cell.raw);
          return cell.raw == null ? '' : String(cell.raw);
        }));
      });
      // totals row
      if (sheet.totals) {
        aoa.push(sheet.totals.map(function (cell) {
          if (cell.type === 'formula' && cell.xlsxFormula) return { t: 'n', f: cell.xlsxFormula.slice(1) };
          return cell.display || '';
        }));
      }

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // column widths
      ws['!cols'] = sheet.cols.map(function (c) {
        const base = c.name.length + 3;
        return { wch: Math.max(12, Math.min(34, base + (c.type === 'text' ? 10 : 2))) };
      });
      // styles + number formats
      const nRows = aoa.length;
      for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < sheet.cols.length; c++) {
          const addr = XLSX.utils.encode_cell({ r: r, c: c });
          const cellObj = ws[addr];
          if (!cellObj) continue;
          const col = sheet.cols[c];
          if (r === 0) { cellObj.s = STYLE.header; continue; }
          const isTotal = sheet.totals && r === nRows - 1;
          const zone = isTotal ? STYLE.total : (r % 2 ? STYLE.cellOdd : STYLE.cellEven);
          cellObj.s = Object.assign({}, zone);
          const nf = numFmt(col.type === 'formula' ? 'formula' : col.type, cur);
          if (nf && (typeof cellObj.v === 'number' || cellObj.f)) { cellObj.z = nf; cellObj.s = Object.assign({}, zone, { alignment: { horizontal: 'right' } }); }
        }
      }
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name));
    });
    return wb;
  }
  function safeSheetName(n) { return (n || 'Planilha').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Planilha'; }

  function downloadXLSX() {
    if (!model) return;
    try {
      const wb = buildWorkbook();
      const fname = slugify(model.titulo) + '.xlsx';
      window.XLSX.writeFile(wb, fname, { compression: true });
      toast('Planilha .xlsx baixada.');
    } catch (e) {
      console.error(e); toast('Não foi possível gerar o .xlsx. Tente novamente.', true);
    }
  }

  function downloadCSV() {
    if (!model || !model.sheets[activeSheet]) return;
    const sheet = model.sheets[activeSheet];
    const lines = [];
    lines.push(sheet.cols.map(function (c) { return csvCell(c.name); }).join(','));
    sheet.grid.forEach(function (row) {
      lines.push(row.map(function (cell, ci) {
        if (cell.type === 'formula') return csvCell(typeof cell.num === 'number' ? cell.num : '');
        const col = sheet.cols[ci];
        if (col.type === 'date') return csvCell(fmtDate(cell.raw));
        if (col.type === 'currency' || col.type === 'number' || col.type === 'percent') return csvCell(typeof cell.num === 'number' ? cell.num : (cell.raw == null ? '' : cell.raw));
        return csvCell(cell.raw == null ? '' : cell.raw);
      }).join(','));
    });
    if (sheet.totals) lines.push(sheet.totals.map(function (cell) { return csvCell(cell.type === 'formula' ? (typeof cell.num === 'number' ? cell.num : '') : (cell.display || '')); }).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = slugify(model.titulo) + '-' + slugify(sheet.name) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('CSV da aba baixado.');
  }
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function slugify(s) {
    return String(s || 'planilha').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'planilha';
  }

  // ---------------------------------------------------------------
  // Generate
  // ---------------------------------------------------------------
  function generate() {
    const active = ApiKeyManager.getActiveKey();
    if (!active) { toast('Configure sua chave de IA primeiro (ícone de chave no topo).', true); MembershipGate.showScreen('key-screen'); return; }
    const spec = gather();
    setLoading(true, 'consultando a IA (' + ApiKeyManager.getModel().split('/').pop() + ')');
    stepLog('a IA está projetando as abas e fórmulas…');

    RateLimiter.executeWithLimit('generate', function () {
      return generateJSON(buildMessages(spec), active);
    }).then(function (json) {
      stepLog('montando a prévia…');
      model = normalize(json, spec);
      if (!model.sheets.length) throw new Error('A planilha veio vazia. Tente novamente.');
      activeSheet = 0;
      render();
      toast('Planilha gerada! Revise e baixe o .xlsx.');
    }).catch(function (e) {
      console.error(e);
      renderEmpty();
      toast(friendlyError(e), true);
    }).finally(function () { setLoading(false); });
  }

  function friendlyError(e) {
    const m = (e && e.message ? e.message : String(e)) || '';
    if (/rate|limit|429/i.test(m)) return 'Muitas requisições. Aguarde um instante e tente de novo.';
    if (/insufficient|quota|billing|credit|exhausted|balance/i.test(m)) return 'Sua conta de IA está sem créditos ou atingiu o limite.';
    if (/401|invalid|unauthor|api key/i.test(m)) return 'Chave de IA inválida. Verifique no ícone de chave.';
    if (/JSON|parse|vazia/i.test(m)) return 'O modelo não devolveu um JSON válido. Tente gerar novamente.';
    return 'Não foi possível gerar a planilha: ' + m;
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function syncName() {
    const s = MembershipGate.getSession && MembershipGate.getSession();
    // header has no name slot in this design — nothing to sync, but keep hook for COR-008
    return s;
  }

  function init() {
    if (inited) { syncName(); return; }
    inited = true;

    ['template-chips', 'currency-chips', 'period-chips', 'detail-chips'].forEach(wireChips);
    if (ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');   // COR-041 (studio)

    const g = $('generate-btn'); if (g) g.addEventListener('click', generate);
    renderEmpty();
    syncName();
  }

  return { init: init };
})();

(function () {
  var done = false;
  function go() { if (done) return; var s = MembershipGate.getSession(); if (s) { done = true; App.init(); } }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 150); });
})();
