/**
 * BYOK API Key Manager — stores keys in localStorage ONLY.
 * Keys never leave the user's browser. Never sent to any server.
 *
 * E-book IA uses OpenRouter (one key → every model in the picker, Rule #19) and
 * OpenAI as a native single-provider fallback.
 */
const ApiKeyManager = (function() {
  const STORAGE_PREFIX = 'ebook-ia_apikey_';

  const AI_SERVICES = {
    openai: {
      name: 'OpenAI',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      prefix: 'sk-',
      required: false
    },
    openrouter: {
      name: 'OpenRouter',
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
      prefix: 'sk-or-',
      required: false
    }
  };

  // OpenRouter first: one key reaches every model in the picker (Rule #19);
  // OpenAI offered as a native single-provider fallback.
  const ENABLED_SERVICES = ['openrouter', 'openai'];

  // ── Model catalog (Hard Rule #19 + protocols/model-selection.md) ──
  // Provider-grouped picker, routed through OpenRouter so ONE BYOK key reaches
  // every provider. IDs are OpenRouter provider-prefixed.
  // Refreshed from the LIVE OpenRouter ranking at build time (2026-06-20) and
  // each id verified to exist via GET https://openrouter.ai/api/v1/models.
  const AI_MODELS = {
    claude: {
      label: 'Claude (Anthropic)',
      models: [
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' }
      ]
    },
    openai: {
      label: 'OpenAI',
      models: [
        { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
        { id: 'openai/gpt-5.5-pro', name: 'GPT-5.5 Pro' },
        { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini' }
      ]
    },
    google: {
      label: 'Google (Gemini)',
      models: [
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
        { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
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
        { id: 'x-ai/grok-4.3', name: 'Grok 4.3' },
        { id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
        { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
        { id: 'qwen/qwen3.7-max', name: 'Qwen3.7 Max' }
      ]
    }
  };

  // Long-form writing default: strong, fast, well-priced.
  const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
  const MODEL_STORAGE_KEY = STORAGE_PREFIX + 'model';

  function getModel() {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL; }
    catch { return DEFAULT_MODEL; }
  }

  function setModel(modelId) {
    try { if (modelId) localStorage.setItem(MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
  }

  // Populate a <select> with provider-grouped <optgroup>s.
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

  function getKey(service) {
    try { return localStorage.getItem(STORAGE_PREFIX + service) || ''; }
    catch { return ''; }
  }

  function setKey(service, key) {
    try {
      if (key) localStorage.setItem(STORAGE_PREFIX + service, key.trim());
      else localStorage.removeItem(STORAGE_PREFIX + service);
    } catch { /* localStorage not available */ }
  }

  function clearAllKeys() {
    ENABLED_SERVICES.forEach(function(svc) {
      localStorage.removeItem(STORAGE_PREFIX + svc);
    });
  }

  function hasRequiredKeys() {
    return ENABLED_SERVICES.some(function(svc) {
      const config = AI_SERVICES[svc];
      if (!config) return false;
      return !!getKey(svc);
    });
  }

  function getActiveKey() {
    for (let i = 0; i < ENABLED_SERVICES.length; i++) {
      const key = getKey(ENABLED_SERVICES[i]);
      if (key) return { service: ENABLED_SERVICES[i], key: key, config: AI_SERVICES[ENABLED_SERVICES[i]] };
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
      label.textContent = config.name + (config.required ? ' (obrigatório)' : ' (opcional)');

      const wrapper = document.createElement('div');
      wrapper.className = 'key-input-wrapper';

      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'key-' + svc;
      input.placeholder = config.placeholder;
      input.value = currentKey;
      input.autocomplete = 'off';
      input.setAttribute('data-service', svc);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'key-toggle';
      toggleBtn.textContent = 'Mostrar';
      toggleBtn.addEventListener('click', function() {
        if (input.type === 'password') { input.type = 'text'; toggleBtn.textContent = 'Ocultar'; }
        else { input.type = 'password'; toggleBtn.textContent = 'Mostrar'; }
      });

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
      wrapper.appendChild(toggleBtn);
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
    if (continueBtn) continueBtn.onclick = function() { MembershipGate.showScreen('app-screen'); };
    if (skipBtn) skipBtn.onclick = function() { MembershipGate.showScreen('app-screen'); };
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

    function closeModal() { if (modal) modal.style.display = 'none'; }
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) overlay.addEventListener('click', closeModal);
    if (saveBtn) saveBtn.addEventListener('click', closeModal);
    if (clearBtn) clearBtn.addEventListener('click', function() {
      clearAllKeys();
      renderInputs('modal-key-inputs');
    });
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
    getActiveKey: getActiveKey,
    renderInputs: renderInputs,
    ENABLED_SERVICES: ENABLED_SERVICES,
    AI_SERVICES: AI_SERVICES,
    AI_MODELS: AI_MODELS,
    getModel: getModel,
    setModel: setModel,
    renderModelPicker: renderModelPicker
  };
})();

window.ApiKeyManager = ApiKeyManager;

document.addEventListener('DOMContentLoaded', function() {
  ApiKeyManager.init();
});
