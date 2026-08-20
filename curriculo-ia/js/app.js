/**
 * Currículo IA — Main Application Logic
 *
 * Flow: member pastes a job description + their background → AI builds a
 * tailored, ATS-optimized resume. BYOK: all AI calls use the member's own
 * OpenAI or OpenRouter key (stored only in localStorage, never sent to us).
 *
 * Globals used:
 *   - window.ApiKeyManager.getActiveKey() — { service, key, config } | null
 *   - MembershipGate.getSession() — { email, name, phone, timestamp }
 *   - RateLimiter.executeWithLimit(endpoint, fn) — abuse prevention
 *   - Analytics.trackAction(action, data)
 */

const App = (function() {
  'use strict';

  // Endpoint config per BYOK service. Both are OpenAI-compatible Chat Completions.
  const SERVICE_CONFIG = {
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      label: 'OpenAI'
    },
    openrouter: {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openai/gpt-4o-mini',
      label: 'OpenRouter'
    }
  };

  let _lastResume = null; // last generated resume object, for copy/download

  /* ---------- helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    var el = $('builder-error');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  function setLoading(isLoading) {
    var btn = $('generate-btn');
    var empty = $('output-empty');
    var loading = $('output-loading');
    var result = $('output-result');
    if (btn) {
      btn.disabled = isLoading;
      btn.querySelector('.btn-text').style.display = isLoading ? 'none' : 'inline';
      btn.querySelector('.btn-loading').style.display = isLoading ? 'inline' : 'none';
    }
    if (isLoading) {
      if (empty) empty.style.display = 'none';
      if (result) result.style.display = 'none';
      if (loading) loading.style.display = 'flex';
    } else {
      if (loading) loading.style.display = 'none';
    }
  }

  function updateKeyWarning() {
    var active = window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null;
    var warn = $('no-key-warning');
    if (warn) warn.style.display = active ? 'none' : 'block';
    return !!active;
  }

  /* ---------- escaping ---------- */

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- AI call ---------- */

  function buildPrompt(input) {
    var schema = '{'
      + '"nome_secao_resumo":"título da seção de resumo (ex: Resumo Profissional)",'
      + '"resumo":"parágrafo de resumo profissional, 3 a 5 linhas, sem clichês",'
      + '"competencias":["lista de 8 a 14 competências e habilidades relevantes para a vaga"],'
      + '"experiencia":[{"cargo":"","empresa":"","periodo":"","destaques":["3 a 5 bullets de conquistas com verbos de ação e, quando possível, números"]}],'
      + '"formacao":[{"curso":"","instituicao":"","periodo":""}],'
      + '"idiomas":["lista de idiomas com nível, se houver — caso contrário lista vazia"],'
      + '"palavras_chave_ats":["8 a 15 termos-chave extraídos da vaga que o currículo deve conter para passar em filtros ATS"],'
      + '"dicas":["3 a 5 dicas práticas e específicas para o candidato fortalecer a candidatura a esta vaga"]'
      + '}';

    var system = 'Você é um especialista sênior em recrutamento e redação de currículos, '
      + 'com experiência em sistemas de triagem automática (ATS). Sua tarefa é montar um '
      + 'currículo sob medida para uma vaga específica, usando APENAS as informações reais '
      + 'fornecidas pelo candidato. NUNCA invente empresas, cargos, datas, diplomas ou números '
      + 'que o candidato não mencionou. Se uma informação não foi fornecida, omita o campo ou '
      + 'use uma lista vazia. Adapte a linguagem e as palavras-chave à vaga. '
      + 'Responda SEMPRE e SOMENTE com um objeto JSON válido, sem texto antes ou depois, '
      + 'sem blocos de markdown. O JSON deve seguir exatamente esta estrutura: ' + schema;

    var user = 'IDIOMA DO CURRÍCULO: ' + input.lang + ' (escreva todo o conteúdo neste idioma).\n'
      + 'NÍVEL DE SENIORIDADE: ' + input.seniority + '.\n'
      + 'TOM DE ESCRITA: ' + input.tone + '.\n'
      + (input.role ? 'CARGO DESEJADO: ' + input.role + '.\n' : '')
      + '\n=== DESCRIÇÃO DA VAGA ===\n' + input.job + '\n'
      + '\n=== EXPERIÊNCIA E HISTÓRICO DO CANDIDATO ===\n' + input.exp + '\n'
      + '\nMonte o melhor currículo possível para esta vaga, destacando o que o candidato '
      + 'tem de mais relevante. Retorne apenas o JSON.';

    return { system: system, user: user };
  }

  async function callAI(active, prompt) {
    var cfg = SERVICE_CONFIG[active.service];
    if (!cfg) throw new Error('Serviço de IA não suportado.');

    var headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + active.key
    };
    if (active.service === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'Curriculo IA';
    }

    var body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      temperature: 0.5,
      max_tokens: 2200,
      response_format: { type: 'json_object' }
    };

    var resp;
    try {
      resp = await fetch(cfg.url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('Falha de conexão com o serviço de IA. Verifique sua internet e tente novamente.');
    }

    if (!resp.ok) {
      var detail = '';
      try {
        var errJson = await resp.json();
        detail = (errJson.error && (errJson.error.message || errJson.error)) || '';
      } catch (e) { /* ignore */ }

      if (resp.status === 401) {
        throw new Error('Chave de API inválida ou expirada. Verifique sua chave em "Gerenciar chaves de API".');
      }
      if (resp.status === 429) {
        throw new Error('Limite ou créditos da sua conta ' + cfg.label + ' esgotados. Verifique o saldo da sua conta.');
      }
      throw new Error('A IA retornou um erro' + (detail ? ': ' + detail : '. Tente novamente.'));
    }

    var data = await resp.json();
    var content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('A IA não retornou conteúdo. Tente novamente.');
    return content;
  }

  function parseResume(raw) {
    var text = String(raw).trim();
    // strip markdown fences if the model added them despite instructions
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // fallback: grab the outermost JSON object
    if (text[0] !== '{') {
      var s = text.indexOf('{');
      var e = text.lastIndexOf('}');
      if (s !== -1 && e !== -1 && e > s) text = text.slice(s, e + 1);
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw new Error('Não foi possível interpretar a resposta da IA. Tente gerar novamente.');
    }
    if (!obj || typeof obj !== 'object') {
      throw new Error('Resposta da IA em formato inesperado. Tente novamente.');
    }
    return obj;
  }

  /* ---------- rendering ---------- */

  function asArray(v) { return Array.isArray(v) ? v : []; }

  function renderResume(data) {
    var doc = $('resume-doc');
    var ats = $('ats-block');
    var tips = $('tips-block');
    var html = '';

    var resumoTitulo = data.nome_secao_resumo || 'Resumo Profissional';

    if (data.resumo) {
      html += '<section class="rd-section">'
        + '<h4 class="rd-h">' + esc(resumoTitulo) + '</h4>'
        + '<p class="rd-summary">' + esc(data.resumo) + '</p>'
        + '</section>';
    }

    var comps = asArray(data.competencias);
    if (comps.length) {
      html += '<section class="rd-section"><h4 class="rd-h">Competências</h4><div class="rd-skills">';
      comps.forEach(function(c) { html += '<span class="rd-skill">' + esc(c) + '</span>'; });
      html += '</div></section>';
    }

    var exps = asArray(data.experiencia);
    if (exps.length) {
      html += '<section class="rd-section"><h4 class="rd-h">Experiência Profissional</h4>';
      exps.forEach(function(x) {
        html += '<div class="rd-job">';
        html += '<div class="rd-job-head"><span class="rd-job-role">' + esc(x.cargo || '') + '</span>';
        if (x.periodo) html += '<span class="rd-job-period">' + esc(x.periodo) + '</span>';
        html += '</div>';
        if (x.empresa) html += '<div class="rd-job-company">' + esc(x.empresa) + '</div>';
        var bullets = asArray(x.destaques);
        if (bullets.length) {
          html += '<ul class="rd-bullets">';
          bullets.forEach(function(b) { html += '<li>' + esc(b) + '</li>'; });
          html += '</ul>';
        }
        html += '</div>';
      });
      html += '</section>';
    }

    var forms = asArray(data.formacao);
    if (forms.length) {
      html += '<section class="rd-section"><h4 class="rd-h">Formação</h4>';
      forms.forEach(function(f) {
        html += '<div class="rd-edu">';
        html += '<span class="rd-edu-course">' + esc(f.curso || '') + '</span>';
        var meta = [f.instituicao, f.periodo].filter(Boolean).map(esc).join(' · ');
        if (meta) html += '<span class="rd-edu-meta">' + meta + '</span>';
        html += '</div>';
      });
      html += '</section>';
    }

    var langs = asArray(data.idiomas);
    if (langs.length) {
      html += '<section class="rd-section"><h4 class="rd-h">Idiomas</h4><div class="rd-skills">';
      langs.forEach(function(l) { html += '<span class="rd-skill">' + esc(l) + '</span>'; });
      html += '</div></section>';
    }

    doc.innerHTML = html || '<p class="rd-summary">A IA não retornou conteúdo estruturado. Tente gerar novamente.</p>';

    // ATS keywords
    var kws = asArray(data.palavras_chave_ats);
    if (kws.length) {
      var atsHtml = '<h4 class="block-h"><span class="block-dot dot-ats"></span>Palavras-chave para passar nos filtros (ATS)</h4>'
        + '<p class="block-desc">Confirme que estes termos aparecem naturalmente no seu currículo — recrutadores e sistemas automáticos buscam por eles.</p>'
        + '<div class="rd-skills">';
      kws.forEach(function(k) { atsHtml += '<span class="ats-chip">' + esc(k) + '</span>'; });
      atsHtml += '</div>';
      ats.innerHTML = atsHtml;
      ats.style.display = 'block';
    } else {
      ats.style.display = 'none';
    }

    // tips
    var dicas = asArray(data.dicas);
    if (dicas.length) {
      var tipsHtml = '<h4 class="block-h"><span class="block-dot dot-tip"></span>Dicas para fortalecer sua candidatura</h4><ul class="tips-list">';
      dicas.forEach(function(d) { tipsHtml += '<li>' + esc(d) + '</li>'; });
      tipsHtml += '</ul>';
      tips.innerHTML = tipsHtml;
      tips.style.display = 'block';
    } else {
      tips.style.display = 'none';
    }

    $('output-empty').style.display = 'none';
    $('output-loading').style.display = 'none';
    $('output-result').style.display = 'block';
    $('output-actions').style.display = 'flex';
  }

  /* ---------- plain text (copy / download) ---------- */

  function buildPlainText(data) {
    var lines = [];
    var rule = '======================================';

    if (data.resumo) {
      lines.push((data.nome_secao_resumo || 'RESUMO PROFISSIONAL').toUpperCase());
      lines.push(rule, data.resumo, '');
    }
    var comps = asArray(data.competencias);
    if (comps.length) {
      lines.push('COMPETÊNCIAS', rule, comps.join(' · '), '');
    }
    var exps = asArray(data.experiencia);
    if (exps.length) {
      lines.push('EXPERIÊNCIA PROFISSIONAL', rule);
      exps.forEach(function(x) {
        var head = [x.cargo, x.empresa].filter(Boolean).join(' — ');
        if (x.periodo) head += '  (' + x.periodo + ')';
        lines.push(head);
        asArray(x.destaques).forEach(function(b) { lines.push('  • ' + b); });
        lines.push('');
      });
    }
    var forms = asArray(data.formacao);
    if (forms.length) {
      lines.push('FORMAÇÃO', rule);
      forms.forEach(function(f) {
        lines.push([f.curso, f.instituicao, f.periodo].filter(Boolean).join(' — '));
      });
      lines.push('');
    }
    var langs = asArray(data.idiomas);
    if (langs.length) {
      lines.push('IDIOMAS', rule, langs.join(' · '), '');
    }
    var kws = asArray(data.palavras_chave_ats);
    if (kws.length) {
      lines.push('PALAVRAS-CHAVE (ATS)', rule, kws.join(', '), '');
    }
    return lines.join('\n').trim() + '\n';
  }

  /* ---------- generate ---------- */

  async function generate() {
    showError('');

    if (!updateKeyWarning()) {
      showError('Configure uma chave de API antes de gerar o currículo.');
      return;
    }

    var job = ($('job-input').value || '').trim();
    var exp = ($('exp-input').value || '').trim();

    if (job.length < 30) {
      showError('Cole uma descrição da vaga mais completa (pelo menos algumas linhas).');
      return;
    }
    if (exp.length < 30) {
      showError('Conte um pouco mais sobre sua experiência e histórico (pelo menos algumas linhas).');
      return;
    }

    var input = {
      job: job.slice(0, 6000),
      exp: exp.slice(0, 6000),
      role: ($('role-input').value || '').trim().slice(0, 120),
      seniority: $('seniority-input').value,
      lang: $('lang-input').value,
      tone: $('tone-input').value
    };

    var active = ApiKeyManager.getActiveKey();
    setLoading(true);

    try {
      var result = await RateLimiter.executeWithLimit('generate-resume', async function() {
        var raw = await callAI(active, buildPrompt(input));
        return parseResume(raw);
      });

      if (result === null) {
        // rate limited — RateLimiter already showed a toast
        setLoading(false);
        $('output-empty').style.display = 'flex';
        return;
      }

      _lastResume = result;
      renderResume(result);
      if (window.Analytics) {
        Analytics.trackAction('generate_resume', {
          service: active.service,
          lang: input.lang,
          seniority: input.seniority
        });
      }
    } catch (err) {
      setLoading(false);
      $('output-empty').style.display = 'flex';
      showError(err && err.message ? err.message : 'Erro inesperado. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  /* ---------- output actions ---------- */

  function flashButton(btn, text) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = text;
    btn.classList.add('btn-mini-ok');
    setTimeout(function() {
      btn.textContent = original;
      btn.classList.remove('btn-mini-ok');
    }, 1800);
  }

  async function copyResume() {
    if (!_lastResume) return;
    var text = buildPlainText(_lastResume);
    try {
      await navigator.clipboard.writeText(text);
      flashButton($('copy-btn'), 'Copiado!');
    } catch (e) {
      // fallback for browsers without clipboard API / insecure context
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flashButton($('copy-btn'), 'Copiado!'); }
      catch (e2) { flashButton($('copy-btn'), 'Falhou'); }
      document.body.removeChild(ta);
    }
  }

  function downloadResume() {
    if (!_lastResume) return;
    var text = buildPlainText(_lastResume);
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'curriculo.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    flashButton($('download-btn'), 'Baixado!');
  }

  function printResume() {
    if (!_lastResume) return;
    window.print();
  }

  /* ---------- init ---------- */

  // Display state that must re-sync every time the app-screen is (re-)entered —
  // e.g. a returning member who only configures their key after init() already ran.
  function refresh() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) {
      var nameEl = $('user-name');
      if (nameEl) nameEl.textContent = (session.name || 'Maestro').split(' ')[0];
    }
    updateKeyWarning();
  }

  function init() {
    refresh();

    var genBtn = $('generate-btn');
    if (genBtn) genBtn.addEventListener('click', generate);

    var copyBtn = $('copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyResume);

    var dlBtn = $('download-btn');
    if (dlBtn) dlBtn.addEventListener('click', downloadResume);

    var prBtn = $('print-btn');
    if (prBtn) prBtn.addEventListener('click', printResume);

    var openKeys = $('open-keys-link');
    if (openKeys) {
      openKeys.addEventListener('click', function() {
        var mk = $('manage-keys-btn');
        if (mk) mk.click();
      });
    }

    // refresh the no-key warning whenever the key modal is used
    var modalClose = $('modal-close');
    var modalSave = $('modal-save');
    if (modalClose) modalClose.addEventListener('click', function() { setTimeout(updateKeyWarning, 50); });
    if (modalSave) modalSave.addEventListener('click', function() { setTimeout(updateKeyWarning, 50); });
  }

  return { init: init, refresh: refresh };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    var session = MembershipGate.getSession();
    if (!session) return;
    if (!_appInitialized) {
      _appInitialized = true;
      App.init();
    } else {
      // already wired — just re-sync display state (key warning, name)
      App.refresh();
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(tryAppInit, 150);
  });
})();
