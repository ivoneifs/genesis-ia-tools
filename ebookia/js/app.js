/**
 * E-book IA — Main Application Logic
 *
 * Flow: member fills the spec sheet → LLM (BYOK, OpenRouter/OpenAI) returns
 * STRUCTURED JSON → this tool's OWN rendering/pagination engine turns that JSON
 * into a complete, multi-page, self-contained .html e-book (cover + sumário +
 * chapters + CTA page) with @media print page-breaks. Live iframe preview +
 * outline + raw HTML + "Baixar PDF" (print) + "Baixar HTML" download.
 *
 * The deliverable is the FINISHED, distributable e-book — not an outline.
 *
 * BYOK: keys live in localStorage only (api-key-manager.js). No key ever leaves
 * the browser except directly to the chosen provider's API. No company key.
 */

const App = (function() {
  let state = {
    goal: 'Capturar e-mails (lead magnet)',
    chapters: 5,
    tone: 'Didático e claro',
    theme: 'classic',
    data: null,        // last LLM JSON
    html: '',          // last rendered e-book HTML
    tab: 'preview'
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // COR-015: LLM JSON-mode sometimes returns the literal string "null"/"n/a"
  // for absent fields. Normalize null-like values to empty before rendering.
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/?a|nan|-)$/i.test(s)) return '';
    return s;
  }

  function arr(x) { return Array.isArray(x) ? x : []; }

  function toast(msg, isErr) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(function() { t.className = 'toast' + (isErr ? ' err' : ''); }, 3400);
  }

  // ---------- prompt ----------
  function buildPrompt(input) {
    return [
      'Você é um ghostwriter sênior e editor de e-books e iscas digitais (lead magnets) de alta qualidade em português do Brasil.',
      'Gere o CONTEÚDO COMPLETO de um e-book com base na ficha abaixo. O e-book será renderizado em um PDF profissional, então escreva conteúdo REAL e aprofundado — não um esboço, não tópicos soltos.',
      '',
      'FICHA DO E-BOOK:',
      '- Tema/assunto: ' + input.theme,
      '- Público-alvo: ' + (input.audience || 'não informado'),
      '- Autor/marca (capa): ' + (input.author || 'não informado'),
      '- Objetivo da isca: ' + input.goal,
      '- Número de capítulos: ' + input.chapters,
      '- Tom de voz: ' + input.tone,
      '- Chamada final desejada (CTA): ' + (input.cta || 'convidar o leitor para o próximo passo'),
      '',
      'REGRAS DE CONTEÚDO:',
      '- Escreva tudo em português do Brasil, claro, específico e valioso (sem encheção de linguiça, sem clichês genéricos).',
      '- Cada capítulo deve ter de 2 a 4 seções; cada seção com 2 a 4 parágrafos REAIS e bem escritos (3-6 frases cada).',
      '- Use listas (bullets) quando ajudar a clareza, e UMA citação de destaque marcante por capítulo quando fizer sentido.',
      '- Inclua um "keyTakeaway" curto ao final de cada capítulo (1 frase de ação).',
      '- A introdução deve fisgar o leitor e prometer a transformação. A conclusão deve recapitular e preparar para o CTA.',
      '- O CTA final deve ser persuasivo e coerente com o objetivo da isca.',
      '- Gere EXATAMENTE ' + input.chapters + ' capítulos.',
      '- IMPORTANTE (JSON válido): NUNCA use aspas duplas retas dentro do texto dos campos. Se precisar de aspas no conteúdo, use SEMPRE aspas tipográficas (“ ”). As aspas duplas retas só podem delimitar a estrutura JSON. Não use quebras de linha cruas dentro de uma string — separe ideias em itens diferentes do array.',
      '',
      'RESPONDA APENAS com um objeto JSON válido (sem markdown, sem comentários, sem texto fora do JSON), neste formato EXATO:',
      '{',
      '  "meta": {"title": "título do e-book (para a aba/arquivo)"},',
      '  "cover": {"title": "título principal forte", "subtitle": "subtítulo que reforça a promessa", "author": "' + (input.author || 'Autor') + '", "tagline": "uma linha de impacto"},',
      '  "intro": {"heading": "Introdução", "paragraphs": ["parágrafo 1", "parágrafo 2", "parágrafo 3"]},',
      '  "chapters": [',
      '    {"title": "Título do Capítulo", "subtitle": "subtítulo opcional", "sections": [',
      '       {"heading": "Título da seção", "paragraphs": ["parágrafo", "parágrafo"], "bullets": ["item", "item"], "quote": "citação de destaque (ou vazio)"}',
      '    ], "keyTakeaway": "resumo de ação do capítulo"}',
      '  ],',
      '  "conclusion": {"heading": "Conclusão", "paragraphs": ["parágrafo 1", "parágrafo 2"]},',
      '  "cta": {"heading": "Próximo passo", "text": "parágrafo persuasivo chamando para a ação", "action": "' + (clean(input.cta) || 'Dê o próximo passo agora') + '"}',
      '}'
    ].join('\n');
  }

  // ---------- LLM call ----------
  async function callLLM(prompt) {
    const active = ApiKeyManager.getActiveKey();
    if (!active) throw new Error('Nenhuma chave de API configurada. Clique em "Configurar chave".');

    let endpoint, model, headers = { 'Content-Type': 'application/json' };
    const selected = ApiKeyManager.getModel();

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      model = selected;
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'E-book IA';
    } else { // openai native
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = selected.indexOf('openai/') === 0 ? selected.replace('openai/', '') : 'gpt-5.5';
      headers['Authorization'] = 'Bearer ' + active.key;
    }

    // Build the request. LLM JSON validity is stochastic: even with a strong
    // system prompt + the repair ladder below, a rare roll emits JSON that can't
    // be salvaged (an odd stray-quote pattern, etc.). So on a parse failure we
    // reroll ONCE with a stricter reminder + lower temperature — a fresh roll
    // almost always parses where the first didn't. This automates the "tente
    // gerar novamente" so the user never sees an intermittent failure (COR-032).
    const buildBody = function(strict) {
      const messages = [
        { role: 'system', content: 'Você responde SOMENTE com JSON válido, sem markdown e sem texto fora do objeto JSON.' },
        { role: 'user', content: prompt }
      ];
      if (strict) {
        messages.push({ role: 'user', content: 'ATENÇÃO: sua resposta anterior NÃO era um JSON válido. Responda novamente com APENAS o objeto JSON completo e válido — sem markdown, sem comentários, sem texto fora do JSON, e com todas as aspas internas em formato tipográfico (“ ”), nunca aspas duplas retas.' });
      }
      return {
        model: model,
        messages: messages,
        temperature: strict ? 0.4 : 0.75,
        // A full multi-chapter e-book is long — without a generous cap the JSON
        // gets truncated mid-object and fails to parse. 16k covers up to 7 chapters.
        max_tokens: 16000
      };
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
        ? RateLimiter.executeWithLimit('generate-ebook', function(){ return doFetch(strict); })
        : doFetch(strict);
    };

    let content = await exec(false);
    if (!content) throw new Error('Resposta vazia do modelo. Tente outro modelo.');
    try {
      return parseJSON(content);
    } catch (firstErr) {
      // One stochastic reroll with stricter instructions before surfacing an error.
      content = await exec(true);
      if (!content) throw firstErr;
      return parseJSON(content);
    }
  }

  // Robust JSON extraction. LLMs intermittently emit JSON that JSON.parse rejects
  // — most often an UNESCAPED double-quote inside a string value (a straight " in
  // the prose), a raw newline/tab inside a string, or a trailing comma. We try a
  // ladder of increasingly aggressive repairs so a single stray quote never wastes
  // a whole (slow, paid) generation.
  function stripToObject(text) {
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a > -1 && b > -1) t = t.slice(a, b + 1);
    return t;
  }

  // State machine: walk the text and (a) escape raw control chars inside strings,
  // (b) escape stray double-quotes that aren't structural. A '"' inside a string is
  // treated as the closing quote only when the next non-space char is structural
  // (: , } ] or end); otherwise it's content and gets escaped to \".
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
    const attempts = [
      t,
      noTrailComma(t),
      repairJSONStrings(t),
      noTrailComma(repairJSONStrings(t))
    ];
    for (let i = 0; i < attempts.length; i++) {
      try { return JSON.parse(attempts[i]); } catch (e) { /* next */ }
    }
    throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
  }

  // ---------- rendering engine: JSON → full paginated e-book HTML ----------
  // Themes are SELF-CONTAINED (system fonts only — no external font/CSP need).
  function themeCSS(theme) {
    const themes = {
      classic: {
        font: "Georgia, 'Times New Roman', serif",
        headFont: "Georgia, 'Palatino Linotype', serif",
        page: '#fbf7ee', ink: '#2c2418', soft: '#5d5240', accent: '#9c7a2a', rule: '#e0d6c0',
        coverBg: 'linear-gradient(160deg,#2e2417,#1c160d)', coverInk: '#f4ead2', coverAccent: '#c9a24a', center: false
      },
      modern: {
        font: "'Helvetica Neue', Arial, sans-serif",
        headFont: "'Helvetica Neue', Arial, sans-serif",
        page: '#ffffff', ink: '#16202e', soft: '#58617a', accent: '#1f6feb', rule: '#e4e9f0',
        coverBg: 'linear-gradient(160deg,#0f2742,#0a1626)', coverInk: '#eaf2ff', coverAccent: '#5b9bff', center: false
      },
      elegant: {
        font: "'Palatino Linotype', Palatino, Georgia, serif",
        headFont: "'Palatino Linotype', Palatino, Georgia, serif",
        page: '#f6f2ea', ink: '#23201b', soft: '#5a5247', accent: '#a8862f', rule: '#e2d9c8',
        coverBg: 'linear-gradient(160deg,#1a1a1a,#000000)', coverInk: '#f3ecde', coverAccent: '#cda954', center: true
      },
      soft: {
        font: "'Segoe UI', system-ui, sans-serif",
        headFont: "'Segoe UI', system-ui, sans-serif",
        page: '#fbfaf6', ink: '#2a2e2a', soft: '#5c6258', accent: '#5a8f6b', rule: '#e6e8e0',
        coverBg: 'linear-gradient(160deg,#2e4034,#1c2622)', coverInk: '#eef4ee', coverAccent: '#8fc59f', center: true
      }
    };
    const c = themes[theme] || themes.classic;
    const centerHead = c.center ? 'text-align:center;' : '';
    return { c: c, css:
`*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#d9d2c4}
body{font-family:${c.font};color:${c.ink};line-height:1.7;font-size:16px;-webkit-font-smoothing:antialiased}
.page{background:${c.page};max-width:760px;margin:0 auto 26px;padding:64px 70px;box-shadow:0 16px 40px -22px rgba(0,0,0,.5);position:relative;min-height:60vh}
.page:last-child{margin-bottom:0}
h1,h2,h3{font-family:${c.headFont};line-height:1.2;color:${c.ink};${centerHead}}
p{margin:0 0 14px;color:${c.ink}}
.muted{color:${c.soft}}
.rule{height:1px;background:${c.rule};border:0;margin:22px 0}
.cover{background:${c.coverBg};color:${c.coverInk};min-height:88vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:80px 64px}
.cover .kicker{font-size:13px;letter-spacing:.25em;text-transform:uppercase;color:${c.coverAccent};margin-bottom:28px}
.cover h1{font-size:clamp(30px,6vw,52px);color:${c.coverInk};margin-bottom:20px;max-width:14ch}
.cover .sub{font-size:clamp(16px,2.4vw,21px);color:${c.coverInk};opacity:.85;max-width:30ch;margin-bottom:36px}
.cover .frame{width:64px;height:2px;background:${c.coverAccent};margin:0 auto 36px}
.cover .author{font-size:15px;letter-spacing:.04em;color:${c.coverInk};opacity:.9}
.cover .tagline{margin-top:14px;font-size:13px;font-style:italic;color:${c.coverAccent}}
.toc h2{font-size:30px;margin-bottom:28px}
.toc-item{display:flex;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid ${c.rule}}
.toc-num{font-family:${c.headFont};color:${c.accent};font-size:18px;min-width:34px}
.toc-title{font-size:17px;color:${c.ink}}
.toc-dots{flex:1;border-bottom:1px dotted ${c.rule};transform:translateY(-4px)}
.ch-eyebrow{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:${c.accent};margin-bottom:10px}
.ch-title{font-size:clamp(26px,4vw,36px);margin-bottom:8px}
.ch-sub{font-size:17px;color:${c.soft};font-style:italic;margin-bottom:10px}
.ch-head-rule{height:2px;width:56px;background:${c.accent};margin:18px 0 26px}
.sec-title{font-size:21px;margin:26px 0 12px}
ul.bul{margin:6px 0 16px 4px;list-style:none}
ul.bul li{position:relative;padding-left:24px;margin-bottom:8px;color:${c.ink}}
ul.bul li:before{content:'';position:absolute;left:2px;top:11px;width:7px;height:7px;border-radius:50%;background:${c.accent}}
blockquote{margin:20px 0;padding:14px 22px;border-left:3px solid ${c.accent};background:rgba(0,0,0,.025);font-style:italic;font-size:18px;color:${c.ink}}
.takeaway{margin:24px 0 4px;padding:16px 20px;border:1px solid ${c.rule};border-radius:8px;background:rgba(0,0,0,.02)}
.takeaway .lab{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${c.accent};margin-bottom:6px}
.takeaway p{margin:0;font-weight:600}
.cta{text-align:center}
.cta h2{font-size:32px;margin-bottom:18px}
.cta p{max-width:46ch;margin:0 auto 26px;color:${c.soft}}
.cta .action{display:inline-block;background:${c.accent};color:#fff;font-weight:700;font-size:17px;padding:15px 34px;border-radius:8px;text-decoration:none}
.colofon{margin-top:40px;font-size:12px;color:${c.soft};text-align:center}
@page{size:A4;margin:18mm 16mm}
@media print{
  html,body{background:#fff}
  .page{box-shadow:none;margin:0;max-width:none;min-height:auto;padding:0;page-break-after:always}
  .page:last-child{page-break-after:auto}
  .cover{min-height:92vh}
  blockquote,.takeaway{break-inside:avoid}
}` };
  }

  function renderEbook(d, theme) {
    const t = themeCSS(theme);
    const cover = d.cover || {}, intro = d.intro || {}, chapters = arr(d.chapters),
          concl = d.conclusion || {}, cta = d.cta || {};
    const title = clean(d.meta && d.meta.title) || clean(cover.title) || 'E-book';

    function paras(list) { return arr(list).map(function(p){ var c = clean(p); return c ? '<p>' + esc(c) + '</p>' : ''; }).join(''); }

    const coverHtml =
      '<section class="page cover">' +
        '<div class="kicker">E-book</div>' +
        '<h1>' + esc(clean(cover.title) || title) + '</h1>' +
        (clean(cover.subtitle) ? '<div class="sub">' + esc(clean(cover.subtitle)) + '</div>' : '') +
        '<div class="frame"></div>' +
        (clean(cover.author) ? '<div class="author">' + esc(clean(cover.author)) + '</div>' : '') +
        (clean(cover.tagline) ? '<div class="tagline">' + esc(clean(cover.tagline)) + '</div>' : '') +
      '</section>';

    const tocItems = chapters.map(function(ch, i){
      return '<div class="toc-item"><span class="toc-num">' + (i+1) + '</span>' +
        '<span class="toc-title">' + esc(clean(ch.title) || ('Capítulo ' + (i+1))) + '</span>' +
        '<span class="toc-dots"></span></div>';
    }).join('');
    const tocHtml =
      '<section class="page toc"><h2>Sumário</h2>' +
        (clean(intro.heading) ? '<div class="toc-item"><span class="toc-num">—</span><span class="toc-title">' + esc(clean(intro.heading)) + '</span><span class="toc-dots"></span></div>' : '') +
        tocItems +
        (clean(concl.heading) ? '<div class="toc-item"><span class="toc-num">—</span><span class="toc-title">' + esc(clean(concl.heading)) + '</span><span class="toc-dots"></span></div>' : '') +
      '</section>';

    const introHtml = paras(intro.paragraphs) ?
      '<section class="page"><div class="ch-eyebrow">Introdução</div><h2 class="ch-title">' + esc(clean(intro.heading) || 'Introdução') + '</h2><div class="ch-head-rule"></div>' + paras(intro.paragraphs) + '</section>' : '';

    const chHtml = chapters.map(function(ch, i){
      const sections = arr(ch.sections).map(function(s){
        var out = '';
        if (clean(s.heading)) out += '<h3 class="sec-title">' + esc(clean(s.heading)) + '</h3>';
        out += paras(s.paragraphs);
        var bullets = arr(s.bullets).map(function(b){ var c = clean(b); return c ? '<li>' + esc(c) + '</li>' : ''; }).join('');
        if (bullets) out += '<ul class="bul">' + bullets + '</ul>';
        if (clean(s.quote)) out += '<blockquote>' + esc(clean(s.quote)) + '</blockquote>';
        return out;
      }).join('');
      const takeaway = clean(ch.keyTakeaway) ?
        '<div class="takeaway"><div class="lab">Ponto-chave</div><p>' + esc(clean(ch.keyTakeaway)) + '</p></div>' : '';
      return '<section class="page">' +
        '<div class="ch-eyebrow">Capítulo ' + (i+1) + '</div>' +
        '<h2 class="ch-title">' + esc(clean(ch.title) || ('Capítulo ' + (i+1))) + '</h2>' +
        (clean(ch.subtitle) ? '<div class="ch-sub">' + esc(clean(ch.subtitle)) + '</div>' : '') +
        '<div class="ch-head-rule"></div>' + sections + takeaway +
      '</section>';
    }).join('');

    const conclHtml = paras(concl.paragraphs) ?
      '<section class="page"><div class="ch-eyebrow">Para fechar</div><h2 class="ch-title">' + esc(clean(concl.heading) || 'Conclusão') + '</h2><div class="ch-head-rule"></div>' + paras(concl.paragraphs) + '</section>' : '';

    const ctaHtml =
      '<section class="page cta">' +
        '<h2>' + esc(clean(cta.heading) || 'Próximo passo') + '</h2>' +
        (clean(cta.text) ? '<p>' + esc(clean(cta.text)) + '</p>' : '') +
        (clean(cta.action) ? '<span class="action">' + esc(clean(cta.action)) + '</span>' : '') +
        '<div class="colofon">' + esc(clean(cover.author) || 'Gênesis IA') + ' · ' + esc(title) + '</div>' +
      '</section>';

    return '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>' + esc(title) + '</title>\n<style>\n' + t.css + '\n</style>\n</head>\n<body>\n' +
      coverHtml + '\n' + tocHtml + '\n' + introHtml + '\n' + chHtml + '\n' + conclHtml + '\n' + ctaHtml + '\n' +
      '</body>\n</html>';
  }

  // ---------- outline (Sumário tab) ----------
  function renderOutline(d) {
    const chapters = arr(d.chapters);
    const cover = d.cover || {};
    const totalSections = chapters.reduce(function(n, ch){ return n + arr(ch.sections).length; }, 0);

    let html = '<div class="colophon">' +
      '<div class="cell"><span class="k">Título</span><span class="v">' + esc(clean(cover.title) || clean(d.meta && d.meta.title) || 'E-book') + '</span></div>' +
      '<div class="cell"><span class="k">Capítulos</span><span class="v">' + chapters.length + '</span></div>' +
      '<div class="cell"><span class="k">Seções</span><span class="v">' + totalSections + '</span></div>' +
      '<div class="cell"><span class="k">Autor</span><span class="v">' + esc(clean(cover.author) || '—') + '</span></div>' +
      '</div>';

    function block(tag, head, copyText, extra) {
      return '<div class="outline-item"><div class="oi-head"><span class="oi-tag">' + esc(tag) + '</span>' +
        '<button class="oi-copy" data-copy="' + esc(copyText).replace(/"/g, '&quot;') + '">copiar</button></div>' +
        (head ? '<h4>' + esc(head) + '</h4>' : '') + (extra || '') + '</div>';
    }

    const intro = d.intro || {};
    if (arr(intro.paragraphs).length) {
      html += block('Introdução', clean(intro.heading) || 'Introdução',
        [clean(intro.heading)].concat(arr(intro.paragraphs).map(clean)).filter(Boolean).join('\n\n'),
        '<p>' + esc(arr(intro.paragraphs).map(clean).filter(Boolean)[0] || '') + '</p>');
    }

    chapters.forEach(function(ch, i){
      const secList = arr(ch.sections).map(function(s){ return '<div class="ci">' + esc(clean(s.heading) || 'Seção') + '</div>'; }).join('');
      const copyText = ['CAPÍTULO ' + (i+1) + ': ' + (clean(ch.title) || '')]
        .concat(arr(ch.sections).map(function(s){
          return (clean(s.heading) ? '\n## ' + clean(s.heading) + '\n' : '') +
            arr(s.paragraphs).map(clean).filter(Boolean).join('\n') +
            (arr(s.bullets).length ? '\n' + arr(s.bullets).map(function(b){ return '• ' + clean(b); }).join('\n') : '') +
            (clean(s.quote) ? '\n“' + clean(s.quote) + '”' : '');
        }))
        .concat(clean(ch.keyTakeaway) ? ['\nPonto-chave: ' + clean(ch.keyTakeaway)] : [])
        .join('\n');
      html += block('Capítulo ' + (i+1), clean(ch.title) || ('Capítulo ' + (i+1)), copyText,
        (clean(ch.subtitle) ? '<p>' + esc(clean(ch.subtitle)) + '</p>' : '') +
        (secList ? '<div class="ch-list">' + secList + '</div>' : ''));
    });

    const concl = d.conclusion || {};
    if (arr(concl.paragraphs).length) {
      html += block('Conclusão', clean(concl.heading) || 'Conclusão',
        [clean(concl.heading)].concat(arr(concl.paragraphs).map(clean)).filter(Boolean).join('\n\n'));
    }
    const cta = d.cta || {};
    html += block('CTA final', clean(cta.heading) || 'Próximo passo',
      [clean(cta.heading), clean(cta.text), clean(cta.action)].filter(Boolean).join('\n'),
      (clean(cta.text) ? '<p>' + esc(clean(cta.text)) + '</p>' : ''));

    return html;
  }

  // ---------- tabs / states ----------
  function setTab(tab) {
    state.tab = tab;
    ['preview', 'outline', 'code'].forEach(function(t){
      const btn = $('tab-' + t); if (btn) btn.classList.toggle('active', t === tab);
    });
    $('preview-wrap').style.display = tab === 'preview' ? 'flex' : 'none';
    $('outline-wrap').style.display = tab === 'outline' ? 'block' : 'none';
    $('code-wrap').style.display = tab === 'code' ? 'block' : 'none';
  }

  function showState(which) { // empty | loading | result
    $('stage-empty').style.display = which === 'empty' ? 'flex' : 'none';
    $('stage-loading').style.display = which === 'loading' ? 'flex' : 'none';
    if (which === 'result') { setTab(state.tab); }
    else {
      $('preview-wrap').style.display = 'none';
      $('outline-wrap').style.display = 'none';
      $('code-wrap').style.display = 'none';
    }
  }

  function setBusy(b) {
    const btn = $('generate-btn');
    btn.disabled = b;
    btn.querySelector('.btn-text').style.display = b ? 'none' : 'inline';
    btn.querySelector('.btn-loading').style.display = b ? 'inline' : 'none';
  }

  function enableResultButtons(on) {
    ['pdf-btn', 'download-btn', 'copy-html-btn', 'tab-outline', 'tab-code'].forEach(function(id){
      const e = $(id); if (e) e.disabled = !on;
    });
  }

  async function generate() {
    const input = {
      theme: $('f-theme').value.trim(),
      audience: $('f-audience').value.trim(),
      author: $('f-author').value.trim(),
      goal: state.goal,
      chapters: state.chapters,
      tone: state.tone,
      cta: $('f-cta').value.trim()
    };
    if (!input.theme) { toast('Descreva o tema do e-book primeiro.', true); $('f-theme').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) {
      toast('Configure sua chave de API primeiro.', true);
      if (MembershipGate.showScreen) MembershipGate.showScreen('key-screen');
      return;
    }

    setBusy(true);
    enableResultButtons(false);
    showState('loading');
    const steps = ['Estruturando os capítulos...', 'Escrevendo a introdução...', 'Desenvolvendo o conteúdo...', 'Compondo a página de chamada...', 'Paginando e diagramando...'];
    let si = 0; $('loading-step').textContent = steps[0];
    const ticker = setInterval(function(){ si = (si + 1) % steps.length; $('loading-step').textContent = steps[si]; }, 2600);

    try {
      const data = await callLLM(buildPrompt(input));
      clearInterval(ticker);
      if (!arr(data.chapters).length) throw new Error('O modelo não devolveu capítulos. Tente gerar novamente.');
      state.data = data;
      state.html = renderEbook(data, state.theme);

      $('preview-frame').srcdoc = state.html;
      $('outline-wrap').innerHTML = renderOutline(data);
      $('code-pre').textContent = state.html;

      enableResultButtons(true);
      state.tab = 'preview';
      showState('result');
      toast('E-book gerado. Confira a prévia, baixe em PDF ou HTML.');
    } catch (e) {
      clearInterval(ticker);
      showState('empty');
      toast(e.message || 'Falha ao gerar.', true);
    } finally {
      setBusy(false);
    }
  }

  function fileSlug() {
    return ($('f-theme').value.trim().split('\n')[0] || (state.data && state.data.meta && state.data.meta.title) || 'ebook')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'ebook';
  }

  function downloadHTML() {
    if (!state.html) return;
    const blob = new Blob([state.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileSlug() + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    toast('Download iniciado: ' + fileSlug() + '.html');
  }

  function printPDF() {
    if (!state.html) return;
    // Primary: print the preview iframe (isolated, CSP-safe). Fallback: a blob window.
    const frame = $('preview-frame');
    try {
      if (frame && frame.contentWindow) {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        toast('Use "Salvar como PDF" na janela de impressão.');
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      const w = window.open('', '_blank');
      if (w) {
        w.document.open(); w.document.write(state.html); w.document.close();
        setTimeout(function(){ w.focus(); w.print(); }, 400);
        toast('Use "Salvar como PDF" na janela de impressão.');
      } else {
        toast('Não foi possível abrir a impressão. Baixe o HTML e imprima.', true);
      }
    } catch (e2) {
      toast('Não foi possível abrir a impressão. Baixe o HTML e imprima.', true);
    }
  }

  // ---------- wiring ----------
  function wireChips(containerId, dataAttr, onPick) {
    const c = $(containerId); if (!c) return;
    c.addEventListener('click', function(e){
      const chip = e.target.closest('.chip'); if (!chip) return;
      c.querySelectorAll('.chip').forEach(function(x){ x.classList.remove('active'); });
      chip.classList.add('active');
      onPick(chip.getAttribute(dataAttr), chip);
    });
  }

  function wire() {
    wireChips('goal-chips', 'data-goal', function(v){ state.goal = v; });
    wireChips('chapters-chips', 'data-chapters', function(v){ state.chapters = parseInt(v, 10) || 5; });
    wireChips('tone-chips', 'data-tone', function(v){ state.tone = v; });
    wireChips('theme-chips', 'data-theme', function(v){
      state.theme = v;
      if (state.data) {
        state.html = renderEbook(state.data, state.theme);
        $('preview-frame').srcdoc = state.html;
        $('code-pre').textContent = state.html;
        toast('Tema visual aplicado.');
      }
    });

    ['preview', 'outline', 'code'].forEach(function(t){
      $('tab-' + t).addEventListener('click', function(){ if (!$('tab-' + t).disabled) setTab(t); });
    });

    $('outline-wrap').addEventListener('click', function(e){
      const btn = e.target.closest('.oi-copy'); if (!btn) return;
      navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(function(){ toast('Copiado.'); });
    });

    $('copy-html-btn').addEventListener('click', function(){
      if (!state.html) return;
      navigator.clipboard.writeText(state.html).then(function(){ toast('HTML copiado.'); });
    });
    $('download-btn').addEventListener('click', downloadHTML);
    $('pdf-btn').addEventListener('click', printPDF);
    $('generate-btn').addEventListener('click', generate);

    const ok = $('open-keys');
    if (ok) ok.addEventListener('click', function(e){ e.preventDefault(); const mb = $('manage-keys-btn'); if (mb) mb.click(); });
  }

  function init() {
    ApiKeyManager.renderModelPicker('model-select');
    wire();
    enableResultButtons(false);
    showState('empty');
  }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = (window.MembershipGate && MembershipGate.getSession) ? MembershipGate.getSession() : null;
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
