/*
 * Breadcrumb: 2026-09-13 09:30 - Main Orchestrator & Multi-Device Selector
 * [CRITICAL BUGFIX FLAG - DYNAMIC SUBSCRIBER SWITCH]:
 * 1. onDeviceSelectChange() cleanly closes active Realtime channels before resubscribing to the new ID.
 * 2. switchTab() triggers domain-specific lifecycle hooks (Three.js resize, folder reload).
 * 3. Centralized fetchAllData() coordinating across all active modules.
 */

/*
 * Breadcrumb: 2026-09-13 09:30 - Main Orchestrator & Multi-Device Selector
 * [CRITICAL BUGFIX FLAG - DYNAMIC SUBSCRIBER SWITCH]:
 * 1. onDeviceSelectChange() cleanly closes active Realtime channels before resubscribing to the new ID.
 * 2. switchTab() triggers domain-specific lifecycle hooks (Three.js resize, folder reload).
 * 3. Centralized fetchAllData() coordinating across all active modules.
 */

/*
 * Breadcrumb: 2026-09-13 09:30 - Main Orchestrator & Multi-Device Selector
 * [CRITICAL BUGFIX FLAG - DYNAMIC SUBSCRIBER SWITCH]:
 * 1. onDeviceSelectChange() cleanly closes active Realtime channels before resubscribing to the new ID.
 * 2. switchTab() triggers domain-specific lifecycle hooks (Three.js resize, folder reload).
 * 3. Centralized fetchAllData() coordinating across all active modules.
 */
function onDeviceSelectChange(newId) {
    selectedDeviceId = newId;
    appendTerminalLog(`\n[PORTAL] Aktives Gerät gewechselt auf: ${selectedDeviceId}`);

    if (window.closeImuReplayDeck) {
        window.closeImuReplayDeck();
    }

    initRealtimeChannel();
    if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs();

    if (cloudCmdChannel) {
        sbClient.removeChannel(cloudCmdChannel);
        cloudCmdChannel = null;
        initCloudCommandChannel();
    }

    accHistory.length = 0;
    graphNeedsRedraw = true;

    fetchAllData();

    if (!document.getElementById('tab-files').classList.contains('hidden')) {
        loadCloudSdDirectory(currentCloudSdDir);
    }
}

/*
 * Breadcrumb: 2026-09-20 09:55 - Deduplicated switchTab Lifecycle Hooks
 * [CRITICAL BUGFIX FLAG - CLEAN TAB ROUTING]:
 * Cleaned single execution of fetchConfig() and updateLockUI() on tab switch.
 * Breadcrumb: 2026-09-28 19:45 - Replay-Protected Watchdog & Lifecycle Router
 * [CRITICAL BUGFIX FLAG - NON-INTRUSIVE STREAM SWITCHING]:
 * 1. Watchdog checks if #imu-replay-deck is active before triggering automated switchTab('3d').
 * 2. switchTab('imulogs') triggers resizeReplayDeck() to restore WebGL and Canvas bounds on return.
 * 3. onDeviceSelectChange automatically closes active replay session of previous device.
 * 4. Dismissed code: unconditioned switchTab('3d') throwing user out of active replay deck.
 * Breadcrumb: 2026-10-04 12:20 - Direct Cellular Badge Refresh on Settings Tab
 * [UI PARITY]: Triggers updateCellularBadges() immediately when switching to settings.
 */
function switchTab(tab) {
    ['3d', 'imulogs', 'files', 'settings', 'ota'].forEach(t => {
        const tabEl = document.getElementById(`tab-${t}`);
        const btnEl = document.getElementById(`btn-tab-${t}`);
        if (tabEl) tabEl.classList.add('hidden');
        if (btnEl) btnEl.className = "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 px-3.5 py-2 rounded-lg text-xs font-bold uppercase whitespace-nowrap transition flex items-center gap-1.5";
    });

    const activeTab = document.getElementById(`tab-${tab}`);
    const activeBtn = document.getElementById(`btn-tab-${tab}`);
    if (activeTab) activeTab.classList.remove('hidden');
    if (activeBtn) activeBtn.className = "bg-stag-green text-white px-3.5 py-2 rounded-lg text-xs font-bold uppercase whitespace-nowrap shadow-sm transition flex items-center gap-1.5";

    if (tab !== 'files' && activeCommandPollTimer) {
        clearInterval(activeCommandPollTimer);
        activeCommandPollTimer = null;
    }

    if (tab === '3d') {
        setTimeout(() => {
            if (window.resize3DViewport) window.resize3DViewport();
            if (window.drawAccGraphs) window.drawAccGraphs();
        }, 80);
    }
    if (tab === 'imulogs') {
        if (window.fetchImuCloudLogs) window.fetchImuCloudLogs();
        setTimeout(() => {
            if (window.resizeReplayDeck) window.resizeReplayDeck();
        }, 80);
    }
    if (tab === 'files') loadCloudSdDirectory(currentCloudSdDir);
    if (tab === 'settings') {
        fetchConfig();
        updateCellularBadges();
        if (window.updateLockUI) window.updateLockUI();
    }
    if (tab === 'ota' && window.fetchReleases) window.fetchReleases();
}

/*
 * Breadcrumb: 2026-10-04 12:25 - Standalone Cellular Badge Sync & Clean Pipeline
 * [CRITICAL BUGFIX FLAG - ELIMINATE RECURSIVE MONKEYPATCH LEAK]:
 * 1. Extracted badge sync into updateCellularBadges() helper.
 * 2. Purged dynamic monkey-patching of window.fetchConfig inside fetchAllData()
 *    which created a recursive function wrapper chain on every device switch.
 * 3. Guarantees badges update both on initial boot and subsequent tab switches.
 */
function updateCellularBadges() {
    setTimeout(() => {
        const apn = document.getElementById('cfg-sim-apn')?.value;
        const pin = document.getElementById('cfg-sim-pin')?.value;
        const bApn = document.getElementById('cfg-sim-apn-badge');
        const bPin = document.getElementById('cfg-sim-pin-badge');
        if (bApn && apn) bApn.innerText = apn;
        if (bPin) bPin.innerText = (pin && pin.length > 0) ? '•••• (Gesetzt)' : 'Keine PIN';
    }, 150);
}

function fetchAllData() {
    if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    fetchConfig();
    updateCellularBadges();
    if (window.fetchReleases) window.fetchReleases();
    if (window.fetchImuCloudLogs) window.fetchImuCloudLogs();
}

/*
 * Breadcrumb: 2026-09-28 20:05 - Fixed SyntaxError duplicate watchdog block in window.onload
 * [CRITICAL BUGFIX FLAG - RESTORE EXECUTION OF MAIN ENGINE]:
 * Removed dangling duplicated setInterval block that threw a fatal SyntaxError crashing entire runtime.
 * Breadcrumb: 2026-09-28 20:30 - Restored Clean Orchestrator Lifecycle
 * [CRITICAL BUGFIX FLAG - REMOVED DANGLING SYNTAX FRAGMENT]:
 * 1. Cleaned window.onload and removed the duplicate setInterval block that crashed runtime.
 * 2. Watchdog preserves active replay sessions without forcefully switching to 3d tab.
 * 3. Dismissed code: trailing orphan '}, 1000); };' fragment.
 */
window.onload = () => {
    if (window.init3D) window.init3D();
    initRealtimeChannel();
    if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs();
    fetchAllData();

    // Koordinatengitter sofort beim Laden initialisieren
    setTimeout(() => {
        if (window.drawAccGraphs) window.drawAccGraphs();
    }, 100);

    setInterval(() => {
        if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    }, 30000);

    // ========================================================================
    // STREAM WATCHDOG: Steuert 3D-Tab UND das Status-Badge (STANDBY <-> LIVE)
    // ========================================================================
    let wasStreaming = false;
    setInterval(() => {
        const isStreaming = (Date.now() - (window.lastLiveTelemetryTime || 0)) < 6000;
        const btn3d = document.getElementById('btn-tab-3d');
        const tab3d = document.getElementById('tab-3d');
        const ind = document.getElementById('realtime-indicator');

        // 1. Status-Badge synchron mit Datenfluss umschalten
        if (ind) {
            if (isStreaming) {
                ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ${selectedDeviceId} LIVE`;
                ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-300';
            } else {
                ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> ${selectedDeviceId} STANDBY`;
                ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-300';
            }
        }

        const replayDeck = document.getElementById('imu-replay-deck');
        const isReplayOpen = replayDeck && !replayDeck.classList.contains('hidden');

        // 2. 3D-Tab ein- / ausblenden (unterbricht Replay nicht eigenmächtig)
        if (isStreaming && !wasStreaming) {
            wasStreaming = true;
            if (btn3d) btn3d.style.display = 'flex';
            if (!isReplayOpen) {
                switchTab('3d');
            }
        } else if (!isStreaming && wasStreaming) {
            wasStreaming = false;
            if (btn3d) btn3d.style.display = 'none';

            if (tab3d && !tab3d.classList.contains('hidden')) {
                switchTab('imulogs');
            }
        }
    }, 1000);
};

/*
 * Breadcrumb: 2026-10-04 12:25 - Standalone Cellular Badge Sync & Clean Pipeline
 * [CRITICAL BUGFIX FLAG - ELIMINATE RECURSIVE MONKEYPATCH LEAK]:
 * 1. Extracted badge sync into updateCellularBadges() helper.
 * 2. Purged dynamic monkey-patching of window.fetchConfig inside fetchAllData()
 *    which created a recursive function wrapper chain on every device switch.
 * 3. Guarantees badges update both on initial boot and subsequent tab switches.
 */
function updateCellularBadges() {
    setTimeout(() => {
        const apn = document.getElementById('cfg-sim-apn')?.value;
        const pin = document.getElementById('cfg-sim-pin')?.value;
        const bApn = document.getElementById('cfg-sim-apn-badge');
        const bPin = document.getElementById('cfg-sim-pin-badge');
        if (bApn && apn) bApn.innerText = apn;
        if (bPin) bPin.innerText = (pin && pin.length > 0) ? '•••• (Gesetzt)' : 'Keine PIN';
    }, 150);
}

function fetchAllData() {
    if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    fetchConfig();
    updateCellularBadges();
    if (window.fetchReleases) window.fetchReleases();
    if (window.fetchImuCloudLogs) window.fetchImuCloudLogs();
}

/*
 * Breadcrumb: 2026-09-28 20:05 - Fixed SyntaxError duplicate watchdog block in window.onload
 * [CRITICAL BUGFIX FLAG - RESTORE EXECUTION OF MAIN ENGINE]:
 * Removed dangling duplicated setInterval block that threw a fatal SyntaxError crashing entire runtime.
 */
/*
 * Breadcrumb: 2026-09-28 20:30 - Restored Clean Orchestrator Lifecycle
 * [CRITICAL BUGFIX FLAG - REMOVED DANGLING SYNTAX FRAGMENT]:
 * 1. Cleaned window.onload and removed the duplicate setInterval block that crashed runtime.
 * 2. Watchdog preserves active replay sessions without forcefully switching to 3d tab.
 * 3. Dismissed code: trailing orphan '}, 1000); };' fragment.
 */
window.onload = () => {
    if (window.init3D) window.init3D();
    initRealtimeChannel();
    if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs();
    fetchAllData();

    // Koordinatengitter sofort beim Laden initialisieren
    setTimeout(() => {
        if (window.drawAccGraphs) window.drawAccGraphs();
    }, 100);

    setInterval(() => {
        if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    }, 30000);

    // ========================================================================
    // STREAM WATCHDOG: Steuert 3D-Tab UND das Status-Badge (STANDBY <-> LIVE)
    // ========================================================================
    let wasStreaming = false;
    setInterval(() => {
        const isStreaming = (Date.now() - (window.lastLiveTelemetryTime || 0)) < 6000;
        const btn3d = document.getElementById('btn-tab-3d');
        const tab3d = document.getElementById('tab-3d');
        const ind = document.getElementById('realtime-indicator');

        // 1. Status-Badge synchron mit Datenfluss umschalten
        if (ind) {
            if (isStreaming) {
                ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ${selectedDeviceId} LIVE`;
                ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-300';
            } else {
                ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> ${selectedDeviceId} STANDBY`;
                ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-300';
            }
        }

        const replayDeck = document.getElementById('imu-replay-deck');
        const isReplayOpen = replayDeck && !replayDeck.classList.contains('hidden');

        // 2. 3D-Tab ein- / ausblenden (unterbricht Replay nicht eigenmächtig)
        if (isStreaming && !wasStreaming) {
            wasStreaming = true;
            if (btn3d) btn3d.style.display = 'flex';
            if (!isReplayOpen) {
                switchTab('3d');
            }
        } else if (!isStreaming && wasStreaming) {
            wasStreaming = false;
            if (btn3d) btn3d.style.display = 'none';

            if (tab3d && !tab3d.classList.contains('hidden')) {
                switchTab('imulogs');
            }
        }
    }, 1000);
};