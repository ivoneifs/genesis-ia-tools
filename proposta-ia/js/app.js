/**
 * Proposta IA — Main Application Logic
 *
 * Flow: member describes a project + the client → AI writes a complete,
 * professional commercial proposal in Portuguese. BYOK: every AI call uses the
 * member's own OpenAI or OpenRouter key (stored only in localStorage, never
 * sent to us).
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

  let _lastProposal = null; // last generated proposal object, for copy/download

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

  // Escape, then turn the [INSERIR VALOR]-style markers the model may emit into
  // a visible highlighted chip so the member sees exactly what to fill in.
  function escWithMarks(str) {
    return esc(str).replace(/\[([^\]]{2,40})\]/g, '<span class="pd-mark">[$1]</span>');
  }

  /* ---------- AI call ---------- */

  function buildPrompt(input) {
    var schema = '{'
      + '"titulo":"título da proposta comercial (ex: Proposta de Gestão de Redes Sociais)",'
      + '"saudacao":"saudação curta e personalizada dirigida ao cliente",'
      + '"introducao":"1 a 2 parágrafos de abertura: apresenta quem envia a proposta e o propósito do documento",'
      + '"entendimento":"1 parágrafo que demonstra compreensão clara da necessidade, do desafio ou do objetivo do cliente",'
      + '"solucao":"1 a 2 parágrafos descrevendo a solução proposta e como ela resolve o problema do cliente",'
      + '"escopo":["lista de 4 a 8 entregáveis concretos e específicos incluídos no trabalho"],'
      + '"etapas":[{"nome":"nome da etapa","descricao":"o que acontece nesta etapa","prazo":"duração ou prazo desta etapa, se aplicável — senão string vazia"}],'
      + '"investimento":"parágrafo sobre o investimento (ver REGRA DO VALOR abaixo)",'
      + '"prazo":"prazo total estimado do projeto em uma frase curta",'
      + '"condicoes":["lista de 3 a 6 termos e condições comerciais padrão e razoáveis: formas de pagamento, validade da proposta, política de revisões, etc."],'
      + '"encerramento":"parágrafo de encerramento cordial com uma chamada para ação clara (o próximo passo para fechar)",'
      + '"dicas":["3 a 5 dicas práticas para o membro revisar e personalizar a proposta antes de enviar ao cliente"]'
      + '}';

    var system = 'Você é um especialista sênior em redação de propostas comerciais e vendas '
      + 'consultivas no Brasil. Sua tarefa é escrever uma proposta comercial completa, '
      + 'persuasiva e profissional, em português do Brasil, usando APENAS as informações '
      + 'reais fornecidas. NUNCA invente fatos, resultados, números de desempenho, prazos ou '
      + 'valores que não foram informados. '
      + 'REGRA DO VALOR (crítica): se um valor de investimento foi fornecido, use EXATAMENTE '
      + 'esse valor no campo "investimento", sem alterá-lo. Se NENHUM valor foi fornecido, '
      + 'NÃO invente um preço — escreva um parágrafo profissional e inclua o marcador literal '
      + '[INSERIR VALOR] no lugar onde o membro deve preencher o valor. Da mesma forma, se o '
      + 'prazo não foi informado, use o marcador [INSERIR PRAZO]. '
      + 'Responda SEMPRE e SOMENTE com um objeto JSON válido, sem texto antes ou depois, '
      + 'sem blocos de markdown. O JSON deve seguir exatamente esta estrutura: ' + schema;

    var lengthGuide = {
      'Concisa': 'Proposta enxuta e direta. Parágrafos curtos. 3 a 4 etapas no máximo.',
      'Padrão': 'Proposta equilibrada, completa mas sem excessos.',
      'Detalhada': 'Proposta detalhada e abrangente, com parágrafos mais ricos e etapas bem descritas.'
    };

    var user = 'TOM DA PROPOSTA: ' + input.tone + '.\n'
      + 'TAMANHO: ' + input.length + ' — ' + (lengthGuide[input.length] || lengthGuide['Padrão']) + '\n'
      + 'QUEM ENVIA A PROPOSTA (prestador): ' + input.provider + '\n'
      + 'CLIENTE: ' + input.client + '\n'
      + (input.price
          ? 'VALOR DO INVESTIMENTO (use exatamente este valor): ' + input.price + '\n'
          : 'VALOR DO INVESTIMENTO: não informado — use o marcador [INSERIR VALOR], não invente preço.\n')
      + (input.timeline
          ? 'PRAZO ESTIMADO (informado): ' + input.timeline + '\n'
          : 'PRAZO ESTIMADO: não informado — use o marcador [INSERIR PRAZO] se necessário.\n')
      + '\n=== DESCRIÇÃO DO PROJETO E DA NECESSIDADE DO CLIENTE ===\n' + input.project + '\n'
      + (input.deliverables
          ? '\n=== ENTREGÁVEIS INFORMADOS PELO MEMBRO ===\n' + input.deliverables + '\n'
          : '\n(O membro não listou entregáveis — proponha um escopo coerente a partir da descrição.)\n')
      + '\nEscreva a melhor proposta comercial possível para conquistar este cliente. '
      + 'Retorne apenas o JSON.';

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
      headers['X-Title'] = 'Proposta IA';
    }

    var body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      temperature: 0.6,
      max_tokens: 2600,
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

  function parseProposal(raw) {
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

  function section(title, innerHtml) {
    return '<section class="pd-section"><h4 class="pd-h">' + esc(title) + '</h4>' + innerHtml + '</section>';
  }

  function paragraphs(text) {
    // split a possibly multi-paragraph string into <p> blocks
    return String(text == null ? '' : text)
      .split(/\n{2,}|\r\n\r\n/)
      .map(function(p) { return p.trim(); })
      .filter(Boolean)
      .map(function(p) { return '<p class="pd-text">' + escWithMarks(p) + '</p>'; })
      .join('');
  }

  function renderProposal(data) {
    var doc = $('proposal-doc');
    var tips = $('tips-block');
    var html = '';

    // header — title + parties
    html += '<div class="pd-title">' + esc(data.titulo || 'Proposta Comercial') + '</div>';
    var parties = $('provider-input').value.trim();
    var clientName = $('client-input').value.trim();
    html += '<div class="pd-parties">Preparada por <strong>' + esc(parties || '—')
      + '</strong> &nbsp;•&nbsp; Para <strong>' + esc(clientName || '—') + '</strong></div>';

    if (data.saudacao) {
      html += '<section class="pd-section">' + paragraphs(data.saudacao) + '</section>';
    }
    if (data.introducao) {
      html += section('Apresentação', paragraphs(data.introducao));
    }
    if (data.entendimento) {
      html += section('Entendimento do desafio', paragraphs(data.entendimento));
    }
    if (data.solucao) {
      html += section('Solução proposta', paragraphs(data.solucao));
    }

    var escopo = asArray(data.escopo);
    if (escopo.length) {
      var escHtml = '<ul class="pd-list">';
      escopo.forEach(function(it) { escHtml += '<li>' + escWithMarks(it) + '</li>'; });
      escHtml += '</ul>';
      html += section('Escopo do trabalho', escHtml);
    }

    var etapas = asArray(data.etapas);
    if (etapas.length) {
      var stHtml = '';
      etapas.forEach(function(et) {
        if (!et || (!et.nome && !et.descricao)) return;
        stHtml += '<div class="pd-step"><div class="pd-step-head">'
          + '<span class="pd-step-name">' + esc(et.nome || '') + '</span>';
        if (et.prazo) stHtml += '<span class="pd-step-when">' + esc(et.prazo) + '</span>';
        stHtml += '</div>';
        if (et.descricao) stHtml += '<div class="pd-step-desc">' + escWithMarks(et.descricao) + '</div>';
        stHtml += '</div>';
      });
      if (stHtml) html += section('Etapas do projeto', stHtml);
    }

    if (data.investimento) {
      html += '<section class="pd-section"><div class="pd-invest">'
        + '<h4 class="pd-h">Investimento</h4>'
        + paragraphs(data.investimento)
        + '</div></section>';
    }

    if (data.prazo) {
      html += section('Prazo', '<div class="pd-meta-row">'
        + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
        + '<span>' + escWithMarks(data.prazo) + '</span></div>');
    }

    var cond = asArray(data.condicoes);
    if (cond.length) {
      var cHtml = '<ul class="pd-list">';
      cond.forEach(function(it) { cHtml += '<li>' + escWithMarks(it) + '</li>'; });
      cHtml += '</ul>';
      html += section('Condições comerciais', cHtml);
    }

    if (data.encerramento) {
      html += section('Próximos passos', paragraphs(data.encerramento));
    }

    doc.innerHTML = html || '<p class="pd-text">A IA não retornou conteúdo estruturado. Tente gerar novamente.</p>';

    // tips
    var dicas = asArray(data.dicas);
    if (dicas.length) {
      var tipsHtml = '<h4 class="block-h"><span class="block-dot dot-tip"></span>Antes de enviar — revise estes pontos</h4>'
        + '<p class="block-desc">Estas dicas não fazem parte da proposta. Use-as para ajustar o documento ao seu jeito.</p>'
        + '<ul class="tips-list">';
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

    if (data.titulo) { lines.push(String(data.titulo).toUpperCase(), rule, ''); }

    var parties = $('provider-input').value.trim();
    var clientName = $('client-input').value.trim();
    lines.push('Preparada por: ' + (parties || '—'));
    lines.push('Para: ' + (clientName || '—'));
    lines.push('');

    function block(title, text) {
      if (!text) return;
      if (title) lines.push(title.toUpperCase(), rule);
      lines.push(String(text).trim(), '');
    }

    block('', data.saudacao);
    block('Apresentação', data.introducao);
    block('Entendimento do desafio', data.entendimento);
    block('Solução proposta', data.solucao);

    var escopo = asArray(data.escopo);
    if (escopo.length) {
      lines.push('ESCOPO DO TRABALHO', rule);
      escopo.forEach(function(it) { lines.push('  • ' + it); });
      lines.push('');
    }

    var etapas = asArray(data.etapas);
    if (etapas.length) {
      lines.push('ETAPAS DO PROJETO', rule);
      etapas.forEach(function(et) {
        if (!et || (!et.nome && !et.descricao)) return;
        var head = et.nome || '';
        if (et.prazo) head += '  (' + et.prazo + ')';
        lines.push(head);
        if (et.descricao) lines.push('  ' + et.descricao);
        lines.push('');
      });
    }

    block('Investimento', data.investimento);
    block('Prazo', data.prazo);

    var cond = asArray(data.condicoes);
    if (cond.length) {
      lines.push('CONDIÇÕES COMERCIAIS', rule);
      cond.forEach(function(it) { lines.push('  • ' + it); });
      lines.push('');
    }

    block('Próximos passos', data.encerramento);

    return lines.join('\n').trim() + '\n';
  }

  /* ---------- generate ---------- */

  async function generate() {
    showError('');

    if (!updateKeyWarning()) {
      showError('Configure uma chave de API antes de gerar a proposta.');
      return;
    }

    var provider = ($('provider-input').value || '').trim();
    var client = ($('client-input').value || '').trim();
    var project = ($('project-input').value || '').trim();

    if (!provider) { showError('Informe seu nome ou o nome da sua empresa.'); return; }
    if (!client) { showError('Informe o nome do cliente.'); return; }
    if (project.length < 30) {
      showError('Descreva o projeto com mais detalhes (pelo menos algumas linhas).');
      return;
    }

    var input = {
      provider: provider.slice(0, 160),
      client: client.slice(0, 160),
      project: project.slice(0, 6000),
      deliverables: ($('deliverables-input').value || '').trim().slice(0, 2000),
      price: ($('price-input').value || '').trim().slice(0, 120),
      timeline: ($('timeline-input').value || '').trim().slice(0, 120),
      tone: $('tone-input').value,
      length: $('length-input').value
    };

    var active = ApiKeyManager.getActiveKey();
    setLoading(true);

    try {
      var result = await RateLimiter.executeWithLimit('generate-proposal', async function() {
        var raw = await callAI(active, buildPrompt(input));
        return parseProposal(raw);
      });

      if (result === null) {
        // rate limited — RateLimiter already showed a toast
        setLoading(false);
        $('output-empty').style.display = 'flex';
        return;
      }

      _lastProposal = result;
      renderProposal(result);
      if (window.Analytics) {
        Analytics.trackAction('generate_proposal', {
          service: active.service,
          tone: input.tone,
          length: input.length,
          has_price: !!input.price
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

  async function copyProposal() {
    if (!_lastProposal) return;
    var text = buildPlainText(_lastProposal);
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

  function downloadProposal() {
    if (!_lastProposal) return;
    var text = buildPlainText(_lastProposal);
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'proposta.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    flashButton($('download-btn'), 'Baixado!');
  }

  function printProposal() {
    if (!_lastProposal) return;
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
    if (copyBtn) copyBtn.addEventListener('click', copyProposal);

    var dlBtn = $('download-btn');
    if (dlBtn) dlBtn.addEventListener('click', downloadProposal);

    var prBtn = $('print-btn');
    if (prBtn) prBtn.addEventListener('click', printProposal);

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
