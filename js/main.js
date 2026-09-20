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

    // Bestehende Realtime- und Postgres-Channels trennen & auf neue ID binden
    initRealtimeChannel();
    if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs();

    if (cloudCmdChannel) {
        sbClient.removeChannel(cloudCmdChannel);
        cloudCmdChannel = null;
        initCloudCommandChannel();
    }

    // Puffer und Visualisierungen zurücksetzen
    accHistory.length = 0;
    graphNeedsRedraw = true;

    // Alle Daten des neuen Geräts abrufen
    fetchAllData();

    // Falls SD-Tab aktiv ist, Verzeichnis sofort neu anfordern
    if (!document.getElementById('tab-files').classList.contains('hidden')) {
        loadCloudSdDirectory(currentCloudSdDir);
    }
}

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
    if (tab === 'imulogs' && window.fetchImuCloudLogs) window.fetchImuCloudLogs();
    if (tab === 'files') loadCloudSdDirectory(currentCloudSdDir);
    if (tab === 'settings') {
        fetchConfig();
        if (window.updateLockUI) window.updateLockUI();
    }
    if (tab === 'ota' && window.fetchReleases) window.fetchReleases();
}

function fetchAllData() {
    if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    fetchConfig();
    if (window.fetchReleases) window.fetchReleases();
    if (window.fetchImuCloudLogs) window.fetchImuCloudLogs();
}

window.onload = () => {
    if (window.init3D) window.init3D();
    initRealtimeChannel();
    if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs(); // <--- NEU
    fetchAllData();


    // [BUGFIX]: Zeichnet das Koordinatengitter sofort beim Laden,
    // noch bevor das erste Sensorpaket aus der Cloud eintrifft.
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

        // 2. 3D-Tab ein- / ausblenden
        if (isStreaming && !wasStreaming) {
            wasStreaming = true;
            if (btn3d) btn3d.style.display = 'flex';
            switchTab('3d');
        }
        else if (!isStreaming && wasStreaming) {
            wasStreaming = false;
            if (btn3d) btn3d.style.display = 'none';

            if (tab3d && !tab3d.classList.contains('hidden')) {
                switchTab('imulogs');
            }
        }
    }, 1000);
};