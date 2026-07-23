(() => {
  const STORAGE_KEY = 'satelite_theme';
  const LIGHT = 'light';
  const DARK = 'dark';

  function readStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) === LIGHT ? LIGHT : DARK;
    } catch {
      return DARK;
    }
  }

  function updateControls(theme) {
    const isLight = theme === LIGHT;
    document.querySelectorAll('[data-theme-toggle]').forEach((control) => {
      if (control instanceof HTMLInputElement) {
        control.checked = isLight;
      } else {
        control.textContent = isLight ? '☾' : '☀';
        control.setAttribute('aria-checked', String(isLight));
        control.setAttribute('aria-label', isLight ? 'Usar modo escuro' : 'Usar modo claro');
        control.title = isLight ? 'Usar modo escuro' : 'Usar modo claro';
      }
    });
  }

  function applyTheme(theme, persist = true) {
    const normalizedTheme = theme === LIGHT ? LIGHT : DARK;
    document.documentElement.dataset.theme = normalizedTheme;
    document.documentElement.style.colorScheme = normalizedTheme;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, normalizedTheme);
      } catch {
        // The selected theme still applies for the current page.
      }
    }
    updateControls(normalizedTheme);
  }

  function createMenuControl(nav) {
    const control = document.createElement('label');
    control.className = 'theme-control';

    const label = document.createElement('span');
    label.className = 'theme-control-label';
    label.textContent = 'Modo claro';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.themeToggle = '';
    input.setAttribute('aria-label', 'Ativar modo claro');
    input.checked = document.documentElement.dataset.theme === LIGHT;
    input.addEventListener('change', () => applyTheme(input.checked ? LIGHT : DARK));

    const track = document.createElement('span');
    track.className = 'theme-switch';
    track.setAttribute('aria-hidden', 'true');

    control.append(label, input, track);
    nav.appendChild(control);
  }

  function createFloatingControl() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-icon-button';
    button.dataset.themeToggle = '';
    button.setAttribute('role', 'switch');
    button.addEventListener('click', () => {
      const nextTheme = document.documentElement.dataset.theme === LIGHT ? DARK : LIGHT;
      applyTheme(nextTheme);
    });
    document.body.appendChild(button);
  }

  function mountControl() {
    const nav = document.querySelector('.page-nav');
    if (nav) createMenuControl(nav);
    else createFloatingControl();
    updateControls(document.documentElement.dataset.theme);
  }

  applyTheme(readStoredTheme(), false);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountControl, { once: true });
  } else {
    mountControl();
  }

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyTheme(event.newValue, false);
  });
})();
