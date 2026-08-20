/**
 * Prompt IA — Main Application Logic
 *
 * Visual builder that turns a Portuguese idea + style selections into an
 * optimized image-generation prompt for Midjourney / DALL·E 3 / Flux /
 * Stable Diffusion, using the member's own OpenAI or OpenRouter key (BYOK).
 *
 * All AI inference runs on the user's key, client-side. No key, idea, or
 * generated prompt is ever sent to our backend.
 */

const App = (function() {

  // Style option library — value is the English term injected into the prompt,
  // label is what the (Portuguese-speaking) member sees. shape drives the
  // Bauhaus selected-state colour (square=red, circle=blue, tri=ink).
  const OPTIONS = {
    style: { shape: 'tri', items: [
      { label: 'Fotorrealista', value: 'photorealistic' },
      { label: 'Cinemático', value: 'cinematic' },
      { label: 'Anime', value: 'anime' },
      { label: 'Aquarela', value: 'watercolor' },
      { label: '3D / Render', value: '3D render, octane' },
      { label: 'Pixel art', value: 'pixel art' },
      { label: 'Óleo sobre tela', value: 'oil painting' },
      { label: 'Linha / sketch', value: 'line art sketch' },
      { label: 'Minimalista', value: 'minimalist' },
      { label: 'Surreal', value: 'surreal' }
    ]},
    lighting: { shape: 'square', items: [
      { label: 'Hora dourada', value: 'golden hour lighting' },
      { label: 'Estúdio', value: 'studio lighting' },
      { label: 'Neon', value: 'neon lighting' },
      { label: 'Contraluz', value: 'backlighting' },
      { label: 'Suave / difusa', value: 'soft diffused light' },
      { label: 'Dramática', value: 'dramatic chiaroscuro lighting' }
    ]},
    mood: { shape: 'circle', items: [
      { label: 'Aconchegante', value: 'cozy' },
      { label: 'Épico', value: 'epic' },
      { label: 'Sombrio', value: 'dark moody' },
      { label: 'Vibrante', value: 'vibrant energetic' },
      { label: 'Sereno', value: 'serene calm' },
      { label: 'Misterioso', value: 'mysterious' }
    ]},
    composition: { shape: 'tri', items: [
      { label: 'Close-up', value: 'extreme close-up' },
      { label: 'Plano amplo', value: 'wide establishing shot' },
      { label: 'Vista aérea', value: 'aerial top-down view' },
      { label: 'Retrato', value: 'portrait shot' },
      { label: 'Simétrico', value: 'symmetrical composition' },
      { label: 'Regra dos terços', value: 'rule of thirds' }
    ]},
    palette: { shape: 'square', items: [
      { label: 'Quente', value: 'warm color palette' },
      { label: 'Fria', value: 'cool color palette' },
      { label: 'Monocromática', value: 'monochromatic' },
      { label: 'Pastel', value: 'pastel colors' },
      { label: 'Alto contraste', value: 'high contrast vivid colors' },
      { label: 'Preto e branco', value: 'black and white' }
    ]},
    ar: { shape: 'circle', items: [
      { label: '1:1', value: '1:1' },
      { label: '16:9', value: '16:9' },
      { label: '9:16', value: '9:16' },
      { label: '4:3', value: '4:3' },
      { label: '3:2', value: '3:2' },
      { label: '21:9', value: '21:9' }
    ]}
  };

  // Groups where only one chip may be active at a time.
  const SINGLE = { ar: true };

  const state = {
    model: 'midjourney',
    selections: { style: [], lighting: [], mood: [], composition: [], palette: [], ar: [] }
  };

  let _wired = false;

  // COR-015: LLMs sometimes emit the literal string "null"/"undefined" or
  // wrap output in markdown fences. Normalize to a clean string or ''.
  function cleanField(v) {
    if (v === null || v === undefined) return '';
    let s = (typeof v === 'string') ? v : String(v);
    s = s.trim();
    if (/^(null|undefined|n\/a|none)$/i.test(s)) return '';
    return s;
  }

  function stripFences(s) {
    return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  function renderChips() {
    Object.keys(OPTIONS).forEach(function(group) {
      const container = document.querySelector('.chips[data-group="' + group + '"]');
      if (!container) return;
      const shape = OPTIONS[group].shape;
      container.innerHTML = '';
      OPTIONS[group].items.forEach(function(opt) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = opt.label;
        chip.setAttribute('data-value', opt.value);
        chip.setAttribute('data-shape', shape);
        chip.setAttribute('aria-pressed', 'false');
        chip.addEventListener('click', function() {
          toggleChip(group, opt.value, chip, container);
        });
        container.appendChild(chip);
      });
    });
  }

  function toggleChip(group, value, chip, container) {
    const arr = state.selections[group];
    const idx = arr.indexOf(value);
    if (SINGLE[group]) {
      if (idx > -1) {
        state.selections[group] = [];
        chip.classList.remove('on');
        chip.setAttribute('aria-pressed', 'false');
      } else {
        state.selections[group] = [value];
        container.querySelectorAll('.chip').forEach(function(c) {
          c.classList.remove('on');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('on');
        chip.setAttribute('aria-pressed', 'true');
      }
    } else {
      if (idx > -1) {
        arr.splice(idx, 1);
        chip.classList.remove('on');
        chip.setAttribute('aria-pressed', 'false');
      } else {
        arr.push(value);
        chip.classList.add('on');
        chip.setAttribute('aria-pressed', 'true');
      }
    }
  }

  function wireModelSeg() {
    const seg = document.getElementById('model-seg');
    if (!seg) return;
    seg.querySelectorAll('button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        seg.querySelectorAll('button').forEach(function(b) {
          b.classList.remove('active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
        state.model = btn.getAttribute('data-model');
      });
    });
  }

  function wireIdeaCount() {
    const ta = document.getElementById('idea-input');
    const count = document.getElementById('idea-count');
    if (!ta || !count) return;
    ta.addEventListener('input', function() {
      count.textContent = ta.value.length;
    });
  }

  function wireCopyButtons() {
    document.querySelectorAll('.copy-mini').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const target = document.getElementById(btn.getAttribute('data-copy'));
        if (!target) return;
        const text = target.textContent || '';
        navigator.clipboard.writeText(text).then(function() {
          const orig = btn.textContent;
          btn.textContent = 'Copiado!';
          btn.classList.add('done');
          setTimeout(function() {
            btn.textContent = orig;
            btn.classList.remove('done');
          }, 1600);
        }).catch(function() {});
      });
    });
  }

  // COR-008: re-sync the no-key note every time the app screen becomes ready,
  // since the member may add/remove a key in the modal at any point.
  function syncNoKeyNote() {
    const note = document.getElementById('no-key-note');
    if (!note) return;
    if (ApiKeyManager.hasRequiredKeys()) note.classList.remove('show');
    else note.classList.add('show');
  }

  function wireNoKeyCta() {
    const cta = document.getElementById('no-key-cta');
    if (cta) {
      cta.addEventListener('click', function(e) {
        e.preventDefault();
        const manageBtn = document.getElementById('manage-keys-btn');
        if (manageBtn) manageBtn.click();
      });
    }
  }

  const MODEL_NOTES = {
    midjourney: 'Target: Midjourney v6. Put aspect ratio and quality flags at the END using --ar and --v 6 / --style raw syntax. Do NOT use a negative_prompt field (Midjourney uses --no instead; fold exclusions into a --no list inside the parameters). Keep the prompt as a single descriptive comma-light phrase.',
    dalle: 'Target: DALL·E 3. Write a single rich natural-language paragraph (DALL·E ignores weights and flags). No --ar flags and no negative prompt; describe the aspect ratio in words. Be vivid and unambiguous.',
    flux: 'Target: Flux. Use natural descriptive language; Flux follows prose well. A short negative_prompt is allowed. Mention aspect ratio in words.',
    sd: 'Target: Stable Diffusion (SDXL). Use comma-separated tags/keywords with optional (emphasis:1.2) weighting. ALWAYS provide a strong negative_prompt. Provide recommended parameters (steps, CFG, sampler).'
  };

  function buildUserBrief(idea) {
    const s = state.selections;
    const parts = [];
    parts.push('Core idea (translate to English, expand cinematically): ' + idea);
    if (s.style.length)       parts.push('Style: ' + s.style.join(', '));
    if (s.lighting.length)    parts.push('Lighting: ' + s.lighting.join(', '));
    if (s.mood.length)        parts.push('Mood: ' + s.mood.join(', '));
    if (s.composition.length) parts.push('Composition: ' + s.composition.join(', '));
    if (s.palette.length)     parts.push('Palette: ' + s.palette.join(', '));
    if (s.ar.length)          parts.push('Aspect ratio: ' + s.ar[0]);
    parts.push('Target model: ' + state.model);
    return parts.join('\n');
  }

  function systemPrompt() {
    return [
      'You are an expert prompt engineer for AI image generators.',
      'Given a creative brief (in Portuguese) and selected attributes, produce ONE optimized, production-ready prompt in ENGLISH tailored to the target model.',
      MODEL_NOTES[state.model] || '',
      'Return STRICT JSON only, no markdown, with this exact shape:',
      '{"prompt": string, "negative_prompt": string, "parameters": string, "rationale_pt": string}',
      '- "prompt": the final prompt to paste into the tool (English).',
      '- "negative_prompt": things to avoid (English). Empty string "" if the target model does not use one.',
      '- "parameters": recommended flags/settings as a single line (e.g. "--ar 16:9 --v 6 --style raw" or "steps: 30, CFG: 7, sampler: DPM++ 2M Karras"). Empty string "" if none.',
      '- "rationale_pt": 1-2 sentences in BRAZILIAN PORTUGUESE explaining the key choices, so the member learns.',
      'Never wrap the JSON in code fences. Never output the word null as a value — use an empty string instead.'
    ].filter(Boolean).join('\n');
  }

  function endpointFor(active) {
    if (active.service === 'openrouter') {
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'openai/gpt-4o-mini',
        headers: {
          'Authorization': 'Bearer ' + active.key,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Prompt IA - Gênesis IA'
        }
      };
    }
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      headers: {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json'
      }
    };
  }

  function setBuilding(building) {
    const btn = document.getElementById('build-btn');
    if (btn) {
      btn.disabled = building;
      btn.querySelector('.btn-text').style.display = building ? 'none' : 'inline';
      btn.querySelector('.btn-loading').style.display = building ? 'inline' : 'none';
    }
    const empty = document.getElementById('out-empty');
    const loading = document.getElementById('out-loading');
    const result = document.getElementById('out-result');
    if (building) {
      if (empty) empty.style.display = 'none';
      if (result) result.style.display = 'none';
      if (loading) loading.style.display = 'flex';
    } else {
      if (loading) loading.style.display = 'none';
    }
  }

  function showError(msg) {
    const el = document.getElementById('build-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function renderResult(data) {
    const empty = document.getElementById('out-empty');
    const result = document.getElementById('out-result');
    if (empty) empty.style.display = 'none';
    if (result) result.style.display = 'block';

    const prompt = cleanField(data.prompt);
    const negative = cleanField(data.negative_prompt);
    const params = cleanField(data.parameters);
    const rationale = cleanField(data.rationale_pt);

    document.getElementById('out-prompt').textContent = prompt || '(vazio)';

    toggleBlock('out-negative-block', 'out-negative', negative);
    toggleBlock('out-params-block', 'out-params', params);
    toggleBlock('out-rationale-block', 'out-rationale', rationale);
  }

  function toggleBlock(blockId, textId, value) {
    const block = document.getElementById(blockId);
    const textEl = document.getElementById(textId);
    if (value) {
      textEl.textContent = value;
      block.style.display = 'block';
    } else {
      block.style.display = 'none';
    }
  }

  async function generate() {
    showError('');
    const ideaEl = document.getElementById('idea-input');
    const idea = (ideaEl ? ideaEl.value : '').trim();
    if (!idea) {
      showError('Descreva sua ideia antes de gerar o prompt.');
      if (ideaEl) ideaEl.focus();
      return;
    }

    const active = ApiKeyManager.getActiveKey();
    if (!active) {
      showError('Configure sua chave de API (OpenAI ou OpenRouter) para gerar prompts.');
      syncNoKeyNote();
      const manageBtn = document.getElementById('manage-keys-btn');
      if (manageBtn) manageBtn.click();
      return;
    }

    setBuilding(true);

    const ep = endpointFor(active);
    const body = {
      model: ep.model,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: buildUserBrief(idea) }
      ],
      temperature: 0.8,
      response_format: { type: 'json_object' }
    };

    try {
      const result = await RateLimiter.executeWithLimit('prompt-ia-generate', function() {
        return fetch(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(body)
        });
      });

      if (result === null) { setBuilding(false); return; } // rate-limited

      if (!result.ok) {
        let detail = '';
        try { const e = await result.json(); detail = (e.error && e.error.message) ? e.error.message : ''; } catch {}
        if (result.status === 401) {
          showError('Chave de API inválida ou sem permissão. Verifique sua chave.');
        } else if (result.status === 429) {
          showError('Limite da sua conta de API atingido. Aguarde e tente novamente.');
        } else {
          showError('Erro ao gerar (HTTP ' + result.status + ')' + (detail ? ': ' + detail : '') + '.');
        }
        setBuilding(false);
        return;
      }

      const json = await result.json();
      const content = json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content : '';

      let data;
      try {
        data = JSON.parse(stripFences(content || '{}'));
      } catch {
        showError('A resposta da IA veio em formato inesperado. Tente novamente.');
        setBuilding(false);
        return;
      }

      setBuilding(false);
      renderResult(data);
    } catch (err) {
      setBuilding(false);
      showError('Falha de rede ao contatar a API. Verifique sua conexão e tente novamente.');
    }
  }

  function wireOnce() {
    if (_wired) return;
    _wired = true;
    renderChips();
    wireModelSeg();
    wireIdeaCount();
    wireCopyButtons();
    wireNoKeyCta();
    const buildBtn = document.getElementById('build-btn');
    if (buildBtn) buildBtn.addEventListener('click', generate);
  }

  function init() {
    wireOnce();
    syncNoKeyNote(); // COR-008: runs on every app-ready
  }

  return { init: init };
})();

(function() {
  function onReady() {
    var session = MembershipGate.getSession();
    if (session) App.init();
  }
  document.addEventListener('maestria:app-ready', onReady);
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(onReady, 150);
  });
})();
