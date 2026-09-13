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
        if (btnEl) btnEl.className = "bg-gray-800 text-gray-400 px-3.5 py-2 rounded text-xs font-bold uppercase whitespace-nowrap hover:text-white transition flex items-center gap-1.5";
    });

    const activeTab = document.getElementById(`tab-${tab}`);
    const activeBtn = document.getElementById(`btn-tab-${tab}`);
    if (activeTab) activeTab.classList.remove('hidden');
    if (activeBtn) activeBtn.className = "bg-stag-green text-white px-3.5 py-2 rounded text-xs font-bold uppercase whitespace-nowrap transition flex items-center gap-1.5";

    if (tab !== 'files' && activeCommandPollTimer) {
        clearInterval(activeCommandPollTimer);
        activeCommandPollTimer = null;
    }

    if (tab === '3d' && window.resize3DViewport) {
        setTimeout(window.resize3DViewport, 80);
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
    fetchAllData();
    setInterval(() => {
        if (window.fetchLatestBatteryData) window.fetchLatestBatteryData();
    }, 30000);
};