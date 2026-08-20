/**
 * Hashtags IA — AI hashtag-strategy generator (BYOK).
 *
 * Generates a curated hashtag STRATEGY grouped by reach tier
 * (amplo / médio / nichado) for a given topic + platform, plus a suggested
 * caption and usage tips. All inference runs on the END-USER's own key
 * (OpenAI or OpenRouter) — never a company key. The hashtags are an
 * AI-curated strategy by niche, NOT live-trend scraping (stated in the UI).
 */

const App = (function() {
  var lastResult = null;

  function init() {
    var session = MembershipGate.getSession();
    if (session) {
      var nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
    wireGoalChips();
    wireGenerate();
    wireResultActions();
  }

  function wireGoalChips() {
    var chips = document.querySelectorAll('#goal-chips .chip-select');
    chips.forEach(function(chip) {
      chip.addEventListener('click', function() {
        chips.forEach(function(c) { c.setAttribute('aria-pressed', 'false'); });
        chip.setAttribute('aria-pressed', 'true');
      });
    });
  }

  function getGoal() {
    var active = document.querySelector('#goal-chips .chip-select[aria-pressed="true"]');
    return active ? active.getAttribute('data-goal') : 'Alcance e descoberta';
  }

  function wireGenerate() {
    var btn = document.getElementById('generate-btn');
    if (btn) btn.addEventListener('click', generate);
  }

  function setState(name) {
    document.getElementById('loading-state').style.display = name === 'loading' ? 'block' : 'none';
    document.getElementById('error-state').style.display = name === 'error' ? 'block' : 'none';
    document.getElementById('empty-state').style.display = name === 'empty' ? 'block' : 'none';
    var results = document.getElementById('results');
    if (name === 'results') results.classList.add('active');
    else results.classList.remove('active');
  }

  function showError(msg) {
    document.getElementById('error-text').textContent = msg;
    setState('error');
  }

  async function generate() {
    var topic = (document.getElementById('topic').value || '').trim();
    if (!topic) {
      showError('Digite o tema ou nicho do seu post primeiro.');
      return;
    }

    var active = ApiKeyManager.getActiveKey();
    if (!active) {
      showError('Configure sua chave de API (OpenAI ou OpenRouter) clicando em "Chaves".');
      return;
    }

    var platform = document.getElementById('platform').value;
    var language = document.getElementById('language').value;
    var goal = getGoal();

    setState('loading');
    document.getElementById('generate-btn').disabled = true;

    try {
      var data = await RateLimiter.executeWithLimit('hashtag-generate', function() {
        return callAI(active, topic, platform, language, goal);
      });
      lastResult = data;
      renderResult(data);
      setState('results');
    } catch (err) {
      showError(err && err.message ? err.message : 'Algo deu errado. Tente novamente.');
    } finally {
      document.getElementById('generate-btn').disabled = false;
    }
  }

  function buildPrompt(topic, platform, language, goal) {
    return [
      'Você é um especialista em marketing de redes sociais e estratégia de hashtags.',
      'Gere uma ESTRATÉGIA de hashtags para o seguinte post:',
      '- Tema/nicho: ' + topic,
      '- Plataforma: ' + platform,
      '- Idioma das hashtags: ' + language,
      '- Objetivo: ' + goal,
      '',
      'Distribua as hashtags em 3 grupos por alcance:',
      '- "amplo": hashtags de alto volume e muita concorrência (8 a 12).',
      '- "medio": hashtags de volume intermediário, equilíbrio (8 a 12).',
      '- "nichado": hashtags específicas de nicho, baixa concorrência e alta conversão (8 a 12).',
      'Cada hashtag deve começar com # e não conter espaços.',
      'Inclua também uma "legenda" curta e envolvente para o post (2 a 4 linhas) e',
      '"dicas" (3 a 5 dicas curtas de como usar essas hashtags na plataforma).',
      '',
      'Responda APENAS com JSON válido, sem markdown, neste formato exato:',
      '{"amplo":["#..."],"medio":["#..."],"nichado":["#..."],"legenda":"...","dicas":["...","..."]}'
    ].join('\n');
  }

  async function callAI(active, topic, platform, language, goal) {
    var prompt = buildPrompt(topic, platform, language, goal);
    var endpoint, headers, model;

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      model = (ApiKeyManager.getModel && ApiKeyManager.getModel()) || 'openai/gpt-4o-mini';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + active.key,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Hashtags IA'
      };
    } else {
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = 'gpt-4o-mini';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + active.key
      };
    }

    var resp = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: 'Você responde sempre com JSON válido, sem markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' }
      })
    });

    if (!resp.ok) {
      if (resp.status === 401) throw new Error('Chave de API inválida. Verifique sua chave em "Chaves".');
      if (resp.status === 429) throw new Error('Limite de requisições atingido. Aguarde um momento e tente novamente.');
      var t = '';
      try { t = (await resp.json()).error.message; } catch (e) {}
      throw new Error('Erro na IA' + (t ? ': ' + t : '. Tente novamente.'));
    }

    var json = await resp.json();
    var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error('Resposta vazia da IA. Tente novamente.');

    return parseResult(content);
  }

  function parseResult(content) {
    var cleaned = String(content).trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    var data;
    try { data = JSON.parse(cleaned); }
    catch (e) {
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { data = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!data) throw new Error('Não consegui interpretar a resposta da IA. Tente novamente.');

    return {
      amplo: cleanTags(data.amplo),
      medio: cleanTags(data.medio),
      nichado: cleanTags(data.nichado),
      legenda: typeof data.legenda === 'string' ? data.legenda.trim() : '',
      dicas: Array.isArray(data.dicas) ? data.dicas.map(function(d) { return String(d).trim(); }).filter(Boolean) : []
    };
  }

  function cleanTags(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .map(function(t) {
        var s = String(t).trim().replace(/\s+/g, '');
        if (!s) return '';
        if (s.charAt(0) !== '#') s = '#' + s;
        return s;
      })
      .filter(Boolean);
  }

  function renderTagWall(containerId, tags) {
    var el = document.getElementById(containerId);
    el.innerHTML = '';
    tags.forEach(function(tag) {
      var span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      span.title = 'Clique para copiar';
      span.addEventListener('click', function() {
        copyText(tag);
        span.classList.add('copied');
        setTimeout(function() { span.classList.remove('copied'); }, 1000);
      });
      el.appendChild(span);
    });
  }

  function renderResult(data) {
    renderTagWall('wall-amplo', data.amplo);
    renderTagWall('wall-medio', data.medio);
    renderTagWall('wall-nichado', data.nichado);

    document.getElementById('caption-box').textContent = data.legenda || '—';

    var tips = document.getElementById('tips-list');
    tips.innerHTML = '';
    data.dicas.forEach(function(tip) {
      var li = document.createElement('li');
      li.textContent = tip;
      tips.appendChild(li);
    });
  }

  function allTags() {
    if (!lastResult) return [];
    return [].concat(lastResult.amplo, lastResult.medio, lastResult.nichado);
  }

  function wireResultActions() {
    var copyBtn = document.getElementById('copy-all-btn');
    if (copyBtn) copyBtn.addEventListener('click', function() {
      copyText(allTags().join(' '));
      copyBtn.textContent = 'Copiado!';
      setTimeout(function() { copyBtn.textContent = 'Copiar todas as hashtags'; }, 1200);
    });

    var dlBtn = document.getElementById('download-btn');
    if (dlBtn) dlBtn.addEventListener('click', downloadTxt);
  }

  function downloadTxt() {
    if (!lastResult) return;
    var lines = [
      'HASHTAGS IA — Estratégia',
      '',
      'ALCANCE AMPLO:',
      lastResult.amplo.join(' '),
      '',
      'ALCANCE MÉDIO:',
      lastResult.medio.join(' '),
      '',
      'NICHADO:',
      lastResult.nichado.join(' '),
      '',
      'LEGENDA SUGERIDA:',
      lastResult.legenda,
      '',
      'DICAS:',
      lastResult.dicas.map(function(d) { return '- ' + d; }).join('\n')
    ].join('\n');

    var blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'hashtags-ia.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  return { init: init };
})();

(function() {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = MembershipGate.getSession();
    if (session) {
      _appInitialized = true;
      App.init();
    }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(tryAppInit, 150);
  });
})();
