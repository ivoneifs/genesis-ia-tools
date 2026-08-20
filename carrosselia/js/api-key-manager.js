/**
 * BYOK API Key Manager — stores keys in localStorage ONLY.
 * Keys never leave the user's browser. Never sent to any server.
 *
 * Carrossel IA uses TWO BYOK keys:
 *   • a TEXT model key (OpenRouter preferred — one key reaches every LLM) to write
 *     the carousel copy + a per-slide visual prompt;
 *   • an IMAGE key to turn each visual prompt into a REAL generated image — the
 *     member chooses the provider via the image-model picker: fal.ai (FLUX etc.)
 *     or OpenAI (GPT Image / DALL·E, the same OpenAI key used for text).
 * All are the END-USER's own keys (Hard Rules #1/#7/#12) — the company key is
 * never shipped and no key is ever transmitted to our backend.
 */
const ApiKeyManager = (function() {
  const STORAGE_PREFIX = 'carrossel-ia_apikey_';

  const AI_SERVICES = {
    openrouter: {
      name: 'OpenRouter',
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
      prefix: 'sk-or-',
      required: false
    },
    openai: {
      name: 'OpenAI',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      prefix: 'sk-',
      required: false
    },
    fal: {
      name: 'FAL.AI',
      // Real fal keys look like "<uuid>:<hex>" (e.g. 1a2b3c...:9f8e...). No fixed prefix.
      placeholder: 'xxxxxxxx-xxxx-...:xxxxxxxx',
      helpUrl: 'https://fal.ai/dashboard/keys',
      prefix: '',
      required: false
    }
  };

  // Which services this tool uses. A TEXT key (openrouter/openai) writes the
  // copy + visual prompts; the image key (fal OR openai, per the selected image
  // model) renders the real images. All are BYOK.
  const ENABLED_SERVICES = ['openrouter', 'openai', 'fal'];

  // Services that count as a usable TEXT provider (for the "has a key?" gate).
  const TEXT_SERVICES = ['openrouter', 'openai'];

  // ── TEXT Model catalog (Hard Rule #19 + protocols/model-selection.md) ──
  // Provider-grouped, routed through OpenRouter so ONE key reaches all.
  // Refreshed against the live OpenRouter ranking on 2026-07-10 (build day).
  const AI_MODELS = {
    claude: {
      label: 'Claude (Anthropic)',
      models: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' }
      ]
    },
    openai: {
      label: 'OpenAI',
      models: [
        { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
        { id: 'openai/gpt-5.5-pro', name: 'GPT-5.5 Pro' },
        { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 mini' }
      ]
    },
    google: {
      label: 'Google (Gemini)',
      models: [
        { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' }
      ]
    },
    deepseek: {
      label: 'DeepSeek',
      models: [
        { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }
      ]
    },
    trending: {
      label: 'Em alta (OpenRouter)',
      models: [
        { id: 'x-ai/grok-4.3', name: 'Grok 4.3 (xAI)' },
        { id: 'z-ai/glm-5.2', name: 'GLM 5.2 (Z.ai)' },
        { id: 'qwen/qwen3.7-max', name: 'Qwen 3.7 Max' }
      ]
    }
  };

  const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
  const MODEL_STORAGE_KEY = STORAGE_PREFIX + 'model';

  // ── TEXT→IMAGE catalog (Hard Rule #1 BYOK — user's own key) ──
  // TWO image providers, chosen by the image-model picker:
  //   • fal.ai — native single-provider key (the `fal` entry in AI_SERVICES).
  //     Call via the QUEUE API: POST https://queue.fal.run/<model-id>
  //     (Authorization: Key <userFalKey>) then poll status_url → response_url.
  //   • OpenAI — ids prefixed `openai/` route to the OpenAI Images API
  //     (POST https://api.openai.com/v1/images/generations, Bearer <userOpenAIKey>).
  //     Uses the SAME OpenAI key the member may already use for text (member
  //     feedback 2026-07-10: "colocar chave OpenAI para imagem").
  //
  // ⚠ REFRESH PER BUILD: fal adds text-to-image models weekly. Refreshed 2026-07-10.
  // schnell = fast/cheap (good default for backgrounds); dev/flux-2 = higher quality;
  // ideogram/recraft = better at legible typography if the user bakes text in.
  const IMAGE_MODELS = {
    image: {
      label: 'fal.ai (usa a chave FAL.AI)',
      models: [
        { id: 'fal-ai/flux/schnell', name: 'FLUX.1 [schnell] — rápido e econômico' },
        { id: 'fal-ai/flux/dev', name: 'FLUX.1 [dev] — mais qualidade' },
        { id: 'fal-ai/flux-2-pro', name: 'FLUX.2 [pro] — última geração' },
        { id: 'fal-ai/nano-banana-pro', name: 'Nano Banana Pro (Google)' },
        { id: 'fal-ai/bytedance/seedream/v4', name: 'Seedream 4.0 (ByteDance)' },
        { id: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3 — design/vetor' },
        { id: 'fal-ai/ideogram/v3/quality', name: 'Ideogram V3 — bom com texto' }
      ]
    },
    openaiImage: {
      label: 'OpenAI (usa a chave OpenAI)',
      // gpt-image-1 family ONLY: they always return b64_json (data-URI pipeline).
      // dall-e-3 was dropped — the API rejects `response_format` now (verified
      // 2026-07-10: "Unknown parameter"), so its URL-only output can't cross our
      // CSP / would taint the canvas.
      models: [
        { id: 'openai/gpt-image-1', name: 'GPT Image 1 — alta qualidade' },
        { id: 'openai/gpt-image-1-mini', name: 'GPT Image 1 mini — econômico' }
      ]
    }
  };

  const DEFAULT_FAL_MODEL = 'fal-ai/flux/schnell';
  // Storage slot name kept as `fal_model` for back-compat with saved preferences.
  const FAL_MODEL_STORAGE_KEY = STORAGE_PREFIX + 'fal_model';

  // Which BYOK key a given image model needs.
  function imageProviderFor(modelId) {
    return String(modelId || '').indexOf('openai/') === 0 ? 'openai' : 'fal';
  }

  function getModel() {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL; }
    catch { return DEFAULT_MODEL; }
  }

  function setModel(modelId) {
    try { if (modelId) localStorage.setItem(MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
  }

  // Populate a <select> with provider-grouped <optgroup>s (TEXT models).
  function renderModelPicker(selectId) {
    const select = document.getElementById(selectId || 'model-select');
    if (!select) return;
    select.innerHTML = '';
    const current = getModel();
    Object.keys(AI_MODELS).forEach(function(group) {
      const g = AI_MODELS[group];
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.models.forEach(function(m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === current) opt.selected = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
    select.addEventListener('change', function() { setModel(select.value); });
  }

  // ── image model selection (fal.ai OR OpenAI) ──
  function getFalModel() {
    try { return localStorage.getItem(FAL_MODEL_STORAGE_KEY) || DEFAULT_FAL_MODEL; }
    catch { return DEFAULT_FAL_MODEL; }
  }

  function setFalModel(modelId) {
    try { if (modelId) localStorage.setItem(FAL_MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
  }

  function renderFalModelPicker(selectId, groups) {
    const select = document.getElementById(selectId || 'fal-model-select');
    if (!select) return;
    select.innerHTML = '';
    const current = getFalModel();
    const keys = (groups && groups.length) ? groups : Object.keys(IMAGE_MODELS);
    keys.forEach(function(group) {
      const g = IMAGE_MODELS[group];
      if (!g) return;
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.models.forEach(function(m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === current) opt.selected = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
    select.addEventListener('change', function() { setFalModel(select.value); });
  }

  function getKey(service) {
    try {
      return localStorage.getItem(STORAGE_PREFIX + service) || '';
    } catch {
      return '';
    }
  }

  function setKey(service, key) {
    try {
      if (key) {
        localStorage.setItem(STORAGE_PREFIX + service, key.trim());
      } else {
        localStorage.removeItem(STORAGE_PREFIX + service);
      }
    } catch {
      // localStorage not available
    }
  }

  function clearAllKeys() {
    ENABLED_SERVICES.forEach(function(svc) {
      localStorage.removeItem(STORAGE_PREFIX + svc);
    });
  }

  // A usable text provider key is present (needed to write the carousel).
  function hasRequiredKeys() {
    return TEXT_SERVICES.some(function(svc) { return !!getKey(svc); });
  }

  // The fal key (needed to render real images with fal.ai models).
  function hasFalKey() {
    return !!getKey('fal');
  }

  function getFalKey() {
    return getKey('fal');
  }

  // The image key matching the CURRENTLY SELECTED image model:
  // openai/* models use the member's OpenAI key; everything else uses fal.
  function getImageKey() {
    const provider = imageProviderFor(getFalModel());
    return { provider: provider, key: getKey(provider) };
  }

  function hasImageKey() {
    return !!getImageKey().key;
  }

  // Return the active TEXT key (openrouter preferred, then openai).
  function getActiveKey() {
    for (let i = 0; i < TEXT_SERVICES.length; i++) {
      const key = getKey(TEXT_SERVICES[i]);
      if (key) return { service: TEXT_SERVICES[i], key: key, config: AI_SERVICES[TEXT_SERVICES[i]] };
    }
    return null;
  }

  function renderInputs(containerId) {
    const container = document.getElementById(containerId || 'key-inputs');
    if (!container) return;

    container.innerHTML = '';

    ENABLED_SERVICES.forEach(function(svc) {
      const config = AI_SERVICES[svc];
      if (!config) return;

      const currentKey = getKey(svc);
      const group = document.createElement('div');
      group.className = 'key-input-group';

      const label = document.createElement('label');
      label.setAttribute('for', 'key-' + svc);
      var role = svc === 'fal' ? ' — imagens' : (svc === 'openai' ? ' — texto e imagens' : (svc === 'openrouter' ? ' — texto' : ''));
      label.textContent = config.name + role + (config.required ? ' (obrigatório)' : ' (opcional)');

      const wrapper = document.createElement('div');
      wrapper.className = 'key-input-wrapper';

      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'key-' + svc;
      input.placeholder = config.placeholder;
      input.value = currentKey;
      input.autocomplete = 'off';
      input.setAttribute('data-service', svc);


      const status = document.createElement('div');
      status.className = 'key-status' + (currentKey ? ' saved' : '');
      status.textContent = currentKey ? 'Chave salva localmente' : 'Nenhuma chave configurada';

      input.addEventListener('input', function() {
        const val = input.value.trim();
        setKey(svc, val);
        status.className = 'key-status' + (val ? ' saved' : '');
        status.textContent = val ? 'Chave salva localmente' : 'Nenhuma chave configurada';
        updateContinueButton();
      });

      wrapper.appendChild(input);
      group.appendChild(label);
      group.appendChild(wrapper);
      group.appendChild(status);
      container.appendChild(group);
    });

    setupKeyScreenButtons();
    updateContinueButton();
  }

  function updateContinueButton() {
    const btn = document.getElementById('key-continue');
    if (btn) btn.disabled = !hasRequiredKeys();
  }

  function setupKeyScreenButtons() {
    const continueBtn = document.getElementById('key-continue');
    const skipBtn = document.getElementById('key-skip');

    if (continueBtn) {
      continueBtn.onclick = function() {
        MembershipGate.showScreen('app-screen');
      };
    }

    if (skipBtn) {
      skipBtn.onclick = function() {
        MembershipGate.showScreen('app-screen');
      };
    }
  }

  function setupModal() {
    const manageBtn = document.getElementById('manage-keys-btn');
    const modal = document.getElementById('key-modal');
    const closeBtn = document.getElementById('modal-close');
    const overlay = modal ? modal.querySelector('.modal-overlay') : null;
    const saveBtn = document.getElementById('modal-save');
    const clearBtn = document.getElementById('modal-clear');

    if (manageBtn && modal) {
      manageBtn.addEventListener('click', function() {
        renderInputs('modal-key-inputs');
        modal.style.display = 'flex';
      });
    }

    function closeModal() {
      if (modal) modal.style.display = 'none';
      // Let the app refresh any key-dependent UI (e.g. the fal warning).
      document.dispatchEvent(new CustomEvent('carrossel:keys-updated'));
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) overlay.addEventListener('click', closeModal);

    if (saveBtn) {
      saveBtn.addEventListener('click', closeModal);
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        clearAllKeys();
        renderInputs('modal-key-inputs');
      });
    }
  }

  function init() {
    renderInputs('key-inputs');
    setupModal();
  }

  return {
    init: init,
    getKey: getKey,
    setKey: setKey,
    clearAllKeys: clearAllKeys,
    hasRequiredKeys: hasRequiredKeys,
    hasFalKey: hasFalKey,
    getFalKey: getFalKey,
    getImageKey: getImageKey,
    hasImageKey: hasImageKey,
    imageProviderFor: imageProviderFor,
    getActiveKey: getActiveKey,
    renderInputs: renderInputs,
    ENABLED_SERVICES: ENABLED_SERVICES,
    AI_SERVICES: AI_SERVICES,
    AI_MODELS: AI_MODELS,
    getModel: getModel,
    setModel: setModel,
    renderModelPicker: renderModelPicker,
    IMAGE_MODELS: IMAGE_MODELS,
    getFalModel: getFalModel,
    setFalModel: setFalModel,
    renderFalModelPicker: renderFalModelPicker
  };
})();

window.ApiKeyManager = ApiKeyManager;

document.addEventListener('DOMContentLoaded', function() {
  ApiKeyManager.init();
});
