/**
 * E-mail IA — Main Application Logic
 *
 * Professional email writer. The member describes the context, goal and tone,
 * and the BYOK-configured AI returns a structured JSON payload: subject line,
 * subject alternatives, the email body, and pre-send tips.
 *
 * AI calls are routed through OpenAI-compatible chat completions endpoints
 * (OpenAI direct or OpenRouter). Keys live in localStorage only — never touch
 * our backend. Every call is wrapped in RateLimiter.executeWithLimit.
 */

const App = (function() {
  var _initialized = false;
  var _generating = false;

  var TYPE_HINTS = {
    'primeiro-contato': 'primeiro contato comercial / prospecção a frio (apresentar-se, gerar interesse e propor um próximo passo leve)',
    'follow-up': 'follow-up / acompanhamento de uma conversa ou proposta anterior (retomar o assunto com educação, sem soar insistente)',
    'proposta': 'envio de proposta comercial (apresentar a oferta com clareza e conduzir a uma decisão)',
    'cobranca': 'cobrança ou lembrete de pagamento (firme, porém cordial e profissional, preservando o relacionamento)',
    'agradecimento': 'agradecimento (reconhecer de forma genuína e específica)',
    'desculpas': 'pedido de desculpas (assumir o ocorrido, demonstrar responsabilidade e apresentar a solução)',
    'resposta-cliente': 'resposta a um cliente (resolver a dúvida ou solicitação com clareza e atenção)',
    'convite': 'convite ou agendamento de reunião (propor objetivo, formato e horários de forma prática)',
    'networking': 'networking / apresentação profissional (criar conexão e abrir uma conversa)',
    'candidatura': 'candidatura a uma vaga (destacar valor e adequação de forma objetiva)',
    'divulgacao': 'divulgação ou newsletter (comunicar uma novidade de forma atraente e clara)',
    'outro': 'e-mail profissional de propósito geral'
  };

  var TONE_HINTS = {
    'profissional': 'profissional e cordial — equilibrado, respeitoso e natural',
    'formal': 'formal — linguagem mais cerimoniosa e impecável, tratamento por "senhor(a)" quando couber',
    'amigavel': 'amigável e próximo — leve, caloroso, sem perder o profissionalismo',
    'direto': 'direto e objetivo — sem rodeios, frases curtas, foco no essencial',
    'persuasivo': 'persuasivo — destaca benefícios e conduz a uma ação, sem exageros nem promessas vazias',
    'empatico': 'empático — reconhece o lado do outro e demonstra cuidado'
  };

  var LENGTH_HINTS = {
    'curto': 'CURTO: 2 a 3 parágrafos breves, direto ao ponto',
    'medio': 'MÉDIO: 3 a 4 parágrafos equilibrados',
    'detalhado': 'DETALHADO: 5 ou mais parágrafos, completo e bem desenvolvido'
  };

  // ============================================================
  // Element refs
  // ============================================================
  var els = {};
  function refs() {
    els.type = document.getElementById('email-type');
    els.tone = document.getElementById('email-tone');
    els.length = document.getElementById('email-length');
    els.context = document.getElementById('email-context');
    els.contextCount = document.getElementById('context-count');
    els.recipient = document.getElementById('email-recipient');
    els.sender = document.getElementById('email-sender');
    els.points = document.getElementById('email-points');
    els.generate = document.getElementById('generate-btn');
    els.clear = document.getElementById('clear-btn');
    els.loading = document.getElementById('loading-block');
    els.empty = document.getElementById('empty-state');
    els.error = document.getElementById('generate-error');
    els.letter = document.getElementById('letter');
    els.folio = document.getElementById('letter-folio');
    els.subjectMain = document.getElementById('subject-main');
    els.copySubject = document.getElementById('copy-subject-btn');
    els.altSubjects = document.getElementById('alt-subjects');
    els.altList = document.getElementById('alt-list');
    els.letterhead = document.getElementById('letterhead');
    els.body = document.getElementById('letter-body');
    els.tipsBlock = document.getElementById('tips-block');
    els.tipsList = document.getElementById('tips-list');
    els.copyFull = document.getElementById('copy-full-btn');
    els.copyBody = document.getElementById('copy-body-btn');
    els.download = document.getElementById('download-btn');
    els.print = document.getElementById('print-btn');
    els.noKey = document.getElementById('no-key-warning');
    els.openKeysLink = document.getElementById('open-keys-link');
  }

  function updateContextCount() {
    if (!els.context || !els.contextCount) return;
    var text = els.context.value || '';
    els.contextCount.textContent = text.length + ' caracteres';
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

  function buildSystemPrompt(typeHint, toneHint, lengthHint) {
    return [
      'Você é um redator profissional de e-mails corporativos em português do Brasil. Escreve e-mails claros, bem estruturados e prontos para enviar.',
      '',
      'Tipo de e-mail: ' + typeHint + '.',
      'Tom desejado: ' + toneHint + '.',
      'Tamanho: ' + lengthHint + '.',
      '',
      'Regras OBRIGATÓRIAS:',
      '1. NÃO INVENTE DADOS. Nunca crie valores, preços, datas, prazos, links, nomes de empresa ou números que não foram fornecidos. Quando um dado for necessário mas não foi informado, escreva um marcador entre colchetes para o usuário preencher, ex: [INSERIR VALOR], [DATA], [LINK], [SEU NOME].',
      '2. Escreva em português do Brasil, com gramática e pontuação impecáveis.',
      '3. O corpo deve ter saudação de abertura, parágrafos bem divididos e uma despedida. Separe os parágrafos com uma linha em branco.',
      '4. Respeite o tom e o tamanho pedidos.',
      '5. Inclua uma chamada para ação clara quando fizer sentido para o tipo de e-mail.',
      '6. NÃO inclua a linha "Assunto:" dentro do corpo — o assunto vai em campo separado.',
      '7. As dicas ("tips") devem ser curtas e práticas: o que revisar ou ajustar antes de enviar (ex: confirmar anexos, preencher os marcadores, conferir o nome do destinatário).',
      '',
      'Devolva EXCLUSIVAMENTE um JSON válido (sem texto antes ou depois, sem cercas markdown) com esta estrutura:',
      '{',
      '  "subject": "Linha de assunto principal, curta e específica.",',
      '  "subject_alternatives": ["Variação de assunto 1", "Variação de assunto 2"],',
      '  "body": "Corpo completo do e-mail, com saudação, parágrafos separados por linha em branco e despedida.",',
      '  "tips": ["Dica 1 antes de enviar.", "Dica 2."]',
      '}'
    ].join('\n');
  }

  function buildUserPrompt() {
    var lines = [];
    lines.push('CONTEXTO E OBJETIVO DO E-MAIL:');
    lines.push((els.context.value || '').trim());

    var recipient = (els.recipient.value || '').trim();
    var sender = (els.sender.value || '').trim();
    var points = (els.points.value || '').trim();

    if (recipient) lines.push('', 'DESTINATÁRIO: ' + recipient);
    if (sender) lines.push('', 'REMETENTE / ASSINATURA: ' + sender);
    if (points) {
      lines.push('', 'PONTOS QUE DEVEM SER INCLUÍDOS:', points);
    }
    return lines.join('\n');
  }

  async function callAI(activeKey) {
    var endpoint = endpointFor(activeKey.service);
    var model = modelFor(activeKey.service);
    var typeHint = TYPE_HINTS[els.type.value] || TYPE_HINTS.outro;
    var toneHint = TONE_HINTS[els.tone.value] || TONE_HINTS.profissional;
    var lengthHint = LENGTH_HINTS[els.length.value] || LENGTH_HINTS.medio;

    var body = {
      model: model,
      messages: [
        { role: 'system', content: buildSystemPrompt(typeHint, toneHint, lengthHint) },
        { role: 'user', content: buildUserPrompt() }
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' }
    };

    var headers = {
      'Authorization': 'Bearer ' + activeKey.key,
      'Content-Type': 'application/json'
    };

    if (activeKey.service === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      // OpenRouter X-Title header must be ASCII / ISO-8859-1 (no accents/em-dash).
      headers['X-Title'] = 'E-mail IA - Gênesis IA';
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
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // The model sometimes emits literal "null"/"undefined"/"-" for an absent
  // value instead of JSON null. Treat those as empty.
  function cleanField(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (!s || /^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }

  // Highlight [MARCADOR] placeholders the model leaves for the user to fill.
  function highlightPlaceholders(safeHTML) {
    return safeHTML.replace(/\[[^\]]+\]/g, function(m) {
      return '<span class="placeholder">' + m + '</span>';
    });
  }

  function renderBody(text) {
    if (!els.body) return;
    var safe = escapeHTML(cleanField(text));
    safe = highlightPlaceholders(safe);
    var paras = safe.split(/\n{2,}/).map(function(p) {
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    els.body.innerHTML = paras;
  }

  function renderFolio() {
    if (!els.folio) return;
    var date = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    var typeLabel = els.type.options[els.type.selectedIndex].textContent;
    els.folio.innerHTML =
      '<span>' + escapeHTML(date.toUpperCase()) + '</span>' +
      '<span class="folio-sep">/</span>' +
      '<span>' + escapeHTML(typeLabel.toUpperCase()) + '</span>' +
      '<span class="folio-tail"></span>';
  }

  function renderAlternatives(alts) {
    if (!els.altSubjects || !els.altList) return;
    var list = (alts || []).map(cleanField).filter(Boolean);
    if (!list.length) {
      els.altSubjects.style.display = 'none';
      return;
    }
    els.altList.innerHTML = '';
    list.forEach(function(alt) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="alt-text">' + escapeHTML(alt) + '</span>' +
        '<button class="copy-mini" type="button">Copiar</button>';
      var btn = li.querySelector('button');
      btn.addEventListener('click', function() { copyToClipboard(alt, btn); });
      els.altList.appendChild(li);
    });
    els.altSubjects.style.display = '';
  }

  function renderTips(tips) {
    if (!els.tipsBlock || !els.tipsList) return;
    var list = (tips || []).map(cleanField).filter(Boolean);
    if (!list.length) {
      els.tipsBlock.style.display = 'none';
      return;
    }
    els.tipsList.innerHTML = '';
    list.forEach(function(t) {
      var li = document.createElement('li');
      li.innerHTML = escapeHTML(t);
      els.tipsList.appendChild(li);
    });
    els.tipsBlock.style.display = '';
  }

  function renderOutput(parsed) {
    if (!els.letter) return;

    renderFolio();

    if (els.subjectMain) els.subjectMain.textContent = cleanField(parsed.subject) || '(sem assunto)';
    renderAlternatives(parsed.subject_alternatives);
    renderBody(parsed.body);
    renderTips(parsed.tips);

    if (els.empty) els.empty.style.display = 'none';
    els.letter.classList.add('active');
    els.letter.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ============================================================
  // Export helpers
  // ============================================================
  function buildPlainEmail(parsed, includeSubject) {
    var lines = [];
    var subject = cleanField(parsed.subject);
    if (includeSubject && subject) {
      lines.push('Assunto: ' + subject, '');
    }
    lines.push(cleanField(parsed.body));
    return lines.join('\n').trim() + '\n';
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
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
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
    return String(s || 'email')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'email';
  }

  // ============================================================
  // Generation flow
  // ============================================================
  async function handleGenerate() {
    if (_generating) return;
    refs();
    refreshNoKeyWarning();
    if (!els.error || !els.context) return;
    els.error.style.display = 'none';

    var ctx = (els.context.value || '').trim();
    if (!ctx) {
      els.error.textContent = 'Descreva sobre o que é o e-mail antes de redigir.';
      els.error.style.display = 'block';
      els.context.focus();
      return;
    }
    if (ctx.length < 15) {
      els.error.textContent = 'Dê um pouco mais de contexto (pelo menos uma frase) para a IA escrever um bom e-mail.';
      els.error.style.display = 'block';
      els.context.focus();
      return;
    }

    var activeKey = window.ApiKeyManager && ApiKeyManager.getActiveKey();
    if (!activeKey) {
      els.error.textContent = 'Configure uma chave de API (OpenAI ou OpenRouter) para redigir o e-mail. Clique no ícone de chave no topo da página.';
      els.error.style.display = 'block';
      refreshNoKeyWarning();
      return;
    }

    _generating = true;
    els.generate.disabled = true;
    els.clear.disabled = true;
    els.loading.classList.add('active');
    els.letter.classList.remove('active');
    if (els.empty) els.empty.style.display = 'none';

    try {
      var parsed = await (window.RateLimiter
        ? RateLimiter.executeWithLimit('generate-email', function() {
            return callAI(activeKey);
          })
        : callAI(activeKey));

      if (!parsed) {
        // Rate-limited — toast already shown
        return;
      }

      renderOutput(parsed);

      if (window.Analytics) Analytics.track('email_generated', {
        chars: ctx.length,
        service: activeKey.service,
        type: els.type.value,
        tone: els.tone.value,
        length: els.length.value
      });

      window._lastEmailResult = { parsed: parsed };
    } catch (err) {
      console.error('[email-ia] generate error:', err);
      var msg = err && err.message ? err.message : 'Erro inesperado.';
      if (err && err.status === 401) msg = 'Chave de API inválida ou expirada. Atualize a chave.';
      if (err && err.status === 429) msg = 'Limite de uso da sua chave atingido. Aguarde ou troque a chave.';
      els.error.textContent = msg;
      els.error.style.display = 'block';
      if (els.empty && !els.letter.classList.contains('active')) els.empty.style.display = '';
      if (window.ErrorMonitor) ErrorMonitor.logError && ErrorMonitor.logError('email_failed', msg, err && err.stack, window.location.href);
    } finally {
      _generating = false;
      els.generate.disabled = false;
      els.clear.disabled = false;
      els.loading.classList.remove('active');
    }
  }

  function handleClear() {
    refs();
    if (!confirm('Limpar o formulário e o e-mail gerado?')) return;
    if (els.context) els.context.value = '';
    if (els.recipient) els.recipient.value = '';
    if (els.sender) els.sender.value = '';
    if (els.points) els.points.value = '';
    if (els.letter) els.letter.classList.remove('active');
    if (els.empty) els.empty.style.display = '';
    if (els.error) els.error.style.display = 'none';
    updateContextCount();
    if (els.context) els.context.focus();
    window._lastEmailResult = null;
  }

  function handleCopyFull(btn) {
    var stash = window._lastEmailResult;
    if (!stash) return;
    copyToClipboard(buildPlainEmail(stash.parsed, true), btn);
  }

  function handleCopyBody(btn) {
    var stash = window._lastEmailResult;
    if (!stash) return;
    copyToClipboard(buildPlainEmail(stash.parsed, false), btn);
  }

  function handleCopySubject(btn) {
    var stash = window._lastEmailResult;
    if (!stash) return;
    copyToClipboard(cleanField(stash.parsed.subject), btn);
  }

  function handleDownload() {
    var stash = window._lastEmailResult;
    if (!stash) return;
    var text = buildPlainEmail(stash.parsed, true);
    var name = 'email-' + slugify(cleanField(stash.parsed.subject) || 'mensagem') + '.txt';
    downloadFile(text, name);
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

    if (els.context) {
      els.context.addEventListener('input', updateContextCount);
      updateContextCount();
    }
    if (els.generate) els.generate.addEventListener('click', handleGenerate);
    if (els.clear) els.clear.addEventListener('click', handleClear);
    if (els.copyFull) els.copyFull.addEventListener('click', function(e) { handleCopyFull(e.currentTarget); });
    if (els.copyBody) els.copyBody.addEventListener('click', function(e) { handleCopyBody(e.currentTarget); });
    if (els.copySubject) els.copySubject.addEventListener('click', function(e) { handleCopySubject(e.currentTarget); });
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
  document.addEventListener('maestria:app-ready', function() {
    App.init();
    App.refreshNoKeyWarning();
  });
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
      var session = window.MembershipGate && MembershipGate.getSession();
      if (session) App.init();
    }, 200);
  });
})();
