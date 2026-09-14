/*
 * Breadcrumb: 2026-09-14 21:00 - textContent DOM Node Linebreak Preservation Engine
 * [CRITICAL BUGFIX FLAG - PRESERVE NEWLINES IN HIDDEN TERMINAL]:
 * 1. Replaced cEl.innerText with cEl.append() / cEl.textContent.
 *    Fixes bug where hidden (display: none) drawer collapsed \n into spaces before opening.
 * 2. Clamps textContent to 40,000 chars without losing format.
 * 3. Ensures smooth auto-scroll to bottom upon opening drawer.
 */

function appendTerminalLog(msg) {
    const cEl = document.getElementById('log-console');
    if (!cEl || !msg) return;

    // Sauberen Zeilenumbruch sicherstellen
    let formatted = msg;
    if (!formatted.endsWith('\n')) {
        formatted += '\n';
    }

    // append() statt innerText: Bewahrt alle \n auch bei display:none
    cEl.append(formatted);

    // Pufferdeckel gegen DOM-Überlauf
    if (cEl.textContent.length > 40000) {
        cEl.textContent = cEl.textContent.substring(cEl.textContent.length - 25000);
    }

    // Auto-Scroll nur anwenden, wenn das Terminal geöffnet ist
    const drawer = document.getElementById('terminal-drawer');
    const isVisible = drawer && !drawer.classList.contains('hidden');
    if (isVisible && document.getElementById('terminal-autoscroll')?.checked !== false) {
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

    // Beim Aufklappen sofort ans Ende der Historie scrollen
    if (isHidden) {
        const cEl = document.getElementById('log-console');
        if (cEl) {
            setTimeout(() => { cEl.scrollTop = cEl.scrollHeight; }, 30);
        }
    }
}

function clearTerminalConsole() {
    const cEl = document.getElementById('log-console');
    if (cEl) cEl.textContent = '';
}

function ensureTerminalOpen() {
    const drawer = document.getElementById('terminal-drawer');
    const icon = document.getElementById('terminal-toggle-icon');
    if (!drawer) return;
    if (drawer.classList.contains('hidden')) {
        drawer.classList.remove('hidden');
        if (icon) icon.innerText = '▼';
        const cEl = document.getElementById('log-console');
        if (cEl) {
            setTimeout(() => { cEl.scrollTop = cEl.scrollHeight; }, 30);
        }
    }
}

window.appendTerminalLog = appendTerminalLog;
window.toggleTerminalDrawer = toggleTerminalDrawer;
window.clearTerminalConsole = clearTerminalConsole;
window.ensureTerminalOpen = ensureTerminalOpen;