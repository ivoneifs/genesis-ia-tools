/**
 * BYOK API Key Manager — stores keys in localStorage ONLY.
 * Keys never leave the user's browser. Never sent to any server (Hard Rule #1).
 *
 * VSL IA is a TEXT tool: OpenRouter (one key → every model), plus native
 * OpenAI and Google (Gemini) keys as alternatives.
 */
const ApiKeyManager = (function() {
  const STORAGE_PREFIX = 'vsl-ia_apikey_';

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
    gemini: {
      name: 'Google (Gemini)',
      placeholder: 'AIza...',
      helpUrl: 'https://aistudio.google.com/apikey',
      prefix: 'AIza',
      required: false
    }
  };

  // Which services this tool offers. OpenRouter first so it is the default active key.
  const ENABLED_SERVICES = ['openrouter', 'openai', 'gemini'];

  // ── Model catalog (Hard Rule #19 + protocols/model-selection.md) ──
  // Provider-grouped picker. Routed through OpenRouter (provider-prefixed ids) so
  // ONE BYOK key reaches every provider.
  // Refreshed from the LIVE OpenRouter ranking on 2026-07-11 (/api/v1/models); each
  // id verified present/routable this build.
  const AI_MODELS = {
    claude: {
      label: 'Claude (Anthropic)',
      models: [
        { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
        { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }
      ]
    },
    openai: {
      label: 'OpenAI',
      models: [
        { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6' },
        { id: 'openai/gpt-5.6-terra-pro', name: 'GPT-5.6 Pro' },
        { id: 'openai/gpt-chat-latest', name: 'GPT (mais recente)' }
      ]
    },
    google: {
      label: 'Google (Gemini)',
      models: [
        { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' }
      ]
    },
    deepseek: {
      label: 'DeepSeek',
      models: [
        { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek V3.1' },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' }
      ]
    },
    trending: {
      label: 'Em alta (OpenRouter)',
      // Live OpenRouter trending — refreshed 2026-07-11.
      models: [
        { id: 'x-ai/grok-4.5', name: 'Grok 4.5 (xAI)' },
        { id: 'z-ai/glm-5.2', name: 'GLM 5.2 (Z.ai)' },
        { id: 'minimax/minimax-m3', name: 'MiniMax M3' },
        { id: 'qwen/qwen3.7-max', name: 'Qwen3.7 Max' }
      ]
    }
  };

  const DEFAULT_MODEL = 'google/gemini-3.5-flash';
  const MODEL_STORAGE_KEY = STORAGE_PREFIX + 'model';

  function getModel() {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL; }
    catch { return DEFAULT_MODEL; }
  }

  function setModel(modelId) {
    try { if (modelId) localStorage.setItem(MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
  }

  // Populate a <select> with provider-grouped <optgroup>s (COR-041: EXPORTED, not
  // auto-run — every model <select> gets its own render call, or it ships empty).
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
    // keep all pickers in sync when one changes
    select.addEventListener('change', function() {
      setModel(select.value);
      syncPickers(select.value);
    });
  }

  function syncPickers(value) {
    ['model-select', 'key-model-select', 'model-select-modal'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el && el.value !== value) el.value = value;
    });
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
      label.textContent = config.name + (svc === 'openrouter' ? ' (recomendado)' : ' (opcional)');

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
        renderModelPicker('model-select-modal'); // COR-041
        modal.style.display = 'flex';
      });
    }
    function closeModal() { if (modal) modal.style.display = 'none'; }
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) overlay.addEventListener('click', closeModal);
    if (saveBtn) saveBtn.addEventListener('click', closeModal);
    if (clearBtn) clearBtn.addEventListener('click', function() { clearAllKeys(); renderInputs('modal-key-inputs'); });
  }

  function init() {
    renderInputs('key-inputs');
    renderModelPicker('key-model-select'); // COR-041 — key-setup screen picker
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
