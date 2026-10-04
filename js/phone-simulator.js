// JavaScript source code
/*
 * Breadcrumb: 2026-10-04 12:00 - Phone Simulator Engine & Modal Cellular Config Controller
 * [CRITICAL FEATURE - CAPTIVE PORTAL PHONE SIMULATOR & SEPARATE SIM CONFIG]:
 * 1. Controls #sim-config-modal: Decouples PIN/APN editing while syncing hidden inputs for Cloud sync.
 * 2. Controls #phone-simulator-modal: Interactive smartphone frame replicating DASHBOARD_PAGE 1:1.
 * 3. Simulates tab navigation, lock authorization (stag2026), live mini-waveforms and terminal prints.
 */

// ============================================================================
// 1. SEPARATE MOBILFUNK-KONFIGURATION (MODAL CONTROLLER)
// ============================================================================

function openSimConfigModal() {
    const modal = document.getElementById('sim-config-modal');
    if (!modal) return;

    // Aktuelle Werte aus den synchronisierten Feldern übernehmen
    const currentApn = document.getElementById('cfg-sim-apn')?.value || 'gprs.swisscom.ch';
    const currentPin = document.getElementById('cfg-sim-pin')?.value || '';

    const apnInput = document.getElementById('modal-sim-apn');
    const pinInput = document.getElementById('modal-sim-pin');
    const presetSelect = document.getElementById('modal-sim-preset');

    if (apnInput) apnInput.value = currentApn;
    if (pinInput) pinInput.value = currentPin;

    if (presetSelect) {
        let matched = false;
        for (let opt of presetSelect.options) {
            if (opt.value === currentApn) {
                presetSelect.value = currentApn;
                matched = true;
                break;
            }
        }
        if (!matched) presetSelect.value = 'CUSTOM';
    }

    modal.classList.remove('hidden');
}

function closeSimConfigModal() {
    const modal = document.getElementById('sim-config-modal');
    if (modal) modal.classList.add('hidden');
}

function applySimPreset(presetValue) {
    if (presetValue === 'CUSTOM') return;
    const apnInput = document.getElementById('modal-sim-apn');
    if (apnInput) apnInput.value = presetValue;
}

function toggleSimPinVisibility() {
    const pinInput = document.getElementById('modal-sim-pin');
    if (!pinInput) return;
    pinInput.type = pinInput.type === 'password' ? 'text' : 'password';
}

function handleSaveSimConfigModal(event) {
    event.preventDefault();
    const newApn = document.getElementById('modal-sim-apn')?.value.trim() || 'gprs.swisscom.ch';
    const newPin = document.getElementById('modal-sim-pin')?.value.trim() || '';

    // Hidden Inputs im Parameter-Tab aktualisieren (damit saveConfigToCloud() sie erfasst)
    const hiddenApn = document.getElementById('cfg-sim-apn');
    const hiddenPin = document.getElementById('cfg-sim-pin');
    if (hiddenApn) hiddenApn.value = newApn;
    if (hiddenPin) hiddenPin.value = newPin;

    // Badges auf der Hauptseite aktualisieren
    const badgeApn = document.getElementById('cfg-sim-apn-badge');
    const badgePin = document.getElementById('cfg-sim-pin-badge');
    if (badgeApn) badgeApn.innerText = newApn;
    if (badgePin) {
        badgePin.innerText = newPin.length > 0 ? '•••• (Gesetzt)' : 'Keine PIN';
    }

    closeSimConfigModal();

    // Sofort in Cloud sichern, falls Funktion verfügbar
    if (typeof saveConfigToCloud === 'function') {
        saveConfigToCloud();
    }
}

// ============================================================================
// 2. SMARTPHONE SIMULATOR ENGINE (CAPTIVE PORTAL PARITY)
// ============================================================================

let simPhoneWaveInterval = null;
let simPhoneIsAdmin = false;

function openPhoneSimulatorModal() {
    const modal = document.getElementById('phone-simulator-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    // Uhrzeit der Smartphone-Statusleiste aktualisieren
    const clockEl = document.getElementById('sim-phone-clock');
    if (clockEl) {
        const d = new Date();
        clockEl.innerText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    switchSimPhoneTab('sensors');
    startSimWaveAnimation();
}

function closePhoneSimulatorModal() {
    const modal = document.getElementById('phone-simulator-modal');
    if (modal) modal.classList.add('hidden');
    if (simPhoneWaveInterval) {
        clearInterval(simPhoneWaveInterval);
        simPhoneWaveInterval = null;
    }
}

function switchSimPhoneTab(tabKey) {
    const tabs = ['sensors', 'data', 'conn', 'term'];
    tabs.forEach(t => {
        const el = document.getElementById(`sim-tab-${t}`);
        const btn = document.getElementById(`sim-btn-${t}`);
        if (el) el.classList.add('hidden');
        if (btn) {
            btn.className = "flex-1 py-1.5 px-2 bg-white text-slate-700 border border-slate-300 rounded text-[10px] font-bold whitespace-nowrap";
        }
    });

    const activeEl = document.getElementById(`sim-tab-${tabKey}`);
    const activeBtn = document.getElementById(`sim-btn-${tabKey}`);
    if (activeEl) activeEl.classList.remove('hidden');
    if (activeBtn) {
        activeBtn.className = "flex-1 py-1.5 px-2 bg-green-700 text-white rounded text-[10px] font-bold whitespace-nowrap shadow-sm";
    }

    // Scroll nach oben zurücksetzen
    const scrollContainer = document.getElementById('sim-portal-scroll');
    if (scrollContainer) scrollContainer.scrollTop = 0;
}

function toggleSimPhoneLockModal() {
    const dialog = document.getElementById('sim-auth-dialog');
    if (!dialog) return;

    if (simPhoneIsAdmin) {
        // Bei erneutem Klick abmelden
        simPhoneIsAdmin = false;
        document.getElementById('sim-lock-btn').innerText = '🔒';
        document.getElementById('sim-admin-data-sec')?.classList.add('hidden');
        return;
    }

    document.getElementById('sim-admin-pass-input').value = '';
    document.getElementById('sim-auth-err')?.classList.add('hidden');
    dialog.classList.toggle('hidden');
}

function submitSimPhoneAuth() {
    const pass = document.getElementById('sim-admin-pass-input')?.value;
    if (pass === 'stag2026') {
        simPhoneIsAdmin = true;
        document.getElementById('sim-lock-btn').innerText = '🔓';
        document.getElementById('sim-admin-data-sec')?.classList.remove('hidden');
        document.getElementById('sim-auth-dialog')?.classList.add('hidden');
    } else {
        document.getElementById('sim-auth-err')?.classList.remove('hidden');
    }
}

function simTriggerTest() {
    switchSimPhoneTab('term');
    const consoleEl = document.getElementById('sim-phone-console');
    if (consoleEl) {
        consoleEl.innerText += `\n\n[LTE TEST] Starte Diagnoselauf...\n[AT TX] AT+CPIN?\n[AT RX] +CPIN: READY\n[AT TX] AT+CEREG?\n[AT RX] +CEREG: 0,1 (Home Cat-M1)\n[AT TX] AT+CSQ\n[AT RX] +CSQ: 22,0 (-69 dBm)\n>>> LTE-Diagnosetest erfolgreich! <<<`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
}

function clearSimConsole() {
    const consoleEl = document.getElementById('sim-phone-console');
    if (consoleEl) consoleEl.innerText = '[CONSOLE CLEARED]';
}

function startSimWaveAnimation() {
    const cv = document.getElementById('sim-cv-acc');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let t = 0;

    if (simPhoneWaveInterval) clearInterval(simPhoneWaveInterval);

    simPhoneWaveInterval = setInterval(() => {
        if (!document.getElementById('sim-tab-sensors') || document.getElementById('sim-tab-sensors').classList.contains('hidden')) return;

        cv.width = cv.clientWidth || 300;
        cv.height = cv.clientHeight || 40;
        const w = cv.width;
        const h = cv.height;

        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#009B4C';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let x = 0; x < w; x++) {
            const y = (h / 2) + Math.sin((x * 0.08) + t) * (h * 0.3) * Math.sin(x * 0.02);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        t += 0.15;
    }, 50);
}