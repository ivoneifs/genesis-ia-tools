/**
 * Quiz IA — Main Application Logic
 *
 * Flow: member fills the briefing → LLM (BYOK, OpenRouter/OpenAI) returns
 * STRUCTURED JSON (intro + scored questions + result profiles + lead copy) →
 * this tool's OWN rendering engine turns that JSON into a complete, responsive,
 * SELF-CONTAINED interactive quiz .html (the real deliverable, not a description):
 * question-by-question flow, progress bar, per-answer scoring that selects a
 * result profile, an embedded lead-capture screen, and a result screen with CTA.
 * Live iframe preview + structure outline + raw HTML + one-click download.
 *
 * BYOK: keys live in localStorage only (api-key-manager.js). No key ever leaves
 * the browser except directly to the chosen provider's API. No company key.
 */

const App = (function() {
  let state = {
    goal: 'Segmentar e qualificar leads',
    tone: 'Direto e profissional',
    theme: 'punch',
    capture: { email: true, phone: true, name: true },
    data: null,        // last LLM JSON (normalized)
    html: '',          // last rendered quiz
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
    setTimeout(function() { t.className = 'toast' + (isErr ? ' err' : ''); }, 3400);
  }

  function arr(x) { return Array.isArray(x) ? x : []; }

  // COR-015: LLM JSON-mode sometimes emits the literal string "null"/"n/a" for
  // absent fields. Normalize null-like strings to '' before rendering.
  function cleanField(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (/^(null|undefined|n\/?a|none|-)$/i.test(s)) return '';
    return s;
  }

  function slugify(s, fallback) {
    const out = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    return out || fallback || 'quiz';
  }

  // ---------- prompt ----------
  function buildPrompt(input) {
    const captureList = [];
    if (input.capture.name) captureList.push('nome');
    if (input.capture.email) captureList.push('e-mail');
    if (input.capture.phone) captureList.push('WhatsApp');
    const ids = [];
    for (let i = 1; i <= input.results; i++) ids.push('r' + i);

    return [
      'Você é um especialista sênior em funis de captura de leads e quizzes interativos de alta conversão em português do Brasil.',
      'Crie a estrutura COMPLETA de um quiz/diagnóstico interativo com base no briefing abaixo.',
      '',
      'BRIEFING:',
      '- Tema do quiz: ' + input.topic,
      '- Público-alvo: ' + (input.audience || 'não informado'),
      '- Objetivo: ' + input.goal,
      '- Contexto da oferta / CTA final: ' + (input.context || 'não informado'),
      '- Tom de voz: ' + input.tone,
      '- Número de perguntas: EXATAMENTE ' + input.count,
      '- Número de perfis de resultado: EXATAMENTE ' + input.results,
      '',
      'REGRAS DE CONTEÚDO:',
      '- Escreva tudo em português do Brasil, claro, específico e envolvente (sem clichês).',
      '- As perguntas devem ser de múltipla escolha, com 3 a 4 alternativas cada.',
      '- Cada alternativa distribui pontos para um ou mais perfis de resultado.',
      '- Os perfis de resultado têm os ids EXATOS: ' + ids.join(', ') + '.',
      '- Em CADA alternativa, "scores" é um objeto que dá pontos (inteiros de 0 a 3) a um ou mais desses ids. Distribua bem os pontos para que cada perfil possa "vencer" dependendo das respostas.',
      '- Os perfis devem ser distintos e cobrir o espectro do público (ex.: iniciante → avançado, ou personas diferentes).',
      '- "recommendation" de cada perfil deve dar um próximo passo concreto e, quando fizer sentido, conectar com a oferta do contexto.',
      '- O "cta" de cada perfil é o texto do botão final (ex.: "Falar no WhatsApp", "Quero a Formação").',
      '',
      'RESPONDA APENAS com um objeto JSON válido (sem markdown, sem comentários, sem texto fora do JSON), neste formato EXATO:',
      '{',
      '  "meta": {"title": "título curto para a aba do navegador"},',
      '  "intro": {"headline": "título forte da tela inicial", "subtext": "1-2 frases que convidam a começar", "cta": "texto do botão de início"},',
      '  "questions": [',
      '    {"text": "enunciado da pergunta?", "options": [',
      '      {"text": "alternativa", "scores": {"' + ids[0] + '": 2}}',
      '    ]}',
      '  ],',
      '  "lead": {"headline": "título da tela de captura", "subtext": "frase curta explicando por que deixar o contato", "button": "texto do botão que revela o resultado"},',
      '  "results": [',
      '    {"id": "' + ids[0] + '", "title": "nome do perfil", "summary": "descrição do perfil em 2-3 frases", "recommendation": "próximo passo concreto", "cta": "texto do botão final"}',
      '  ]',
      '}',
      '',
      'Gere EXATAMENTE ' + input.count + ' perguntas e EXATAMENTE ' + input.results + ' resultados (ids ' + ids.join(', ') + '). A tela de captura pedirá: ' + (captureList.join(', ') || 'nenhum campo') + '.'
    ].join('\n');
  }

  // ---------- LLM call (COR-032: auto-reroll once on parse failure) ----------
  async function callLLM(prompt) {
    const active = ApiKeyManager.getActiveKey();
    if (!active) throw new Error('Nenhuma chave de API configurada. Clique em "Gerenciar chave".');

    let endpoint, model, headers = { 'Content-Type': 'application/json' };
    const selected = ApiKeyManager.getModel();

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      model = selected;
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Quiz IA';
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
        messages.push({ role: 'user', content: 'ATENÇÃO: sua resposta anterior NÃO era um JSON válido. Responda novamente com APENAS o objeto JSON completo e válido — sem markdown, sem comentários, sem texto fora do JSON, e com todas as aspas internas em formato tipográfico (“ ”), nunca aspas duplas retas.' });
      }
      return { model: model, messages: messages, temperature: strict ? 0.4 : 0.8, max_tokens: 9000 };
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
        ? RateLimiter.executeWithLimit('generate-quiz', function() { return doFetch(strict); })
        : doFetch(strict);
    };

    let content = await exec(false);
    if (!content) throw new Error('Resposta vazia do modelo. Tente outro modelo.');
    try {
      return parseJSON(content);
    } catch (firstErr) {
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

  // ---------- normalize the model output into a safe, consistent shape ----------
  function normalize(raw) {
    const d = raw || {};
    const meta = d.meta || {};
    const intro = d.intro || {};
    const lead = d.lead || {};
    const results = arr(d.results).map(function(r, i) {
      return {
        id: cleanField(r && r.id) || ('r' + (i + 1)),
        title: cleanField(r && r.title) || ('Perfil ' + (i + 1)),
        summary: cleanField(r && r.summary),
        recommendation: cleanField(r && r.recommendation),
        cta: cleanField(r && r.cta) || 'Quero saber mais'
      };
    });
    const validIds = {}; results.forEach(function(r) { validIds[r.id] = true; });
    const questions = arr(d.questions).map(function(q) {
      return {
        text: cleanField(q && q.text),
        options: arr(q && q.options).map(function(o) {
          const scores = {};
          const src = (o && o.scores) || {};
          Object.keys(src).forEach(function(k) {
            const val = parseInt(src[k], 10);
            if (validIds[k] && !isNaN(val)) scores[k] = val;
          });
          // if the model gave no valid score, default 1 point to the first result
          if (Object.keys(scores).length === 0 && results[0]) scores[results[0].id] = 1;
          return { text: cleanField(o && o.text), scores: scores };
        }).filter(function(o) { return o.text; })
      };
    }).filter(function(q) { return q.text && q.options.length >= 2; });

    return {
      meta: { title: cleanField(meta.title) || cleanField(intro.headline) || 'Quiz' },
      intro: {
        headline: cleanField(intro.headline) || 'Responda o quiz',
        subtext: cleanField(intro.subtext),
        cta: cleanField(intro.cta) || 'Começar'
      },
      questions: questions,
      lead: {
        headline: cleanField(lead.headline) || 'Quase lá!',
        subtext: cleanField(lead.subtext) || 'Deixe seus dados para ver o seu resultado.',
        button: cleanField(lead.button) || 'Ver meu resultado'
      },
      results: results
    };
  }

  // ====================================================================
  //  RENDERING ENGINE — JSON → self-contained interactive quiz .html
  // ====================================================================
  function themeVars(theme) {
    const T = {
      punch:    { bg:'#f4f3ee', card:'#ffffff', ink:'#0a0a0a', text:'#0a0a0a', muted:'#3a3a3a', accent:'#2b4cff', accent2:'#ffe600', onAccent:'#ffffff', border:'#0a0a0a', bw:'3px', radius:'0px', shadow:'6px 6px 0 #0a0a0a', barTrack:'#e3e1d8', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", display:"'Arial Black','Helvetica Neue',Arial,sans-serif" },
      midnight: { bg:'#0c0d12', card:'#15171f', ink:'#e9ecf5', text:'#e9ecf5', muted:'#9aa3b8', accent:'#6ea8ff', accent2:'#39e6c3', onAccent:'#06121f', border:'#2a2e3c', bw:'1.5px', radius:'16px', shadow:'0 18px 50px -20px rgba(0,0,0,.7)', barTrack:'#23262f', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", display:"'Helvetica Neue',Helvetica,Arial,sans-serif" },
      clean:    { bg:'#f7f9fc', card:'#ffffff', ink:'#0f1726', text:'#0f1726', muted:'#5a6b85', accent:'#2563eb', accent2:'#0ea5e9', onAccent:'#ffffff', border:'#e3e8f0', bw:'1.5px', radius:'18px', shadow:'0 16px 44px -22px rgba(15,23,38,.4)', barTrack:'#e8edf5', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", display:"'Helvetica Neue',Helvetica,Arial,sans-serif" },
      sunset:   { bg:'#1a0e22', card:'#2a1330', ink:'#fdeef2', text:'#fdeef2', muted:'#d3a9c4', accent:'#ff5d8f', accent2:'#ffb454', onAccent:'#2a0a18', border:'#46243f', bw:'1.5px', radius:'20px', shadow:'0 20px 56px -22px rgba(0,0,0,.6)', barTrack:'#3a1c3a', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", display:"'Helvetica Neue',Helvetica,Arial,sans-serif" }
    };
    return T[theme] || T.punch;
  }

  function quizCSS(theme) {
    const c = themeVars(theme);
    const optRadius = c.radius === '0px' ? '0px' : '14px';
    const ctlRadius = c.radius === '0px' ? '0px' : '12px';
    const inpRadius = c.radius === '0px' ? '0px' : '10px';
    return [
      '*{margin:0;padding:0;box-sizing:border-box}',
      'html{-webkit-text-size-adjust:100%}',
      'body{font-family:' + c.font + ';background:' + c.bg + ';color:' + c.text + ';line-height:1.55;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.quiz{width:100%;max-width:620px}',
      '.card{background:' + c.card + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:' + c.radius + ';box-shadow:' + c.shadow + ';padding:34px 30px}',
      '.badge{display:inline-block;background:' + c.accent2 + ';color:' + c.ink + ';font-weight:800;font-size:12px;letter-spacing:.12em;text-transform:uppercase;padding:6px 12px;border-radius:999px;margin-bottom:18px}',
      'h1{font-family:' + c.display + ';font-size:clamp(26px,5.5vw,38px);line-height:1.1;letter-spacing:-.02em;margin-bottom:14px;font-weight:800}',
      'h2{font-size:clamp(20px,4.4vw,27px);line-height:1.2;margin-bottom:20px;font-weight:800}',
      '.sub{color:' + c.muted + ';font-size:17px;margin-bottom:26px}',
      '.progress{height:12px;background:' + c.barTrack + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:999px;overflow:hidden;margin-bottom:8px}',
      '.progress > i{display:block;height:100%;width:0;background:' + c.accent + ';transition:width .3s ease}',
      '.pmeta{font-size:13px;color:' + c.muted + ';font-weight:600;margin-bottom:22px;letter-spacing:.02em}',
      '.opts{display:flex;flex-direction:column;gap:12px}',
      '.opt{display:block;width:100%;text-align:left;background:' + c.card + ';color:' + c.text + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:' + optRadius + ';padding:16px 18px;font-size:16.5px;font-weight:600;cursor:pointer;transition:transform .08s,background .15s,color .15s,box-shadow .08s;font-family:inherit}',
      '.opt:hover{transform:translateY(-2px);background:' + c.accent + ';color:' + c.onAccent + '}',
      '.opt:focus-visible{outline:3px solid ' + c.accent + ';outline-offset:2px}',
      '.btn{display:inline-block;width:100%;text-align:center;background:' + c.accent + ';color:' + c.onAccent + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:' + ctlRadius + ';padding:16px 22px;font-size:18px;font-weight:800;cursor:pointer;text-decoration:none;transition:transform .08s,filter .15s;font-family:inherit}',
      '.btn:hover{transform:translateY(-2px);filter:brightness(1.05)}',
      '.btn.ghost{background:transparent;color:' + c.muted + ';border:none;font-size:14px;font-weight:600;width:auto;padding:10px 4px;text-decoration:underline}',
      '.field{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}',
      '.field label{font-size:13px;font-weight:700;letter-spacing:.02em}',
      '.field input{width:100%;background:' + c.bg + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:' + inpRadius + ';padding:13px 14px;font-size:16px;color:' + c.text + ';font-family:inherit}',
      '.field input:focus{outline:none;border-color:' + c.accent + '}',
      '.err{background:' + c.accent + ';color:' + c.onAccent + ';font-size:14px;font-weight:700;padding:9px 13px;border-radius:8px;margin-bottom:14px;display:none}',
      '.privacy{font-size:12px;color:' + c.muted + ';margin-top:12px;text-align:center}',
      '.result-title{font-family:' + c.display + ';font-size:clamp(26px,5.5vw,38px);margin-bottom:14px}',
      '.rec{background:' + c.bg + ';border:' + c.bw + ' solid ' + c.border + ';border-radius:' + ctlRadius + ';padding:18px;margin:18px 0;font-size:15.5px}',
      '.rec b{display:block;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:' + c.muted + ';margin-bottom:6px}',
      '.fade{animation:fade .35s ease}',
      '@keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.foot{text-align:center;margin-top:18px;font-size:12px;color:' + c.muted + ';opacity:.8}',
      '@media(max-width:600px){.card{padding:24px 18px}}'
    ].join('\n');
  }

  // The quiz runtime — a FIXED engine (reads window.__QUIZ__ / window.__QCFG__).
  // Builds every screen with createElement + textContent (XSS-safe), scores the
  // answers, picks the winning result, and handles the lead-capture step.
  // LEAD_WEBHOOK: the member pastes their own endpoint (n8n / Zapier / Make /
  // Google Apps Script) to receive captured leads. Empty = leads stay in the
  // browser (localStorage) + a 'quiz:lead' event fires, and the result still shows.
  function quizRuntime() {
    return [
"(function(){",
"  var Q=window.__QUIZ__||{},CFG=window.__QCFG__||{capture:['email'],webhook:''};",
"  var LEAD_WEBHOOK=CFG.webhook||''; /* cole aqui (ou em __QCFG__.webhook) seu webhook para receber os leads */",
"  var root=document.getElementById('quiz-root');",
"  var idx=-1, scores={}, answers=[];",
"  (Q.results||[]).forEach(function(r){scores[r.id]=0;});",
"  function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}",
"  function clear(){root.innerHTML='';}",
"  function card(){var c=el('div','card fade');return {c:c};}",
"  function show(node){clear();root.appendChild(node);try{window.scrollTo(0,0);}catch(e){}}",
"  function intro(){var x=card();var i=Q.intro||{};",
"    x.c.appendChild(el('div','badge','Quiz'));",
"    x.c.appendChild(el('h1',null,i.headline||'Responda o quiz'));",
"    if(i.subtext)x.c.appendChild(el('p','sub',i.subtext));",
"    var b=el('button','btn',i.cta||'Começar');b.type='button';b.onclick=function(){idx=0;question();};x.c.appendChild(b);",
"    if((Q.questions||[]).length){x.c.appendChild(el('p','foot',(Q.questions.length)+' perguntas'));}",
"    show(x.c);}",
"  function question(){var qs=Q.questions||[];if(idx>=qs.length){lead();return;}var q=qs[idx];var x=card();",
"    var pct=Math.round((idx)/qs.length*100);",
"    var pr=el('div','progress');var pi=document.createElement('i');pi.style.width=pct+'%';pr.appendChild(pi);x.c.appendChild(pr);",
"    x.c.appendChild(el('div','pmeta','Pergunta '+(idx+1)+' de '+qs.length));",
"    x.c.appendChild(el('h2',null,q.text||''));",
"    var ow=el('div','opts');",
"    (q.options||[]).forEach(function(o){var b=el('button','opt',o.text||'');b.type='button';",
"      b.onclick=function(){var sc=o.scores||{};for(var k in sc){if(scores[k]!=null)scores[k]+=(+sc[k]||0);}answers[idx]=o.text;idx++;question();};ow.appendChild(b);});",
"    x.c.appendChild(ow);",
"    if(idx>0){var back=el('button','btn ghost','‹ Voltar');back.type='button';back.onclick=function(){idx--;question();};x.c.appendChild(back);}",
"    show(x.c);}",
"  function lead(){var caps=CFG.capture||[];if(!caps.length){result();return;}var L=Q.lead||{};var x=card();",
"    var pr=el('div','progress');var pi=document.createElement('i');pi.style.width='100%';pr.appendChild(pi);x.c.appendChild(pr);",
"    x.c.appendChild(el('div','pmeta','Último passo'));",
"    x.c.appendChild(el('h2',null,L.headline||'Quase lá!'));",
"    if(L.subtext)x.c.appendChild(el('p','sub',L.subtext));",
"    var err=el('div','err');x.c.appendChild(err);",
"    var f=document.createElement('form');var inputs={};",
"    var defs={name:['Seu nome','text','name'],email:['Seu melhor e-mail','email','email'],phone:['Seu WhatsApp (com DDD)','tel','tel']};",
"    caps.forEach(function(k){var d=defs[k];if(!d)return;var fl=el('div','field');fl.appendChild(el('label',null,d[0]));var inp=document.createElement('input');inp.type=d[1];inp.autocomplete=d[2];inp.name=k;fl.appendChild(inp);inputs[k]=inp;f.appendChild(fl);});",
"    var sb=el('button','btn',L.button||'Ver meu resultado');sb.type='submit';f.appendChild(sb);",
"    f.onsubmit=function(e){e.preventDefault();var data={};for(var k in inputs)data[k]=(inputs[k].value||'').trim();",
"      if(inputs.email&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(data.email||'')){err.textContent='Digite um e-mail válido.';err.style.display='block';return;}",
"      if(inputs.phone&&(data.phone||'').replace(/\\D/g,'').length<10){err.textContent='Digite um WhatsApp válido com DDD.';err.style.display='block';return;}",
"      if(inputs.name&&!(data.name||'')){err.textContent='Digite seu nome.';err.style.display='block';return;}",
"      submitLead(data);result();};",
"    x.c.appendChild(f);",
"    x.c.appendChild(el('p','privacy','Seus dados são usados apenas para enviar o seu resultado.'));",
"    show(x.c);}",
"  function winner(){var best=null,bv=-1;(Q.results||[]).forEach(function(r){var v=scores[r.id]||0;if(v>bv){bv=v;best=r;}});return best||(Q.results||[])[0];}",
"  function submitLead(data){var w=winner();var payload={lead:data,result:w?w.title:'',result_id:w?w.id:'',scores:scores,answers:answers,quiz:(Q.meta&&Q.meta.title)||'',ts:new Date().toISOString()};",
"    try{var hist=JSON.parse(localStorage.getItem('quiz_leads')||'[]');hist.push(payload);localStorage.setItem('quiz_leads',JSON.stringify(hist).slice(0,500000));}catch(e){}",
"    try{document.dispatchEvent(new CustomEvent('quiz:lead',{detail:payload}));}catch(e){}",
"    if(LEAD_WEBHOOK){try{fetch(LEAD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(function(){});}catch(e){}}}",
"  function result(){var r=winner();var x=card();",
"    x.c.appendChild(el('div','badge','Seu resultado'));",
"    x.c.appendChild(el('h1','result-title',r?r.title:'Resultado'));",
"    if(r&&r.summary)x.c.appendChild(el('p','sub',r.summary));",
"    if(r&&r.recommendation){var rc=el('div','rec');rc.appendChild(el('b',null,'Próximo passo'));rc.appendChild(el('span',null,r.recommendation));x.c.appendChild(rc);}",
"    if(r&&r.cta){var b=el('a','btn',r.cta);b.href=(CFG.ctaUrl||'#');if(CFG.ctaUrl){b.target='_blank';b.rel='noopener';}x.c.appendChild(b);}",
"    var again=el('button','btn ghost','Refazer o quiz');again.type='button';again.onclick=function(){idx=-1;answers=[];for(var k in scores)scores[k]=0;intro();};x.c.appendChild(again);",
"    show(x.c);}",
"  intro();",
"})();"
    ].join("\n");
  }

  function renderQuizHTML(d, theme, capture) {
    const caps = [];
    if (capture.name) caps.push('name');
    if (capture.email) caps.push('email');
    if (capture.phone) caps.push('phone');
    const title = (d.meta && d.meta.title) || 'Quiz';
    const cfg = { capture: caps, webhook: '', ctaUrl: '' };
    // inject data safely inside the <script> (escape </ breakout + unicode line seps)
    const safe = function(obj) {
      return JSON.stringify(obj)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    };
    return '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<style>\n' + quizCSS(theme) + '\n</style>\n</head>\n<body>\n' +
      '<div class="quiz"><div id="quiz-root"></div></div>\n' +
      '<script>window.__QUIZ__=' + safe(d) + ';window.__QCFG__=' + safe(cfg) + ';<\/script>\n' +
      '<script>\n' + quizRuntime() + '\n<\/script>\n' +
      '</body>\n</html>';
  }

  // ---------- outline view ----------
  function renderOutline(d) {
    const blocks = [];
    function item(tag, head, bodyHTML, copyText) {
      blocks.push(
        '<div class="outline-item"><div class="oi-head"><span class="oi-tag">' + esc(tag) + '</span>' +
        '<button class="oi-copy" data-copy="' + esc(copyText).replace(/"/g, '&quot;') + '">copiar</button></div>' +
        '<div class="oi-body">' + (head ? '<h4>' + esc(head) + '</h4>' : '') + (bodyHTML || '') + '</div></div>'
      );
    }
    const intro = d.intro || {};
    item('Abertura', intro.headline, intro.subtext ? '<p>' + esc(intro.subtext) + '</p>' : '',
      [intro.headline, intro.subtext, intro.cta].filter(Boolean).join('\n'));

    arr(d.questions).forEach(function(q, i) {
      const opts = arr(q.options).map(function(o) {
        const tags = Object.keys(o.scores || {}).map(function(k) { return k + '+' + o.scores[k]; }).join(' ');
        return '<div class="opt">• ' + esc(o.text) + (tags ? ' <span style="opacity:.6">[' + esc(tags) + ']</span>' : '') + '</div>';
      }).join('');
      item('Pergunta ' + (i + 1), q.text, opts,
        q.text + '\n' + arr(q.options).map(function(o) { return '- ' + o.text; }).join('\n'));
    });

    const lead = d.lead || {};
    item('Captura de lead', lead.headline, lead.subtext ? '<p>' + esc(lead.subtext) + '</p>' : '',
      [lead.headline, lead.subtext, lead.button].filter(Boolean).join('\n'));

    arr(d.results).forEach(function(r) {
      const body = (r.summary ? '<p>' + esc(r.summary) + '</p>' : '') +
        (r.recommendation ? '<div class="opt">→ ' + esc(r.recommendation) + '</div>' : '') +
        (r.cta ? '<div class="opt" style="opacity:.7">CTA: ' + esc(r.cta) + '</div>' : '');
      item('Resultado · ' + r.id, r.title, body,
        [r.title, r.summary, 'Recomendação: ' + r.recommendation, 'CTA: ' + r.cta].filter(Boolean).join('\n'));
    });
    return blocks.join('');
  }

  // ---------- UI state ----------
  function setTab(tab) {
    state.tab = tab;
    ['preview', 'outline', 'code'].forEach(function(t) {
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
    if (which === 'result') { setTab(state.tab); }
    else {
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
  }

  function renderAll() {
    state.html = renderQuizHTML(state.data, state.theme, state.capture);
    $('preview-frame').srcdoc = state.html;
    $('outline-stage').innerHTML = renderOutline(state.data);
    $('code-pre').textContent = state.html;
  }

  async function generate() {
    const input = {
      topic: $('f-topic').value.trim(),
      audience: $('f-audience').value.trim(),
      goal: state.goal,
      context: $('f-context').value.trim(),
      tone: state.tone,
      count: parseInt($('f-count').value, 10) || 6,
      results: parseInt($('f-results').value, 10) || 4,
      capture: state.capture
    };
    if (!input.topic) { toast('Descreva o tema do quiz para começar.', true); $('f-topic').focus(); return; }
    if (!ApiKeyManager.getActiveKey()) {
      toast('Configure sua chave de API primeiro.', true);
      if (MembershipGate.showScreen) MembershipGate.showScreen('key-screen');
      return;
    }

    setBusy(true);
    showState('loading');
    const steps = ['Estruturando as perguntas...', 'Definindo os perfis de resultado...', 'Calibrando a pontuação...', 'Renderizando o quiz interativo...'];
    let si = 0; $('loading-step').textContent = steps[0];
    const ticker = setInterval(function() { si = (si + 1) % steps.length; $('loading-step').textContent = steps[si]; }, 2300);

    try {
      const data = normalize(await callLLM(buildPrompt(input)));
      clearInterval(ticker);
      if (!data.questions.length || !data.results.length) {
        throw new Error('O modelo não retornou perguntas/resultados suficientes. Tente gerar novamente.');
      }
      state.data = data;
      renderAll();
      ['download-btn', 'copy-html-btn', 'tab-outline', 'tab-code'].forEach(function(id) { $(id).disabled = false; });
      state.tab = 'preview';
      showState('result');
      toast('Quiz gerado! Confira a prévia e baixe o .html.');
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
    const slug = slugify($('f-topic').value.trim() || 'quiz', 'quiz');
    const blob = new Blob([state.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = slug + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    toast('Download iniciado: ' + slug + '.html');
  }

  function setViewport(vp) {
    state.viewport = vp;
    $('preview-frame-wrap').classList.toggle('mobile', vp === 'mobile');
    document.querySelectorAll('#viewport-toggle button').forEach(function(b) { b.classList.toggle('active', b.dataset.vp === vp); });
  }

  // ---------- wiring ----------
  function singleChip(groupId, attr, apply) {
    const group = $(groupId);
    if (!group) return;
    group.addEventListener('click', function(e) {
      const c = e.target.closest('.chip'); if (!c) return;
      group.querySelectorAll('.chip').forEach(function(x) { x.classList.remove('active'); });
      c.classList.add('active');
      apply(c.dataset[attr], c.textContent);
    });
  }

  function wire() {
    singleChip('goal-chips', 'goal', function(v) { state.goal = v; });
    singleChip('tone-chips', 'tone', function(v) { state.tone = v; });
    singleChip('theme-chips', 'theme', function(v, label) {
      state.theme = v;
      if (state.data) { renderAll(); toast('Estilo aplicado: ' + label); }
    });

    // multi-select capture chips
    $('capture-chips').addEventListener('click', function(e) {
      const c = e.target.closest('.chip'); if (!c) return;
      const k = c.dataset.capture;
      const on = !c.classList.contains('active');
      // keep at least one capture field on
      if (!on && Object.values(state.capture).filter(Boolean).length <= 1) {
        toast('Mantenha ao menos um campo de captura.', true); return;
      }
      c.classList.toggle('active', on);
      state.capture[k] = on;
      if (state.data) renderAll();
    });

    ['preview', 'outline', 'code'].forEach(function(t) {
      $('tab-' + t).addEventListener('click', function() { if (!$('tab-' + t).disabled) setTab(t); });
    });
    document.querySelectorAll('#viewport-toggle button').forEach(function(b) {
      b.addEventListener('click', function() { setViewport(b.dataset.vp); });
    });
    $('outline-stage').addEventListener('click', function(e) {
      const btn = e.target.closest('.oi-copy'); if (!btn) return;
      navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(function() { toast('Copiado.'); });
    });
    $('copy-html-btn').addEventListener('click', function() {
      if (!state.html) return;
      navigator.clipboard.writeText(state.html).then(function() { toast('HTML copiado.'); });
    });
    $('download-btn').addEventListener('click', download);
    $('generate-btn').addEventListener('click', generate);
    const ok = $('open-keys');
    if (ok) ok.addEventListener('click', function(e) { e.preventDefault(); const mb = $('manage-keys-btn'); if (mb) mb.click(); });
  }

  function init() {
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
    var session = (window.MembershipGate && MembershipGate.getSession && MembershipGate.getSession());
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
