/*
 * Breadcrumb: 2026-09-13 09:30 - Main Orchestrator & Multi-Device Selector
 * [CRITICAL BUGFIX FLAG - DYNAMIC SUBSCRIBER SWITCH]:
 * 1. onDeviceSelectChange() cleanly closes active Realtime channels before resubscribing to the new ID.
 * 2. switchTab() triggers domain-specific lifecycle hooks (Three.js resize, folder reload).
 * 3. Centralized fetchAllData() coordinating across all active modules.
 */

selectedDeviceId = newId;
appendTerminalLog(`\n[PORTAL] Aktives Gerät gewechselt auf: ${selectedDeviceId}`);

// Bestehende Realtime- und Postgres-Channels trennen & auf neue ID binden
initRealtimeChannel();
if (window.subscribeToBatteryLogs) window.subscribeToBatteryLogs(); // <--- NE

    // Bestehende Realtime- und Postgres-Channels trennen & auf neue ID binden
    initRealtimeChannel();
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
    if (tab === 'settings') fetchConfig();
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
    // NEU: STREAM WATCHDOG - Steuert Sichtbarkeit des 3D-Tabs
    // ========================================================================
    let wasStreaming = false;
    setInterval(() => {
        // Stream gilt als aktiv, wenn das letzte Paket jünger als 6 Sekunden ist
        const isStreaming = (Date.now() - (window.lastLiveTelemetryTime || 0)) < 6000;
        const btn3d = document.getElementById('btn-tab-3d');
        const tab3d = document.getElementById('tab-3d');

        if (isStreaming && !wasStreaming) {
            wasStreaming = true;
            if (btn3d) btn3d.style.display = 'flex'; // Tab-Button einblenden
            switchTab('3d'); // Automatisch zum startenden 3D-Stream wechseln
        }
        else if (!isStreaming && wasStreaming) {
            wasStreaming = false;
            if (btn3d) btn3d.style.display = 'none'; // Tab-Button ausblenden

            // Wenn der User gerade im 3D-Tab war und der Stream abbricht, wegschalten
            if (tab3d && !tab3d.classList.contains('hidden')) {
                switchTab('imulogs');
            }
        }
    }, 1000); // Prüft jede Sekunde
};