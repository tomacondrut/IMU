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

/*
 * Breadcrumb: 2026-10-04 12:55 - Synchronized Wi-Fi Provisioning in Phone Simulator
 * [CRITICAL FEATURE - PORTAL PARITY]:
 * 1. toggleSimPhoneLockModal / submitSimPhoneAuth toggle both #sim-admin-data-sec and #sim-admin-wifi-sec.
 * 2. unlockAndShowWifiSetup(): 1-Click Support guide jump that unlocks admin and scrolls to Wi-Fi.
 * 3. simSaveWifi(): Replicates websocket payload {wifi_ssid, wifi_pass} and writes /settings/wifi.json to terminal log.
 */

/*
 * Breadcrumb: 2026-10-04 13:00 - Auto-Tab Switch & Viewport Scroll on Wi-Fi Unlock
 * [CRITICAL BUGFIX FLAG - ELIMINATE HIDDEN WI-FI PROVISIONING]:
 * 1. Automatically switches to 'conn' tab upon successful admin authentication.
 * 2. Smoothly scrolls #sim-admin-wifi-sec into phone viewport center with a green highlight ring.
 * 3. Uses querySelectorAll to guarantee unhiding even if duplicate modal IDs exist in DOM.
 * 4. Adds direct inline unlock trigger inside locked hint banner.
 */

function toggleSimPhoneLockModal() {
    const dialog = document.getElementById('sim-auth-dialog');
    if (!dialog) return;

    if (simPhoneIsAdmin) {
        // Bei erneutem Klick abmelden
        simPhoneIsAdmin = false;
        document.querySelectorAll('#sim-lock-btn').forEach(btn => btn.innerText = '🔒');
        document.querySelectorAll('#sim-admin-data-sec').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('#sim-admin-wifi-sec').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('#sim-wifi-locked-hint').forEach(el => el.classList.remove('hidden'));
        return;
    }

    const passInput = document.getElementById('sim-admin-pass-input');
    if (passInput) {
        passInput.value = '';
        setTimeout(() => passInput.focus(), 50);
    }
    document.querySelectorAll('#sim-auth-err').forEach(el => el.classList.add('hidden'));
    dialog.classList.toggle('hidden');
}

function submitSimPhoneAuth() {
    const pass = document.getElementById('sim-admin-pass-input')?.value.trim();

    if (pass === 'stag2026') {
        simPhoneIsAdmin = true;

        // 1. Schloss-Icon auf geöffnet setzen
        document.querySelectorAll('#sim-lock-btn').forEach(btn => btn.innerText = '🔓');

        // 2. Alle geschützten Bereiche im Smartphone freischalten
        document.querySelectorAll('#sim-admin-data-sec').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('#sim-admin-wifi-sec').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('#sim-wifi-locked-hint').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('#sim-auth-dialog').forEach(el => el.classList.add('hidden'));

        // 3. ZWINGEND: Sofort auf den Reiter 'Konnektivität' springen
        switchSimPhoneTab('conn');

        // 4. Sanft zum WLAN-Eingabefeld scrollen & visuell hervorheben
        setTimeout(() => {
            const wifiSec = document.getElementById('sim-admin-wifi-sec');
            if (wifiSec) {
                wifiSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
                wifiSec.classList.add('ring-2', 'ring-green-600');
                setTimeout(() => wifiSec.classList.remove('ring-2', 'ring-green-600'), 1500);
            }
        }, 120);

        // 5. Eintrag im Simulator-Terminal
        const cEl = document.getElementById('sim-phone-console');
        if (cEl) {
            cEl.innerText += '\n[AUTH] Admin-Modus autorisiert (stag2026). Vertrauliche Menüs freigegeben.';
            cEl.scrollTop = cEl.scrollHeight;
        }
    } else {
        document.querySelectorAll('#sim-auth-err').forEach(el => el.classList.remove('hidden'));
    }
}

// Direktsprung aus dem Support-Leitfaden (1-Klick ohne Passworteingabe)
function unlockAndShowWifiSetup() {
    simPhoneIsAdmin = true;
    document.querySelectorAll('#sim-lock-btn').forEach(btn => btn.innerText = '🔓');
    document.querySelectorAll('#sim-admin-data-sec').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('#sim-admin-wifi-sec').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('#sim-wifi-locked-hint').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('#sim-auth-dialog').forEach(el => el.classList.add('hidden'));

    switchSimPhoneTab('conn');

    setTimeout(() => {
        const wifiSec = document.getElementById('sim-admin-wifi-sec');
        if (wifiSec) {
            wifiSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
            wifiSec.classList.add('ring-2', 'ring-green-600');
            setTimeout(() => wifiSec.classList.remove('ring-2', 'ring-green-600'), 1500);
        }
    }, 120);
}

function toggleSimWifiPassVisibility() {
    const passInput = document.getElementById('sim-wifi-pass');
    if (!passInput) return;
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
}

function simSaveWifi() {
    const ssid = document.getElementById('sim-wifi-ssid')?.value.trim();
    const pass = document.getElementById('sim-wifi-pass')?.value;
    const statEl = document.getElementById('sim-wifi-save-status');

    if (!ssid) {
        if (statEl) {
            statEl.innerText = 'SSID darf nicht leer sein!';
            statEl.className = 'text-[10px] text-red-600 font-bold text-center';
            statEl.classList.remove('hidden');
        }
        return;
    }

    if (statEl) {
        statEl.innerText = 'WLAN-Zugang auf SD gespeichert!';
        statEl.className = 'text-[10px] text-green-700 font-bold text-center';
        statEl.classList.remove('hidden');
        setTimeout(() => statEl.classList.add('hidden'), 4000);
    }

    // Terminal im Simulator nachführen
    const cEl = document.getElementById('sim-phone-console');
    if (cEl) {
        cEl.innerText += `\n[WIFI SD] Zugangsdaten in /settings/wifi.json gesichert: SSID='${ssid}'`;
        cEl.scrollTop = cEl.scrollHeight;
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

/*
* Breadcrumb: 2026-10-04 16:45 - Phone Simulator LTE Toggle & Power-Down Controller
* [CRITICAL FEATURE - SIMULATOR PARITY WITH DASHBOARD_PAGE]:
* 1. toggleSimLteModule(): Replicates the toggleLteModule() portal mechanism.
* 2. Visualizes active (#009B4C) vs. deactivated (#ef4444) modem state.
* 3. Appends battery-saving power-down logs to simulated phone console.
* Dismissed: Static unclickable text label in simulator screen.
*/
let simLteModuleActive = true;

function toggleSimLteModule() {
    simLteModuleActive = !simLteModuleActive;
    const btn = document.getElementById('sim-btn-lte-toggle');
    if (btn) {
        btn.innerText = simLteModuleActive ? 'LTE: AKTIV' : 'LTE: DEAKTIVIERT';
        btn.className = simLteModuleActive
            ? 'bg-green-700 hover:bg-green-800 text-white font-bold px-2.5 py-0.5 rounded text-[9px] transition shadow-sm'
            : 'bg-red-600 hover:bg-red-700 text-white font-bold px-2.5 py-0.5 rounded text-[9px] transition shadow-sm';
    }

    const cEl = document.getElementById('sim-phone-console');
    if (cEl) {
        if (!simLteModuleActive) {
            cEl.innerText += '\n[CONFIG] LTE-Modul über Web-Dashboard deaktiviert & stromlos geschaltet (Akkuschonung aktiv).';
        } else {
            cEl.innerText += '\n[CONFIG] LTE-Modul über Web-Dashboard reaktiviert.';
        }
        cEl.scrollTop = cEl.scrollHeight;
    }
}

/*
* Breadcrumb: 2026-10-04 17:35 - Simulator Button Highlighting & Direct Deep-Links
* [CRITICAL FEATURE - INTERACTIVE SUPPORT GUIDE FEEDBACK]:
* 1. highlightSimLteTest(): Switches to 'conn' tab, smoothly scrolls to 'sim-btn-test-lte',
*    and flashes a pulsing yellow ring around the button so the user sees where to tap.
* 2. highlightSimLteToggle(): Switches to 'conn' tab, smoothly scrolls to 'sim-btn-lte-toggle',
*    and pulses a highlight ring.
*/

function highlightSimLteTest() {
    switchSimPhoneTab('conn');
    setTimeout(() => {
        const btn = document.getElementById('sim-btn-test-lte');
        if (btn) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.classList.add('ring-4', 'ring-amber-400', 'scale-105');
            setTimeout(() => {
                btn.classList.remove('ring-4', 'ring-amber-400', 'scale-105');
            }, 1800);
        }
    }, 100);
}

function highlightSimLteToggle() {
    switchSimPhoneTab('conn');
    setTimeout(() => {
        const btn = document.getElementById('sim-btn-lte-toggle');
        if (btn) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.classList.add('ring-4', 'ring-amber-400', 'scale-105');
            setTimeout(() => {
                btn.classList.remove('ring-4', 'ring-amber-400', 'scale-105');
            }, 1800);
        }
    }, 100);
}

/*
* Breadcrumb: 2026-10-04 17:50 - Header Lock Highlighting Controller
* [CRITICAL FEATURE - VISUAL GUIDANCE FOR EXTENDED ADMIN MENU]:
* Scrolls to the top of the simulated phone screen and flashes a pulsing 
* highlight ring around #sim-lock-btn in the header bar.
*/
function highlightSimLock() {
    const scrollContainer = document.getElementById('sim-portal-scroll');
    if (scrollContainer) {
        scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setTimeout(() => {
        const lockBtn = document.getElementById('sim-lock-btn');
        if (lockBtn) {
            lockBtn.classList.add('ring-4', 'ring-amber-400', 'scale-125');
            setTimeout(() => {
                lockBtn.classList.remove('ring-4', 'ring-amber-400', 'scale-125');
            }, 1800);
        }
    }, 100);
}