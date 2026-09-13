/*
 * Breadcrumb: 2026-09-13 09:30 - Robust Terminal Drawer & Linebreak Preservation Engine
 * [CRITICAL BUGFIX FLAG - TERMINAL FORMATTING]:
 * 1. Guarantees trailing newlines (\n) on all incoming serial logs and cloud dispatches.
 * 2. Clamps DOM text buffer to 40,000 characters to prevent mobile browser memory exhaustion.
 * 3. Mobile touch-friendly drawer toggle and auto-scroll control.
 */

function appendTerminalLog(msg) {
    const cEl = document.getElementById('log-console');
    if (!cEl || !msg) return;

    // Garantiert sauberen Zeilenumbruch
    let formatted = msg;
    if (!formatted.endsWith('\n')) {
        formatted += '\n';
    }

    cEl.innerText += formatted;

    // Speicherüberlauf im DOM verhindern
    if (cEl.innerText.length > 40000) {
        cEl.innerText = cEl.innerText.substring(cEl.innerText.length - 25000);
    }

    if (document.getElementById('terminal-autoscroll')?.checked !== false) {
        cEl.scrollTop = cEl.scrollHeight;
    }
}

function toggleTerminalDrawer() {
    const drawer = document.getElementById('terminal-drawer');
    const icon = document.getElementById('terminal-toggle-icon');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', !isHidden);
    if (icon) icon.innerText = isHidden ? '▼' : '▲';
    if (isHidden) {
        const cEl = document.getElementById('log-console');
        if (cEl) cEl.scrollTop = cEl.scrollHeight;
    }
}

function clearTerminalConsole() {
    const cEl = document.getElementById('log-console');
    if (cEl) cEl.innerText = '';
}
/*
 * Breadcrumb: 2026-09-13 10:15 - Programmatic Terminal Drawer Opener
 */
function ensureTerminalOpen() {
    const drawer = document.getElementById('terminal-drawer');
    const icon = document.getElementById('terminal-toggle-icon');
    if (!drawer) return;
    if (drawer.classList.contains('hidden')) {
        drawer.classList.remove('hidden');
        if (icon) icon.innerText = '▼';
        const cEl = document.getElementById('log-console');
        if (cEl) cEl.scrollTop = cEl.scrollHeight;
    }
}

window.ensureTerminalOpen = ensureTerminalOpen;