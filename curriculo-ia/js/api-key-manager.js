/**
 * BYOK API Key Manager — stores keys in localStorage ONLY.
 * Keys never leave the user's browser. Never sent to any server.
 *
 * Configure AI_SERVICES below for the services this tool uses.
 */
const ApiKeyManager = (function() {
  const STORAGE_PREFIX = 'curriculo-ia_apikey_';

  const AI_SERVICES = {
    openai: {
      name: 'OpenAI',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      prefix: 'sk-',
      required: false
    },
    anthropic: {
      name: 'Anthropic (Claude)',
      placeholder: 'sk-ant-...',
      helpUrl: 'https://console.anthropic.com/',
      prefix: 'sk-ant-',
      required: false
    },
    gemini: {
      name: 'Google (Gemini)',
      placeholder: 'AIza...',
      helpUrl: 'https://aistudio.google.com/apikey',
      prefix: 'AIza',
      required: false
    },
    openrouter: {
      name: 'OpenRouter',
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
      prefix: 'sk-or-',
      required: false
    },
    fal: {
      name: 'FAL.AI',
      placeholder: 'fal-...',
      helpUrl: 'https://fal.ai/dashboard/keys',
      prefix: '',
      required: false
    }
  };

  // Which services this specific tool uses — set during scaffold
  // Modify this array to include only the services needed
  const ENABLED_SERVICES = ['openai', 'openrouter']; // curriculo-ia: BYOK text generation (OpenAI-compatible)

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
        if (input.type === 'password') {
          input.type = 'text';
          toggleBtn.textContent = 'Ocultar';
        } else {
          input.type = 'password';
          toggleBtn.textContent = 'Mostrar';
        }
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
    getActiveKey: getActiveKey,
    renderInputs: renderInputs,
    ENABLED_SERVICES: ENABLED_SERVICES,
    AI_SERVICES: AI_SERVICES
  };
})();

window.ApiKeyManager = ApiKeyManager;

document.addEventListener('DOMContentLoaded', function() {
  ApiKeyManager.init();
});
