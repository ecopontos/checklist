const navToggle = document.querySelector('.nav-toggle');
const hamburger = document.querySelector('.hamburger-icon');

if (navToggle && hamburger) {
    hamburger.setAttribute('role', 'button');
    hamburger.setAttribute('tabindex', '0');
    hamburger.setAttribute('aria-label', 'Abrir menu de navegação');
    hamburger.setAttribute('aria-expanded', String(navToggle.checked));

    hamburger.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        navToggle.checked = !navToggle.checked;
        hamburger.setAttribute('aria-expanded', String(navToggle.checked));
    });

    navToggle.addEventListener('change', () => {
        hamburger.setAttribute('aria-expanded', String(navToggle.checked));
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !navToggle.checked) return;
        navToggle.checked = false;
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.focus();
    });
}
