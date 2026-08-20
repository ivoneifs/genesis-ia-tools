/**
 * Página de Vendas IA — Main Application Logic
 *
 * Flow: member fills the spec sheet → LLM (BYOK, OpenRouter/OpenAI) returns
 * STRUCTURED JSON → this tool's OWN rendering engine turns that JSON into a
 * complete, responsive, self-contained .html sales page (the real deliverable,
 * not a description). Live iframe preview + section outline + raw HTML + download.
 *
 * BYOK: keys live in localStorage only (api-key-manager.js). No key ever leaves
 * the browser except directly to the chosen provider's API. No company key.
 */

const App = (function() {
  let state = {
    tone: 'Persuasivo e direto',
    theme: 'bold',
    data: null,        // last LLM JSON
    html: '',          // last rendered page
    tab: 'preview',
    viewport: 'desktop'
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, isErr) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(function() { t.className = 'toast' + (isErr ? ' err' : ''); }, 3200);
  }

  function arr(x) { return Array.isArray(x) ? x : []; }

  // ---------- prompt ----------
  function buildPrompt(input) {
    return [
      'Você é um copywriter sênior de resposta direta e especialista em páginas de vendas (landing pages) de alta conversão em português do Brasil.',
      'Gere a estrutura COMPLETA de copy para uma página de vendas com base nos dados abaixo.',
      '',
      'DADOS DO PRODUTO:',
      '- Produto/oferta: ' + input.product,
      '- Descrição: ' + input.desc,
      '- Público-alvo: ' + (input.audience || 'não informado'),
      '- Preço/oferta: ' + (input.price || 'não informado'),
      '- Transformação/benefício principal: ' + (input.benefit || 'não informado'),
      '- Tom de voz: ' + input.tone,
      '',
      'REGRAS:',
      '- Escreva tudo em português do Brasil, persuasivo, concreto e específico (sem clichês genéricos).',
      '- Headlines curtas e fortes. Bullets focados em benefício, não em recurso.',
      '- Se faltar informação, crie conteúdo plausível e coerente com o produto.',
      '- Crie 3 a 5 depoimentos realistas (nomes brasileiros, sem prometer nada ilegal).',
      '- Crie 4 a 6 FAQs reais que quebram objeções de compra.',
      '',
      'RESPONDA APENAS com um objeto JSON válido (sem markdown, sem comentários), neste formato EXATO:',
      '{',
      '  "meta": {"title": "título da aba do navegador"},',
      '  "hero": {"eyebrow": "linha curta acima do título", "headline": "título principal forte", "subheadline": "subtítulo 1-2 frases", "cta": "texto do botão"},',
      '  "pain": {"title": "título da seção de dor", "bullets": ["dor 1", "dor 2", "dor 3", "dor 4"]},',
      '  "solution": {"title": "título da solução", "paragraphs": ["parágrafo 1", "parágrafo 2"]},',
      '  "benefits": {"title": "título", "items": [{"title": "benefício", "description": "explicação curta"}]},',
      '  "how": {"title": "como funciona", "steps": [{"title": "passo", "description": "explicação"}]},',
      '  "testimonials": {"title": "título", "items": [{"name": "Nome", "role": "cargo/contexto", "text": "depoimento"}]},',
      '  "offer": {"title": "título da oferta", "price": "' + (input.price || 'R$ ...') + '", "installments": "ex: ou 12x de R$ ...", "bonuses": ["bônus 1", "bônus 2"], "guarantee": "garantia", "cta": "texto do botão"},',
      '  "faq": {"title": "Perguntas frequentes", "items": [{"q": "pergunta", "a": "resposta"}]},',
      '  "finalCta": {"headline": "chamada final", "subtext": "reforço", "cta": "texto do botão"}',
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
      headers['X-Title'] = 'Pagina de Vendas IA';
    } else { // openai native
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = selected.indexOf('openai/') === 0 ? selected.replace('openai/', '') : 'gpt-5.5';
      headers['Authorization'] = 'Bearer ' + active.key;
    }

    const body = {
      model: model,
      messages: [
        { role: 'system', content: 'Você responde SOMENTE com JSON válido, sem markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8
    };

    const doFetch = async function() {
      const res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
      if (!res.ok) {
        let detail = '';
        try { const e = await res.json(); detail = (e.error && e.error.message) || ''; } catch (_) {}
        if (res.status === 401) throw new Error('Chave de API inválida ou sem créditos.');
        throw new Error('Erro do provedor (' + res.status + '). ' + detail);
      }
      const json = await res.json();
      return json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    };

    let content;
    if (window.RateLimiter && typeof RateLimiter.executeWithLimit === 'function') {
      content = await RateLimiter.executeWithLimit('generate-page', doFetch);
    } else {
      content = await doFetch();
    }
    if (!content) throw new Error('Resposta vazia do modelo. Tente outro modelo.');
    return parseJSON(content);
  }

  function parseJSON(text) {
    let t = String(text).trim();
    // strip code fences
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first > -1 && last > -1) t = t.slice(first, last + 1);
    try { return JSON.parse(t); }
    catch (e) { throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.'); }
  }

  // ---------- rendering engine: JSON → full sales page HTML ----------
  function themeCSS(theme) {
    const themes = {
      bold: { bg:'#0b0e16', surf:'#141926', text:'#eef2f8', muted:'#9aa6bd', accent:'#5b8cff', accent2:'#7c5bff', cta:'linear-gradient(135deg,#5b8cff,#7c5bff)', ctaText:'#fff', card:'#171d2c', border:'rgba(255,255,255,.08)' },
      clean: { bg:'#ffffff', surf:'#f6f8fc', text:'#0f1726', muted:'#5a6b85', accent:'#2563eb', accent2:'#1d4ed8', cta:'linear-gradient(135deg,#2563eb,#1d4ed8)', ctaText:'#fff', card:'#ffffff', border:'rgba(15,23,38,.1)' },
      gold: { bg:'#0c0a07', surf:'#16120b', text:'#f5efe6', muted:'#b9a98c', accent:'#e0b450', accent2:'#caa13c', cta:'linear-gradient(135deg,#e0b450,#caa13c)', ctaText:'#1a1206', card:'#1b160d', border:'rgba(224,180,80,.18)' },
      vibrant: { bg:'#0d0820', surf:'#1a1138', text:'#f4f0ff', muted:'#b3a6d9', accent:'#ff4d8d', accent2:'#7c3aed', cta:'linear-gradient(135deg,#ff4d8d,#7c3aed)', ctaText:'#fff', card:'#1f1542', border:'rgba(255,255,255,.1)' }
    };
    const c = themes[theme] || themes.bold;
    return { c: c, css:
`*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:${c.bg};color:${c.text};line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:0 24px}
section{padding:72px 0}
h1,h2,h3{line-height:1.15;letter-spacing:-.02em}
h1{font-size:clamp(32px,6vw,56px);font-weight:800}
h2{font-size:clamp(26px,4vw,40px);font-weight:800;margin-bottom:32px;text-align:center}
p{color:${c.muted}}
.eyebrow{display:inline-block;color:${c.accent};font-weight:700;font-size:14px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:18px}
.cta{display:inline-block;background:${c.cta};color:${c.ctaText};text-decoration:none;font-weight:800;font-size:18px;padding:18px 40px;border-radius:12px;border:none;cursor:pointer;box-shadow:0 14px 40px -12px ${c.accent};transition:transform .15s,filter .15s}
.cta:hover{transform:translateY(-2px);filter:brightness(1.06)}
.hero{text-align:center;padding-top:96px;background:radial-gradient(ellipse at top,${c.surf} 0%,${c.bg} 70%)}
.hero h1{margin-bottom:22px}
.hero .sub{font-size:clamp(17px,2.4vw,21px);max-width:680px;margin:0 auto 38px}
.pain{background:${c.surf}}
.pain ul{max-width:620px;margin:0 auto;list-style:none;display:grid;gap:16px}
.pain li{background:${c.card};border:1px solid ${c.border};border-radius:12px;padding:18px 22px;font-size:17px;position:relative;padding-left:52px}
.pain li:before{content:'✕';position:absolute;left:20px;top:18px;color:${c.accent};font-weight:800}
.solution p{font-size:18px;max-width:680px;margin:0 auto 18px;text-align:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;max-width:880px;margin:0 auto}
.card{background:${c.card};border:1px solid ${c.border};border-radius:14px;padding:28px}
.card h3{font-size:20px;font-weight:700;margin-bottom:10px;color:${c.text}}
.card p{font-size:15.5px}
.steps{counter-reset:s;max-width:680px;margin:0 auto;display:grid;gap:18px}
.step{background:${c.card};border:1px solid ${c.border};border-radius:12px;padding:22px 22px 22px 70px;position:relative}
.step:before{counter-increment:s;content:counter(s);position:absolute;left:20px;top:20px;width:34px;height:34px;border-radius:50%;background:${c.cta};color:${c.ctaText};display:flex;align-items:center;justify-content:center;font-weight:800}
.step h3{font-size:18px;margin-bottom:6px;color:${c.text}}
.tst{background:${c.surf}}
.tst .grid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.tst .card p{font-style:italic;color:${c.text};font-size:16px;margin-bottom:14px}
.tst .who{font-weight:700;color:${c.accent};font-size:14px}
.tst .role{color:${c.muted};font-size:13px}
.offer{text-align:center}
.offer-box{max-width:560px;margin:0 auto;background:${c.card};border:2px solid ${c.accent};border-radius:20px;padding:44px 32px;box-shadow:0 30px 80px -30px ${c.accent}}
.price{font-size:clamp(40px,8vw,64px);font-weight:900;color:${c.text};margin:8px 0}
.installments{color:${c.muted};font-size:17px;margin-bottom:24px}
.bonuses{list-style:none;text-align:left;max-width:420px;margin:0 auto 26px;display:grid;gap:12px}
.bonuses li{padding-left:32px;position:relative;color:${c.text};font-size:16px}
.bonuses li:before{content:'✓';position:absolute;left:0;color:${c.accent};font-weight:900}
.guarantee{margin-top:22px;font-size:14px;color:${c.muted}}
.faq{max-width:720px;margin:0 auto}
.faq details{background:${c.card};border:1px solid ${c.border};border-radius:12px;padding:18px 22px;margin-bottom:12px}
.faq summary{cursor:pointer;font-weight:700;font-size:17px;color:${c.text};list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary:after{content:'+';float:right;color:${c.accent};font-weight:800}
.faq details[open] summary:after{content:'−'}
.faq p{margin-top:12px;font-size:15.5px}
.final{text-align:center;background:radial-gradient(ellipse at bottom,${c.surf} 0%,${c.bg} 70%)}
.final h2{margin-bottom:16px}
.final p{font-size:18px;max-width:560px;margin:0 auto 32px}
footer{text-align:center;padding:40px 24px;color:${c.muted};font-size:13px;border-top:1px solid ${c.border}}
@media(max-width:600px){section{padding:52px 0}.hero{padding-top:64px}.cta{width:100%}}` };
  }

  function renderSalesPage(d, theme) {
    const t = themeCSS(theme);
    const h = d.hero || {}, pain = d.pain || {}, sol = d.solution || {}, ben = d.benefits || {},
          how = d.how || {}, tst = d.testimonials || {}, off = d.offer || {}, faq = d.faq || {}, fin = d.finalCta || {};
    const title = (d.meta && d.meta.title) || h.headline || 'Página de Vendas';

    const painLis = arr(pain.bullets).map(function(b){ return '<li>' + esc(b) + '</li>'; }).join('');
    const solP = arr(sol.paragraphs).map(function(p){ return '<p>' + esc(p) + '</p>'; }).join('');
    const benCards = arr(ben.items).map(function(i){ return '<div class="card"><h3>' + esc(i.title) + '</h3><p>' + esc(i.description) + '</p></div>'; }).join('');
    const steps = arr(how.steps).map(function(s){ return '<div class="step"><h3>' + esc(s.title) + '</h3><p>' + esc(s.description) + '</p></div>'; }).join('');
    const tsts = arr(tst.items).map(function(i){ return '<div class="card"><p>“' + esc(i.text) + '”</p><div class="who">' + esc(i.name) + '</div><div class="role">' + esc(i.role) + '</div></div>'; }).join('');
    const bonuses = arr(off.bonuses).map(function(b){ return '<li>' + esc(b) + '</li>'; }).join('');
    const faqs = arr(faq.items).map(function(i){ return '<details><summary>' + esc(i.q) + '</summary><p>' + esc(i.a) + '</p></details>'; }).join('');

    function sec(cond, html) { return cond ? html : ''; }

    return '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">\n' +
      '<style>\n' + t.css + '\n</style>\n</head>\n<body>\n' +

      '<section class="hero"><div class="wrap">' +
        sec(h.eyebrow, '<span class="eyebrow">' + esc(h.eyebrow) + '</span>') +
        '<h1>' + esc(h.headline || title) + '</h1>' +
        sec(h.subheadline, '<p class="sub">' + esc(h.subheadline) + '</p>') +
        '<a href="#oferta" class="cta">' + esc(h.cta || 'Quero garantir agora') + '</a>' +
      '</div></section>\n' +

      sec(painLis, '<section class="pain"><div class="wrap"><h2>' + esc(pain.title || 'Você se identifica?') + '</h2><ul>' + painLis + '</ul></div></section>\n') +

      sec(solP, '<section class="solution"><div class="wrap"><h2>' + esc(sol.title || 'A solução') + '</h2>' + solP + '</div></section>\n') +

      sec(benCards, '<section class="benefits"><div class="wrap"><h2>' + esc(ben.title || 'O que você ganha') + '</h2><div class="grid">' + benCards + '</div></div></section>\n') +

      sec(steps, '<section class="how"><div class="wrap"><h2>' + esc(how.title || 'Como funciona') + '</h2><div class="steps">' + steps + '</div></div></section>\n') +

      sec(tsts, '<section class="tst"><div class="wrap"><h2>' + esc(tst.title || 'Quem já usou') + '</h2><div class="grid">' + tsts + '</div></div></section>\n') +

      '<section class="offer" id="oferta"><div class="wrap"><h2>' + esc(off.title || 'A oferta') + '</h2>' +
        '<div class="offer-box">' +
          '<div class="price">' + esc(off.price || '') + '</div>' +
          sec(off.installments, '<div class="installments">' + esc(off.installments) + '</div>') +
          sec(bonuses, '<ul class="bonuses">' + bonuses + '</ul>') +
          '<a href="#" class="cta">' + esc(off.cta || 'Quero me inscrever') + '</a>' +
          sec(off.guarantee, '<div class="guarantee">' + esc(off.guarantee) + '</div>') +
        '</div>' +
      '</div></section>\n' +

      sec(faqs, '<section class="faq-sec"><div class="wrap faq"><h2>' + esc(faq.title || 'Perguntas frequentes') + '</h2>' + faqs + '</div></section>\n') +

      '<section class="final"><div class="wrap">' +
        '<h2>' + esc(fin.headline || 'Pronto para começar?') + '</h2>' +
        sec(fin.subtext, '<p>' + esc(fin.subtext) + '</p>') +
        '<a href="#oferta" class="cta">' + esc(fin.cta || off.cta || 'Garantir minha vaga') + '</a>' +
      '</div></section>\n' +

      '<footer>© ' + new Date().getFullYear() + ' · ' + esc(title) + '</footer>\n' +
      '</body>\n</html>';
  }

  // ---------- outline view ----------
  function renderOutline(d) {
    const blocks = [];
    function push(tag, head, body, copyText) {
      blocks.push(
        '<div class="outline-item"><div class="oi-head"><span class="oi-tag">' + esc(tag) + '</span>' +
        '<button class="oi-copy" data-copy="' + esc(copyText).replace(/"/g,'&quot;') + '">copiar</button></div>' +
        (head ? '<h4>' + esc(head) + '</h4>' : '') +
        (body ? '<p>' + esc(body) + '</p>' : '') + '</div>'
      );
    }
    const h = d.hero||{}, off = d.offer||{}, fin = d.finalCta||{};
    push('Hero', h.headline, h.subheadline, [h.eyebrow, h.headline, h.subheadline, h.cta].filter(Boolean).join('\n'));
    if (d.pain) push('Dor', d.pain.title, arr(d.pain.bullets).join(' · '), [d.pain.title].concat(arr(d.pain.bullets)).join('\n'));
    if (d.solution) push('Solução', d.solution.title, arr(d.solution.paragraphs).join(' '), [d.solution.title].concat(arr(d.solution.paragraphs)).join('\n'));
    if (d.benefits) push('Benefícios', d.benefits.title, arr(d.benefits.items).map(function(i){return i.title;}).join(' · '), arr(d.benefits.items).map(function(i){return '• '+i.title+': '+i.description;}).join('\n'));
    if (d.how) push('Como funciona', d.how.title, arr(d.how.steps).map(function(s){return s.title;}).join(' → '), arr(d.how.steps).map(function(s,n){return (n+1)+'. '+s.title+': '+s.description;}).join('\n'));
    if (d.testimonials) push('Depoimentos', d.testimonials.title, arr(d.testimonials.items).length + ' depoimentos', arr(d.testimonials.items).map(function(i){return '“'+i.text+'” — '+i.name+', '+i.role;}).join('\n\n'));
    push('Oferta', off.title, [off.price, off.installments].filter(Boolean).join(' '), [off.title, off.price, off.installments].concat(arr(off.bonuses)).concat([off.guarantee, off.cta]).filter(Boolean).join('\n'));
    if (d.faq) push('FAQ', d.faq.title, arr(d.faq.items).length + ' perguntas', arr(d.faq.items).map(function(i){return 'P: '+i.q+'\nR: '+i.a;}).join('\n\n'));
    push('CTA final', fin.headline, fin.subtext, [fin.headline, fin.subtext, fin.cta].filter(Boolean).join('\n'));
    return blocks.join('');
  }

  // ---------- UI wiring ----------
  function setTab(tab) {
    state.tab = tab;
    ['preview','outline','code'].forEach(function(t) {
      const btn = $('tab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    $('preview-stage').style.display = tab === 'preview' ? 'flex' : 'none';
    $('outline-stage').style.display = tab === 'outline' ? 'block' : 'none';
    $('code-stage').style.display = tab === 'code' ? 'block' : 'none';
    $('viewport-toggle').style.display = tab === 'preview' ? 'flex' : 'none';
  }

  function showState(which) { // empty | loading | result
    $('board-empty').style.display = which === 'empty' ? 'flex' : 'none';
    $('board-loading').style.display = which === 'loading' ? 'flex' : 'none';
    const showResult = which === 'result';
    if (showResult) setTab(state.tab); else {
      $('preview-stage').style.display = 'none';
      $('outline-stage').style.display = 'none';
      $('code-stage').style.display = 'none';
      $('viewport-toggle').style.display = 'none';
    }
  }

  function setBusy(b) {
    const btn = $('generate-btn');
    btn.disabled = b;
    btn.querySelector('.btn-text').style.display = b ? 'none' : 'inline';
    btn.querySelector('.btn-loading').style.display = b ? 'inline' : 'none';
    ['download-btn','copy-html-btn','tab-outline','tab-code'].forEach(function(id){ const e=$(id); if(e) e.disabled = b ? true : e.disabled; });
  }

  async function generate() {
    const input = {
      product: $('f-product').value.trim(),
      desc: $('f-desc').value.trim(),
      audience: $('f-audience').value.trim(),
      price: $('f-price').value.trim(),
      benefit: $('f-benefit').value.trim(),
      tone: state.tone
    };
    if (!input.product || !input.desc) { toast('Preencha ao menos o nome e a descrição do produto.', true); return; }
    if (!ApiKeyManager.getActiveKey()) { toast('Configure sua chave de API primeiro.', true); MembershipGate.showScreen && MembershipGate.showScreen('key-screen'); return; }

    setBusy(true);
    showState('loading');
    const steps = ['Estruturando a copy por seção...', 'Escrevendo headline e oferta...', 'Renderizando a página responsiva...'];
    let si = 0; $('loading-step').textContent = steps[0];
    const ticker = setInterval(function(){ si = (si+1) % steps.length; $('loading-step').textContent = steps[si]; }, 2500);

    try {
      const data = await callLLM(buildPrompt(input));
      clearInterval(ticker);
      state.data = data;
      state.html = renderSalesPage(data, state.theme);

      // preview
      $('preview-frame').srcdoc = state.html;
      // outline
      $('outline-stage').innerHTML = renderOutline(data);
      // code
      $('code-pre').textContent = state.html;

      ['download-btn','copy-html-btn','tab-outline','tab-code'].forEach(function(id){ $(id).disabled = false; });
      state.tab = 'preview';
      showState('result');
      toast('Página gerada. Confira a prévia e baixe o .html.');
    } catch (e) {
      clearInterval(ticker);
      showState('empty');
      toast(e.message || 'Falha ao gerar.', true);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!state.html) return;
    const slug = ($('f-product').value.trim() || 'pagina-de-vendas')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50) || 'pagina-de-vendas';
    const blob = new Blob([state.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = slug + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    toast('Download iniciado: ' + slug + '.html');
  }

  function setViewport(vp) {
    state.viewport = vp;
    $('preview-frame-wrap').classList.toggle('mobile', vp === 'mobile');
    document.querySelectorAll('#viewport-toggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.vp === vp); });
  }

  function wire() {
    // tone chips
    $('tone-chips').addEventListener('click', function(e){
      const c = e.target.closest('.chip'); if (!c) return;
      $('tone-chips').querySelectorAll('.chip').forEach(function(x){ x.classList.remove('active'); });
      c.classList.add('active'); state.tone = c.dataset.tone;
    });
    // theme chips — re-render preview live if data exists
    $('theme-chips').addEventListener('click', function(e){
      const c = e.target.closest('.chip'); if (!c) return;
      $('theme-chips').querySelectorAll('.chip').forEach(function(x){ x.classList.remove('active'); });
      c.classList.add('active'); state.theme = c.dataset.theme;
      if (state.data) {
        state.html = renderSalesPage(state.data, state.theme);
        $('preview-frame').srcdoc = state.html;
        $('code-pre').textContent = state.html;
        toast('Estilo aplicado: ' + c.textContent);
      }
    });
    // tabs
    ['preview','outline','code'].forEach(function(t){
      $('tab-' + t).addEventListener('click', function(){ if (!$('tab-'+t).disabled) setTab(t); });
    });
    // viewport
    document.querySelectorAll('#viewport-toggle button').forEach(function(b){
      b.addEventListener('click', function(){ setViewport(b.dataset.vp); });
    });
    // outline copy (delegated)
    $('outline-stage').addEventListener('click', function(e){
      const btn = e.target.closest('.oi-copy'); if (!btn) return;
      navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(function(){ toast('Copiado.'); });
    });
    // copy full html
    $('copy-html-btn').addEventListener('click', function(){
      if (!state.html) return;
      navigator.clipboard.writeText(state.html).then(function(){ toast('HTML copiado.'); });
    });
    // download + generate
    $('download-btn').addEventListener('click', download);
    $('generate-btn').addEventListener('click', generate);
    // open keys link
    const ok = $('open-keys');
    if (ok) ok.addEventListener('click', function(e){ e.preventDefault(); const mb = $('manage-keys-btn'); if (mb) mb.click(); });
  }

  function init() {
    const session = MembershipGate.getSession();
    if (session) {
      const nameEl = $('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
      const rev = $('user-name-rev');
      if (rev) rev.textContent = 'REV // ' + (session.name ? session.name.split(' ')[0] : 'maestro').toUpperCase();
    }
    ApiKeyManager.renderModelPicker('model-select');
    wire();
    showState('empty');
  }

  return { init: init };
})();

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
