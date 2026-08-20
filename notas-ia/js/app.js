/**
 * Notas IA — Main Application Logic
 *
 * Meeting Notes Summarizer. The member pastes a transcript or raw notes,
 * picks a context, and the BYOK-configured AI returns a structured JSON
 * payload: summary, decisions, action items, open questions, next steps.
 *
 * AI calls are routed through OpenAI-compatible chat completions endpoints
 * (OpenAI direct or OpenRouter). Keys live in localStorage only — never
 * touch our backend. Every call is wrapped in RateLimiter.executeWithLimit.
 */

const App = (function() {
  var _initialized = false;
  var _generating = false;

  var CONTEXT_HINTS = {
    generic: 'reunião geral de trabalho',
    planning: 'reunião de planejamento ou sprint planning (foco em escopo, prioridades e datas)',
    client: 'reunião com cliente externo (foco em pedidos, próximos entregáveis e expectativas)',
    '1on1': 'conversa 1:1 ou mentoria (foco em desenvolvimento, bloqueios pessoais e combinados)',
    standup: 'daily/standup (foco em status, blockers e o que cada pessoa fará hoje)',
    retro: 'retrospectiva (foco em o que foi bem, o que não foi e ações de melhoria)',
    decision: 'comitê ou reunião de decisão (foco nas decisões formais tomadas e seus responsáveis)',
    interview: 'entrevista (foco no perfil do candidato, sinais positivos/negativos e próximos passos)'
  };

  // ============================================================
  // Element refs
  // ============================================================
  var els = {};
  function refs() {
    els.transcript = document.getElementById('transcript-input');
    els.charCount = document.getElementById('transcript-count');
    els.title = document.getElementById('meeting-title');
    els.context = document.getElementById('meeting-context');
    els.generate = document.getElementById('generate-btn');
    els.clear = document.getElementById('clear-btn');
    els.loading = document.getElementById('loading-block');
    els.error = document.getElementById('generate-error');
    els.output = document.getElementById('output-area');
    els.outputMeta = document.getElementById('output-meta');
    els.summary = document.getElementById('summary-body');
    els.decisions = document.getElementById('decisions-list');
    els.actions = document.getElementById('actions-list');
    els.questions = document.getElementById('questions-list');
    els.next = document.getElementById('next-body');
    els.noKey = document.getElementById('no-key-warning');
    els.openKeysLink = document.getElementById('open-keys-link');
    els.copyMd = document.getElementById('copy-md-btn');
    els.copyTxt = document.getElementById('copy-txt-btn');
    els.download = document.getElementById('download-btn');
    els.print = document.getElementById('print-btn');
  }

  function countWords(text) {
    var trimmed = (text || '').trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function updateCharCount() {
    if (!els.transcript || !els.charCount) return;
    var text = els.transcript.value || '';
    els.charCount.textContent = text.length + ' caracteres · ' + countWords(text) + ' palavras';
  }

  function refreshNoKeyWarning() {
    if (!els.noKey || !window.ApiKeyManager) return;
    if (ApiKeyManager.hasRequiredKeys()) {
      els.noKey.classList.remove('active');
    } else {
      els.noKey.classList.add('active');
    }
  }

  // ============================================================
  // AI call (OpenAI-compatible chat completions)
  // ============================================================
  function endpointFor(service) {
    if (service === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    return 'https://api.openai.com/v1/chat/completions';
  }

  function modelFor(service) {
    if (service === 'openrouter') return 'openai/gpt-4o-mini';
    return 'gpt-4o-mini';
  }

  function buildSystemPrompt(contextHint) {
    return [
      'Você é um analista de reuniões. Recebe a transcrição (ou anotações soltas) de uma reunião e extrai um RESUMO ESTRUTURADO em português do Brasil.',
      '',
      'Contexto da reunião: ' + contextHint + '.',
      '',
      'Regras OBRIGATÓRIAS:',
      '1. NÃO INVENTE INFORMAÇÃO. Se algo não está claro na transcrição, omita ou marque como "[não mencionado]".',
      '2. Use APENAS o que está no texto. Não acrescente conselhos genéricos nem suposições.',
      '3. Linguagem objetiva, executiva, direta. Português do Brasil. Sem floreios.',
      '4. Itens de ação devem ter responsável e prazo SOMENTE quando mencionados — se não houver, use null.',
      '5. Se o texto for muito curto ou irrelevante (ex: "oi, tudo bem?"), retorne um JSON com summary explicando isso e listas vazias.',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes ou depois, sem cercas markdown) com esta estrutura:',
      '{',
      '  "summary": "Resumo executivo em 2 a 4 frases.",',
      '  "decisions": ["Decisão 1.", "Decisão 2."],',
      '  "actions": [',
      '    {"task": "...", "owner": "Nome ou null", "due": "ex: até sexta, 30/05, ou null"}',
      '  ],',
      '  "open_questions": ["Pergunta/bloqueio em aberto"],',
      '  "next_steps": "Próximos passos em 1 a 3 frases.",',
      '  "participants": ["Nome 1", "Nome 2"]',
      '}',
      '',
      'Se uma seção não tiver conteúdo na reunião, retorne lista vazia [] (não invente).'
    ].join('\n');
  }

  function buildUserPrompt(title, transcript) {
    var head = title ? 'TÍTULO DA REUNIÃO: ' + title + '\n\n' : '';
    return head + 'TRANSCRIÇÃO OU ANOTAÇÕES:\n\n' + transcript;
  }

  async function callAI(activeKey, transcript, title, contextKey) {
    var endpoint = endpointFor(activeKey.service);
    var model = modelFor(activeKey.service);
    var hint = CONTEXT_HINTS[contextKey] || CONTEXT_HINTS.generic;

    var body = {
      model: model,
      messages: [
        { role: 'system', content: buildSystemPrompt(hint) },
        { role: 'user', content: buildUserPrompt(title, transcript) }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    };

    var headers = {
      'Authorization': 'Bearer ' + activeKey.key,
      'Content-Type': 'application/json'
    };

    if (activeKey.service === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      // OpenRouter X-Title header must be ASCII / ISO-8859-1 (no em-dash etc).
      headers['X-Title'] = 'Notas IA - Gênesis IA';
    }

    var resp = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      var errText = '';
      try { errText = await resp.text(); } catch {}
      var msg = 'Falha na API (' + resp.status + ').';
      try {
        var parsed = JSON.parse(errText);
        if (parsed.error && parsed.error.message) msg = parsed.error.message;
      } catch {}
      var err = new Error(msg);
      err.status = resp.status;
      throw err;
    }

    var data = await resp.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!content) throw new Error('Resposta vazia da API.');

    // Some providers wrap JSON in ```json fences even with response_format set
    var cleaned = String(content).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      throw new Error('A IA retornou um JSON inválido. Tente novamente.');
    }
  }

  // ============================================================
  // Rendering
  // ============================================================
  function renderMetaStrip(transcript, parsed) {
    if (!els.outputMeta) return;
    var words = countWords(transcript);
    var minutes = Math.max(1, Math.round(words / 130));
    var nDec = (parsed.decisions || []).length;
    var nAct = (parsed.actions || []).length;
    var nQ = (parsed.open_questions || []).length;
    var nP = (parsed.participants || []).length;
    var date = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    els.outputMeta.innerHTML =
      '<span class="num">' + date.toUpperCase() + '</span>' +
      '<span class="sep">/</span>' +
      '<span>~' + minutes + ' MIN · ' + words + ' PALAVRAS</span>' +
      '<span class="sep">/</span>' +
      '<span>' + nDec + ' DECISÕES · ' + nAct + ' AÇÕES · ' + nQ + ' EM ABERTO · ' + nP + ' PARTICIPANTES</span>' +
      '<span class="meta-tail"></span>';
  }

  function showSection(id, show) {
    var el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // The model sometimes emits the literal strings "null"/"undefined"/"-" for an
  // absent owner or deadline instead of JSON null. Treat those as empty.
  function cleanField(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (!s || /^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }

  function renderSummary(text) {
    if (!els.summary) return;
    var safe = escapeHTML(text || '');
    var paras = safe.split(/\n{2,}/).map(function(p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
    els.summary.innerHTML = paras;
  }

  function renderNext(text) {
    if (!els.next) return;
    var safe = escapeHTML(text || '');
    var paras = safe.split(/\n{2,}/).map(function(p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
    els.next.innerHTML = paras;
  }

  function renderList(el, items) {
    if (!el) return;
    el.innerHTML = '';
    items.forEach(function(item) {
      var li = document.createElement('li');
      li.innerHTML = escapeHTML(item);
      el.appendChild(li);
    });
  }

  function renderActions(items) {
    if (!els.actions) return;
    els.actions.innerHTML = '';
    items.forEach(function(item) {
      var li = document.createElement('li');
      var parts = ['<div>' + escapeHTML(item.task || '') + '</div>'];
      var metaBits = [];
      var owner = cleanField(item.owner);
      var due = cleanField(item.due);
      if (owner) metaBits.push('<span class="meta-key">RESPONSÁVEL</span> ' + escapeHTML(owner));
      if (due) metaBits.push('<span class="meta-key">PRAZO</span> ' + escapeHTML(due));
      if (metaBits.length) {
        parts.push('<span class="item-meta">' + metaBits.join('<span class="meta-sep">·</span>') + '</span>');
      } else {
        parts.push('<span class="item-meta"><span class="meta-key">RESPONSÁVEL</span> não mencionado <span class="meta-sep">·</span> <span class="meta-key">PRAZO</span> não mencionado</span>');
      }
      // li is a grid: marker + content
      var content = document.createElement('div');
      content.innerHTML = parts.join('');
      li.appendChild(content);
      els.actions.appendChild(li);
    });
  }

  function renderOutput(parsed, transcript) {
    if (!els.output) return;

    renderMetaStrip(transcript, parsed);

    renderSummary(parsed.summary);
    renderList(els.decisions, parsed.decisions || []);
    renderActions(parsed.actions || []);
    renderList(els.questions, parsed.open_questions || []);
    renderNext(parsed.next_steps);

    showSection('decisions-section', (parsed.decisions || []).length > 0);
    showSection('actions-section', (parsed.actions || []).length > 0);
    showSection('questions-section', (parsed.open_questions || []).length > 0);
    showSection('next-section', !!(parsed.next_steps && String(parsed.next_steps).trim()));

    els.output.classList.add('active');
    els.output.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ============================================================
  // Export helpers
  // ============================================================
  function toMarkdown(parsed, title) {
    var lines = [];
    if (title) lines.push('# ' + title, '');
    lines.push('## Resumo executivo', '', parsed.summary || '_(sem resumo)_', '');

    if ((parsed.decisions || []).length) {
      lines.push('## Decisões tomadas', '');
      parsed.decisions.forEach(function(d) { lines.push('- ' + d); });
      lines.push('');
    }

    if ((parsed.actions || []).length) {
      lines.push('## Itens de ação', '');
      parsed.actions.forEach(function(a) {
        var meta = [];
        var aOwner = cleanField(a.owner);
        var aDue = cleanField(a.due);
        if (aOwner) meta.push('responsável: ' + aOwner);
        if (aDue) meta.push('prazo: ' + aDue);
        var suffix = meta.length ? ' _(' + meta.join(' · ') + ')_' : '';
        lines.push('- [ ] ' + a.task + suffix);
      });
      lines.push('');
    }

    if ((parsed.open_questions || []).length) {
      lines.push('## Perguntas e bloqueios em aberto', '');
      parsed.open_questions.forEach(function(q) { lines.push('- ' + q); });
      lines.push('');
    }

    if (parsed.next_steps) {
      lines.push('## Próximos passos', '', parsed.next_steps, '');
    }

    if ((parsed.participants || []).length) {
      lines.push('---', '', '_Participantes mencionados: ' + parsed.participants.join(', ') + '_', '');
    }

    return lines.join('\n').trim() + '\n';
  }

  function toPlainText(parsed, title) {
    return toMarkdown(parsed, title)
      .replace(/^# /gm, '')
      .replace(/^## /gm, '')
      .replace(/^- \[ \] /gm, '• ')
      .replace(/^- /gm, '• ')
      .replace(/_\((.*?)\)_/g, '($1)')
      .replace(/_(.*?)_/g, '$1');
  }

  async function copyToClipboard(text, btn) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (btn) {
        var orig = btn.textContent;
        btn.classList.add('copied');
        btn.textContent = 'Copiado ✓';
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.textContent = orig;
        }, 1800);
      }
    } catch {
      alert('Não foi possível copiar. Selecione o texto manualmente.');
    }
  }

  function downloadFile(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  function slugify(s) {
    return String(s || 'reuniao')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'reuniao';
  }

  // ============================================================
  // Generation flow
  // ============================================================
  async function handleGenerate() {
    if (_generating) return;
    refs();
    refreshNoKeyWarning();
    if (!els.error || !els.transcript) return;
    els.error.style.display = 'none';

    var transcript = (els.transcript.value || '').trim();
    if (!transcript) {
      els.error.textContent = 'Cole a transcrição ou anotações da reunião antes de gerar o resumo.';
      els.error.style.display = 'block';
      els.transcript.focus();
      return;
    }

    if (transcript.length < 60) {
      els.error.textContent = 'O texto é muito curto. Cole pelo menos algumas frases da reunião.';
      els.error.style.display = 'block';
      els.transcript.focus();
      return;
    }

    var activeKey = window.ApiKeyManager && ApiKeyManager.getActiveKey();
    if (!activeKey) {
      els.error.textContent = 'Configure uma chave de API (OpenAI ou OpenRouter) para gerar o resumo. Clique no ícone de chave no topo da página.';
      els.error.style.display = 'block';
      refreshNoKeyWarning();
      return;
    }

    var title = (els.title.value || '').trim();
    var ctx = els.context.value || 'generic';

    _generating = true;
    els.generate.disabled = true;
    els.clear.disabled = true;
    els.loading.classList.add('active');
    els.output.classList.remove('active');

    try {
      // Wrap the AI call in the per-member rate limiter
      var parsed = await (window.RateLimiter
        ? RateLimiter.executeWithLimit('summarize-meeting', function() {
            return callAI(activeKey, transcript, title, ctx);
          })
        : callAI(activeKey, transcript, title, ctx));

      if (!parsed) {
        // Rate-limited — toast already shown
        return;
      }

      renderOutput(parsed, transcript);

      // Track success
      if (window.Analytics) Analytics.track('summary_generated', {
        chars: transcript.length,
        service: activeKey.service,
        context: ctx,
        actions: (parsed.actions || []).length,
        decisions: (parsed.decisions || []).length
      });

      // Stash latest result so toolbar actions can use it
      window._lastNotasResult = { parsed: parsed, title: title, transcript: transcript };
    } catch (err) {
      console.error('[notas-ia] generate error:', err);
      var msg = err && err.message ? err.message : 'Erro inesperado.';
      if (err && err.status === 401) msg = 'Chave de API inválida ou expirada. Atualize a chave.';
      if (err && err.status === 429) msg = 'Limite de uso da sua chave atingido. Aguarde ou troque a chave.';
      els.error.textContent = msg;
      els.error.style.display = 'block';
      if (window.ErrorMonitor) ErrorMonitor.logError && ErrorMonitor.logError('summary_failed', msg, err && err.stack, window.location.href);
    } finally {
      _generating = false;
      els.generate.disabled = false;
      els.clear.disabled = false;
      els.loading.classList.remove('active');
    }
  }

  function handleClear() {
    refs();
    if (!confirm('Limpar a transcrição e o resumo atual?')) return;
    if (els.transcript) els.transcript.value = '';
    if (els.title) els.title.value = '';
    if (els.context) els.context.value = 'generic';
    if (els.output) els.output.classList.remove('active');
    if (els.error) els.error.style.display = 'none';
    updateCharCount();
    if (els.transcript) els.transcript.focus();
    window._lastNotasResult = null;
  }

  function handleCopy(kind, btn) {
    var stash = window._lastNotasResult;
    if (!stash) return;
    var text = kind === 'md' ? toMarkdown(stash.parsed, stash.title) : toPlainText(stash.parsed, stash.title);
    copyToClipboard(text, btn);
  }

  function handleDownload() {
    var stash = window._lastNotasResult;
    if (!stash) return;
    var md = toMarkdown(stash.parsed, stash.title);
    var name = 'resumo-' + slugify(stash.title || 'reuniao') + '.md';
    downloadFile(md, name);
  }

  function handlePrint() { window.print(); }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    if (_initialized) {
      refreshNoKeyWarning();
      return;
    }
    _initialized = true;
    refs();

    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }

    if (els.transcript) {
      els.transcript.addEventListener('input', updateCharCount);
      updateCharCount();
    }
    if (els.generate) els.generate.addEventListener('click', handleGenerate);
    if (els.clear) els.clear.addEventListener('click', handleClear);
    if (els.copyMd) els.copyMd.addEventListener('click', function(e) { handleCopy('md', e.currentTarget); });
    if (els.copyTxt) els.copyTxt.addEventListener('click', function(e) { handleCopy('txt', e.currentTarget); });
    if (els.download) els.download.addEventListener('click', handleDownload);
    if (els.print) els.print.addEventListener('click', handlePrint);
    if (els.openKeysLink) els.openKeysLink.addEventListener('click', function(e) {
      e.preventDefault();
      var btn = document.getElementById('manage-keys-btn');
      if (btn) btn.click();
    });

    if (window.Analytics) Analytics.track('app_open', {});
    refreshNoKeyWarning();
  }

  return { init: init, refreshNoKeyWarning: refreshNoKeyWarning };
})();

window.App = App;

(function() {
  // Re-sync the no-key warning every time we transition to app-screen
  // (COR-008 pattern — a returning member may already be on app-screen at first
  // DOMContentLoaded fire, but a first-time member only reaches it later).
  document.addEventListener('maestria:app-ready', function() {
    App.init();
    App.refreshNoKeyWarning();
  });
  document.addEventListener('DOMContentLoaded', function() {
    // Fallback for returning users whose gate is already auto-passed before
    // maestria:app-ready fires.
    setTimeout(function() {
      var session = window.MembershipGate && MembershipGate.getSession();
      if (session) App.init();
    }, 200);
  });
})();
