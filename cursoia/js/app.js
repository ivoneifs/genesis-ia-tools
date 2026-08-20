/**
 * Estrutura de Curso IA — Main Application Logic
 *
 * Flow: the member describes a course idea + audience/level/format/duration;
 * the request is sent to the member's OWN AI key (BYOK — OpenAI / OpenRouter)
 * which returns a structured course curriculum in pt-BR, rendered as a
 * "growing" botanical structure (modules as stems, lessons as leaf nodes).
 *
 * No backend of ours is involved in the generation. Membership/feedback/deletion
 * go through n8n (standard modules). The AI call goes straight to the provider
 * with the user's key, which never leaves the browser.
 */

const App = (function() {
  var _wired = false;
  var _lastResult = null;
  var _lastInputs = null;

  // ---- COR-015: LLM "optional" fields can come back as the literal string "null" ----
  function cleanField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    var low = s.toLowerCase();
    if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' ||
        low === '-' || low === '—' || low === '') return '';
    return s;
  }
  function cleanList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(cleanField).filter(function(x) { return x !== ''; });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function $(id) { return document.getElementById(id); }

  function setStatus(html) {
    var el = $('gen-status');
    if (!el) return;
    if (html) { el.innerHTML = html; el.classList.add('active'); }
    else { el.innerHTML = ''; el.classList.remove('active'); }
  }
  function showError(msg) {
    var el = $('gen-error');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }
  function setLoading(on) {
    var btn = $('generate-btn');
    if (!btn) return;
    btn.disabled = on;
    var t = btn.querySelector('.btn-text');
    var l = btn.querySelector('.btn-loading');
    if (t) t.style.display = on ? 'none' : 'inline';
    if (l) l.style.display = on ? 'inline' : 'none';
  }

  // ---- BYOK AI call (OpenAI-compatible chat completions) ----
  async function callAI(active, inputs) {
    var endpoint, model, headers = { 'Content-Type': 'application/json' };
    var deep = inputs.depth === 'deep';

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = 'Bearer ' + active.key;
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Estrutura de Curso IA';
      model = deep ? 'openai/gpt-4o' : 'openai/gpt-4o-mini';
    } else { // openai
      endpoint = 'https://api.openai.com/v1/chat/completions';
      headers['Authorization'] = 'Bearer ' + active.key;
      model = deep ? 'gpt-4o' : 'gpt-4o-mini';
    }

    var sys = [
      'Você é um designer instrucional sênior, especialista em criar cursos que vendem e que entregam transformação real, em português do Brasil.',
      'A partir da ideia do usuário, você projeta uma ESTRUTURA DE CURSO completa, coerente e progressiva (cada módulo constrói sobre o anterior).',
      'Regras: seja concreto e específico ao tema; títulos de aula devem ser acionáveis (o que o aluno aprende a fazer), não genéricos.',
      'NUNCA invente preços, números de matrículas ou promessas de resultado garantido. Quando um campo opcional não se aplicar, retorne string vazia "" — nunca escreva "null".',
      'Responda ESTRITAMENTE em JSON válido no schema pedido, sem texto fora do JSON.'
    ].join(' ');

    var modCount = inputs.modulesCount === 'auto'
      ? 'Escolha você o número de módulos (geralmente entre 5 e 9), conforme o escopo.'
      : 'Crie EXATAMENTE ' + inputs.modulesCount + ' módulos.';

    var schema = [
      'Schema JSON (todas as chaves obrigatórias; listas podem ser vazias):',
      '{',
      '  "titulo": "título comercial e atraente do curso",',
      '  "subtitulo": "subtítulo de uma linha que reforça a transformação",',
      '  "promessa": "1-3 frases: a transformação/promessa central do curso",',
      '  "publico_alvo": "para quem é este curso",',
      '  "nivel": "nível do curso",',
      '  "duracao_total": "duração total estimada (ex.: 6 semanas, 8h de vídeo)",',
      '  "pre_requisitos": ["o que o aluno precisa saber/ter antes de começar"],',
      '  "resultados_aprendizagem": ["ao final, o aluno será capaz de... (verbos de ação)"],',
      '  "modulos": [',
      '    {',
      '      "titulo": "título do módulo",',
      '      "objetivo": "o que este módulo entrega (1 frase)",',
      '      "duracao": "duração estimada do módulo (ex.: 45 min, 1 semana) ou \\"\\"",',
      '      "aulas": ["título acionável da aula 1", "aula 2", "..."],',
      '      "pratica": "atividade prática / exercício de aplicação do módulo ou \\"\\""',
      '    }',
      '  ],',
      '  "projeto_final": "descrição do projeto final/capstone que consolida o aprendizado",',
      '  "bonus": ["ideias de bônus / materiais extras que aumentam o valor percebido"]',
      '}'
    ].join('\n');

    var userParts = [];
    userParts.push('TEMA / IDEIA DO CURSO: ' + inputs.topic);
    if (inputs.audience) userParts.push('PÚBLICO-ALVO: ' + inputs.audience);
    userParts.push('NÍVEL: ' + inputs.level);
    userParts.push('FORMATO: ' + inputs.format);
    if (inputs.duration) userParts.push('DURAÇÃO TOTAL DESEJADA: ' + inputs.duration);
    userParts.push('NÚMERO DE MÓDULOS: ' + modCount);
    if (inputs.extra) userParts.push('OBSERVAÇÕES DO CRIADOR: ' + inputs.extra);
    userParts.push(schema);

    var body = {
      model: model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userParts.join('\n\n') }
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' }
    };

    var resp = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var detail = '';
      try { var ej = await resp.json(); detail = (ej.error && ej.error.message) || ''; } catch (e) {}
      var err = new Error('ai_' + resp.status);
      err.detail = detail;
      err.httpStatus = resp.status;
      throw err;
    }
    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('ai_empty');
    var parsed;
    try { parsed = JSON.parse(content); }
    catch (e) {
      var m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('ai_parse');
      parsed = JSON.parse(m[0]);
    }
    return parsed;
  }

  // ---- main action ----
  async function generate() {
    showError('');

    var topic = cleanField($('topic') ? $('topic').value : '');
    if (!topic || topic.length < 8) {
      showError('Descreva o tema/ideia do curso com um pouco mais de detalhe (mínimo ~8 caracteres).');
      return;
    }

    var active = window.ApiKeyManager ? window.ApiKeyManager.getActiveKey() : null;
    if (!active) {
      showError('Configure sua chave de API (OpenAI ou OpenRouter) no ícone de chave no topo para gerar a estrutura.');
      return;
    }

    var inputs = {
      topic: topic,
      audience: cleanField($('audience') ? $('audience').value : ''),
      level: ($('level') ? $('level').value : 'iniciante'),
      format: ($('format') ? $('format').value : ''),
      modulesCount: ($('modules-count') ? $('modules-count').value : 'auto'),
      duration: cleanField($('duration') ? $('duration').value : ''),
      depth: ($('depth') ? $('depth').value : 'balanced'),
      extra: cleanField($('extra') ? $('extra').value : '')
    };
    _lastInputs = inputs;

    setLoading(true);
    setStatus('A IA está cultivando a estrutura do seu curso<span class="blink">_</span>');

    try {
      var run = function() { return callAI(active, inputs); };
      var result = window.RateLimiter
        ? await window.RateLimiter.executeWithLimit('generate', run)
        : await run();

      _lastResult = result;
      render(result);
      setStatus('');
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setStatus('');
      handleAIError(err);
    }
  }

  function handleAIError(err) {
    var msg = String(err && err.message || '');
    if (err && err.isRateLimit) {
      showError('Você atingiu o limite de uso por minuto/hora. Aguarde um pouco e tente novamente.');
      return;
    }
    if (msg.indexOf('ai_401') === 0 || err.httpStatus === 401) {
      showError('Chave de API inválida ou sem permissão. Confira sua chave no ícone de chave no topo.');
      return;
    }
    if (msg.indexOf('ai_429') === 0 || err.httpStatus === 429) {
      showError('O provedor de IA recusou por excesso de requisições ou saldo insuficiente. Tente novamente em instantes.');
      return;
    }
    if (msg.indexOf('ai_') === 0) {
      showError('A IA retornou um erro' + (err.detail ? ': ' + err.detail : '') + '. Tente novamente.');
      return;
    }
    showError('Não foi possível gerar a estrutura. Verifique sua conexão e tente novamente.');
  }

  // ---- rendering ----
  function chipsHtml(items) {
    var arr = cleanList(items);
    if (!arr.length) return '<p class="empty-note">—</p>';
    return '<div class="chip-row">' + arr.map(function(x) {
      return '<span class="chip">' + esc(x) + '</span>';
    }).join('') + '</div>';
  }
  function bulletsHtml(items, dark) {
    var arr = cleanList(items);
    if (!arr.length) return '<p class="empty-note">—</p>';
    return '<ul class="bullet-list">' + arr.map(function(x) {
      return '<li>' + esc(x) + '</li>';
    }).join('') + '</ul>';
  }

  function moduleHtml(m, i) {
    var titulo = esc(cleanField(m && m.titulo) || ('Módulo ' + (i + 1)));
    var objetivo = cleanField(m && m.objetivo);
    var dur = cleanField(m && m.duracao);
    var aulas = cleanList(m && m.aulas);
    var pratica = cleanField(m && m.pratica);

    var aulasHtml = aulas.length
      ? '<ul class="lessons">' + aulas.map(function(a, j) {
          return '<li><span class="lesson-n">' + (i + 1) + '.' + (j + 1) + '</span>' + esc(a) + '</li>';
        }).join('') + '</ul>'
      : '<p class="empty-note">Aulas a definir.</p>';

    var praticaHtml = pratica
      ? '<div class="practice"><span class="micro">Prática</span>' + esc(pratica) + '</div>'
      : '';

    return '<article class="module">' +
      '<div class="module-head">' +
        '<span class="module-num">MÓD ' + String(i + 1).padStart(2, '0') + '</span>' +
        '<h3>' + titulo + '</h3>' +
        (dur ? '<span class="module-dur">' + esc(dur) + '</span>' : '') +
      '</div>' +
      (objetivo ? '<p class="module-goal">' + esc(objetivo) + '</p>' : '') +
      aulasHtml +
      praticaHtml +
    '</article>';
  }

  function render(r) {
    var titulo = cleanField(r.titulo) || 'Seu curso';
    var html = '';

    // title block
    html += '<div class="course-title">' +
      '<h2>' + esc(titulo) + '</h2>' +
      (cleanField(r.subtitulo) ? '<p class="course-sub">' + esc(r.subtitulo) + '</p>' : '') +
      (cleanField(r.promessa) ? '<p class="course-promise">' + esc(r.promessa) + '</p>' : '') +
    '</div>';

    // meta strip
    var metaBits = [];
    if (cleanField(r.publico_alvo)) metaBits.push('<span>Público · <b>' + esc(r.publico_alvo) + '</b></span>');
    if (cleanField(r.nivel)) metaBits.push('<span>Nível · <b>' + esc(r.nivel) + '</b></span>');
    if (cleanField(r.duracao_total)) metaBits.push('<span>Duração · <b>' + esc(r.duracao_total) + '</b></span>');
    var mods = Array.isArray(r.modulos) ? r.modulos.length : 0;
    if (mods) metaBits.push('<span>Módulos · <b>' + mods + '</b></span>');
    if (metaBits.length) html += '<div class="meta-strip">' + metaBits.join('') + '</div>';

    // pre-reqs + outcomes
    html += '<div class="info-section"><h3>Pré-requisitos</h3>' + chipsHtml(r.pre_requisitos) + '</div>';
    html += '<div class="info-section"><h3>Resultados de aprendizagem</h3>' + bulletsHtml(r.resultados_aprendizagem) + '</div>';

    // modules — the growing structure
    if (Array.isArray(r.modulos) && r.modulos.length) {
      html += '<div class="modules"><h3>Grade do curso</h3><div class="modules-stem">' +
        r.modulos.map(moduleHtml).join('') +
      '</div></div>';
    } else {
      html += '<div class="modules"><h3>Grade do curso</h3><p class="empty-note">Nenhum módulo retornado. Tente gerar novamente com um tema mais detalhado.</p></div>';
    }

    // capstone + bonus
    if (cleanField(r.projeto_final) || cleanList(r.bonus).length) {
      html += '<div class="capstone">';
      if (cleanField(r.projeto_final)) {
        html += '<span class="micro">Projeto final</span><h3>Consolide tudo na prática</h3>' +
          '<p>' + esc(r.projeto_final) + '</p>';
      }
      if (cleanList(r.bonus).length) {
        html += '<span class="micro" style="display:block;margin-top:1.2rem;">Ideias de bônus</span>' +
          bulletsHtml(r.bonus, true);
      }
      html += '</div>';
    }

    $('result-body').innerHTML = html;
    var meta = $('result-meta');
    if (meta) meta.textContent = 'Estrutura — ' + titulo;
    var res = $('result');
    res.classList.add('active');
    res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- export (markdown) ----
  function toMarkdown(r) {
    function bullets(arr) {
      var a = cleanList(arr);
      return a.length ? a.map(function(x) { return '- ' + x; }).join('\n') : '_—_';
    }
    var lines = [];
    var titulo = cleanField(r.titulo) || 'Curso';
    lines.push('# ' + titulo);
    if (cleanField(r.subtitulo)) lines.push('*' + cleanField(r.subtitulo) + '*');
    lines.push('');
    if (cleanField(r.promessa)) { lines.push(cleanField(r.promessa)); lines.push(''); }

    var meta = [];
    if (cleanField(r.publico_alvo)) meta.push('**Público:** ' + cleanField(r.publico_alvo));
    if (cleanField(r.nivel)) meta.push('**Nível:** ' + cleanField(r.nivel));
    if (cleanField(r.duracao_total)) meta.push('**Duração:** ' + cleanField(r.duracao_total));
    if (meta.length) { lines.push(meta.join('  ·  ')); lines.push(''); }

    lines.push('## Pré-requisitos'); lines.push(bullets(r.pre_requisitos)); lines.push('');
    lines.push('## Resultados de aprendizagem'); lines.push(bullets(r.resultados_aprendizagem)); lines.push('');

    lines.push('## Grade do curso'); lines.push('');
    if (Array.isArray(r.modulos)) {
      r.modulos.forEach(function(m, i) {
        var t = cleanField(m && m.titulo) || ('Módulo ' + (i + 1));
        var dur = cleanField(m && m.duracao);
        lines.push('### Módulo ' + (i + 1) + ' — ' + t + (dur ? ' (' + dur + ')' : ''));
        if (cleanField(m && m.objetivo)) lines.push('_' + cleanField(m.objetivo) + '_');
        var aulas = cleanList(m && m.aulas);
        aulas.forEach(function(a, j) { lines.push((i + 1) + '.' + (j + 1) + ' ' + a); });
        if (cleanField(m && m.pratica)) lines.push('', '**Prática:** ' + cleanField(m.pratica));
        lines.push('');
      });
    }

    if (cleanField(r.projeto_final)) { lines.push('## Projeto final'); lines.push(cleanField(r.projeto_final)); lines.push(''); }
    if (cleanList(r.bonus).length) { lines.push('## Ideias de bônus'); lines.push(bullets(r.bonus)); lines.push(''); }

    lines.push('---');
    lines.push('_Gerado com Estrutura de Curso IA — Gênesis IA_');
    return lines.join('\n');
  }

  function copyResult() {
    if (!_lastResult) return;
    var md = toMarkdown(_lastResult);
    navigator.clipboard.writeText(md).then(function() {
      var btn = $('copy-btn'); if (!btn) return;
      var old = btn.textContent; btn.textContent = 'Copiado!';
      setTimeout(function() { btn.textContent = old; }, 1600);
    });
  }

  function downloadResult() {
    if (!_lastResult) return;
    var md = toMarkdown(_lastResult);
    var slug = (cleanField(_lastResult.titulo) || 'curso').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'curso-' + (slug || 'estrutura') + '.md';
    document.body.appendChild(a); a.click();
    setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function resetForm() {
    _lastResult = null; _lastInputs = null;
    $('result').classList.remove('active');
    $('result-body').innerHTML = '';
    ['topic', 'audience', 'duration', 'extra'].forEach(function(id) { if ($(id)) $(id).value = ''; });
    showError(''); setStatus('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wire() {
    if (_wired) return;
    _wired = true;
    var gb = $('generate-btn'); if (gb) gb.addEventListener('click', generate);
    var cb = $('copy-btn'); if (cb) cb.addEventListener('click', copyResult);
    var db = $('download-btn'); if (db) db.addEventListener('click', downloadResult);
    var pb = $('print-btn'); if (pb) pb.addEventListener('click', function() { window.print(); });
    var rb = $('reset-btn'); if (rb) rb.addEventListener('click', resetForm);
  }

  function init() {
    wire();
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) {
      var nameEl = $('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
  }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (!session) return;
    if (!_appInitialized) { _appInitialized = true; App.init(); }
    else {
      // re-sync member name on every app-ready (COR-008)
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() { setTimeout(tryAppInit, 150); });
})();
