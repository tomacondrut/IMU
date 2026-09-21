/*
 * Breadcrumb: 2026-09-13 10:10 - Resilient Cloud Engine with Legacy Topic Fallback
 * [CRITICAL BUGFIX FLAG - DUAL CHANNEL COMPATIBILITY]:
 * 1. Subscribes to 'imu_live' for STAG-IMU-01 (matches current ESP32 firmware) and 'imu_live_STAG-IMU-02' for box 2.
 * 2. Connects pos, log and phx_reply events directly to 3D engine and terminal drawer.
 * 3. Handles SD and GPS command dispatching with UI error badges.
 */

/*
 * Breadcrumb: 2026-09-13 23:55 - Direct Realtime WSS Command & Response Engine
 * [CRITICAL BUGFIX FLAG - IMMEDIATE COMMAND DISPATCH]:
 * 1. Broadcasts commands ('cmd') directly through the established WebSocket connection.
 * 2. Listens for 'cmd_res' to update UI in <50ms without waiting for REST table polling.
 * 3. Still inserts into sd_cloud_commands for persistent history.
 */
/*
 * Breadcrumb: 2026-09-14 23:58 - Flexible Device ID & Legacy Topic Normalization
 * [CRITICAL BUGFIX FLAG - MULTI-DEVICE TOPIC COMPATIBILITY]:
 * Normalizes 'STAG-IMU-1' and 'STAG-IMU-01' to the identical Phoenix channel 'imu_live'.
 */
function initRealtimeChannel() {
    if (liveChannel) {
        sbClient.removeChannel(liveChannel);
        liveChannel = null;
    }

    // Normalisierung: Beide Schreibweisen (mit/ohne führende 0) verbinden auf denselben Kanal
    const isImu1 = (selectedDeviceId === 'STAG-IMU-01' || selectedDeviceId === 'STAG-IMU-1');
    const topic = isImu1 ? 'imu_live' : `imu_live_${selectedDeviceId}`;

    liveChannel = sbClient.channel(topic, {
        config: { broadcast: { ack: false } }
    });

    liveChannel.on('broadcast', { event: 'pos' }, (event) => {
        const d = event.payload?.payload || event.payload;
        if (!d) return;

        let inW = d.w, inX = d.x, inY = d.y, inZ = d.z;
        if ((inW * lastQw + inX * lastQx + inY * lastQy + inZ * lastQz) < 0) {
            inW = -inW; inX = -inX; inY = -inY; inZ = -inZ;
        }

        qw = inW; qx = inX; qy = inY; qz = inZ;
        lastQw = qw; lastQx = qx; lastQy = qy; lastQz = qz;

        if (window.updateTargetOrientation) {
            window.updateTargetOrientation(qw, qx, qy, qz);
        }

        // NEU: Zeitstempel des letzten Live-Pakets für den Watchdog erfassen
        window.lastLiveTelemetryTime = Date.now();

        if (d.ax !== undefined) {
            curAx = d.ax; curAy = d.ay; curAz = d.az;
            window.curAx = curAx;
            window.curAy = curAy;
            window.curAz = curAz;

            accHistory.push({ x: curAx, y: curAy, z: curAz });
            if (accHistory.length > maxAccPoints) accHistory.shift();

            graphNeedsRedraw = true;
            window.graphNeedsRedraw = true;
        }

        const el = document.getElementById('overlay-status');
        if (el) {
            el.innerHTML = `[${selectedDeviceId}] ROT: W:${qw.toFixed(2)} X:${qx.toFixed(2)} Y:${qy.toFixed(2)} Z:${qz.toFixed(2)}<br>ACC: X:${curAx.toFixed(2)} Y:${curAy.toFixed(2)} Z:${curAz.toFixed(2)} m/s²`;
        }
    });

    liveChannel.on('broadcast', { event: 'log' }, (event) => {
        const d = event.payload?.payload || event.payload;
        if (d && d.msg) {
            appendTerminalLog(d.msg);
        }
    });

    liveChannel.on('broadcast', { event: 'cmd_res' }, (event) => {
        const row = (event.payload && event.payload.id !== undefined) ? event.payload : event;
        if (!row) return;
        if (activeCommandId && row.id === activeCommandId) {
            appendTerminalLog(`[CLOUD CMD] Sofort-Antwort via WSS erhalten (#${row.id}: ${row.status})`);
            handleCommandResult(row);

            sbClient.from('sd_cloud_commands').update({
                status: row.status,
                payload: row.payload,
                executed_at: new Date().toISOString()
            }).eq('id', row.id).then(() => { });
        }
    });

    liveChannel.subscribe((status) => {
        const ind = document.getElementById('realtime-indicator');
        const txt = document.getElementById('realtime-indicator-text');
        if (!ind) return;
        if (status === 'SUBSCRIBED') {
            // Nur STANDBY signalisieren – LIVE wird erst durch echte Datenpakete getriggert
            ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> <span id="realtime-indicator-text">${selectedDeviceId} STANDBY</span>`;
            ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-300';
        } else {
            ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> <span id="realtime-indicator-text">${status}</span>`;
            ind.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-300';
        }
    });
}

function initCloudCommandChannel() {
    if (cloudCmdChannel) return;

    cloudCmdChannel = sbClient.channel(`sd_commands_${selectedDeviceId}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'sd_cloud_commands',
            filter: `device_id=eq.${selectedDeviceId}`
        }, (payload) => {
            const row = payload.new;
            if (!row || row.device_id !== selectedDeviceId) return;
            if (activeCommandId && row.id === activeCommandId) {
                handleCommandResult(row);
            }
        })
        .subscribe();
}

function handleCommandResult(row) {
    const stat = document.getElementById('sd-cloud-status-badge');

    let payload = row.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { console.error('Payload Parse Error:', e); }
    }

    if (row.command === 'LIST') {
        if (row.status === 'DONE') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            renderCloudFileList(payload?.items || []);
            if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ Ordner geladen</span>';
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            document.getElementById('sd-file-list').innerHTML =
                `<div class="text-xs text-red-600 py-3 text-center">Fehler: ${row.error_msg || 'Ordner konnte nicht gelesen werden.'}</div>`;
            if (stat) stat.innerHTML = '<span class="text-red-600 font-bold">Fehler</span>';
        }
        /*
     * Breadcrumb: 2026-09-14 01:10 - Instant Data-URL & CDN Download Engine
     * [CRITICAL BUGFIX FLAG - ZERO TLS COLLISION DOWNLOAD]:
     * 1. Supports Data URLs (data:...) for small files (config.json, wifi.json) in <20ms without Supabase Storage.
     * 2. Uses payload.file_name to guarantee exact filenames on disk.
     */
    } else if (row.command === 'DOWNLOAD') {
        if (row.status === 'DONE' && payload?.download_url) {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ Download bereit!</span>';

            const a = document.createElement('a');
            a.href = payload.download_url;

            // Exakten Dateinamen zuweisen (unterstützt Data-URLs und CDN-Pfade)
            const targetFilename = payload.file_name || (payload.download_url.startsWith('data:') ? 'download' : payload.download_url.split('/').pop());
            a.download = targetFilename;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            appendTerminalLog(`[DOWNLOAD] Datei erfolgreich heruntergeladen: ${targetFilename}`);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-600 font-bold">Fehler</span>';
            alert('Download-Fehler vom Board:\n' + (row.error_msg || 'Unbekannter Fehler'));
        }
    } else if (row.command === 'DELETE') {
        if (row.status === 'DONE') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ Gelöscht</span>';
            setTimeout(() => { loadCloudSdDirectory(currentCloudSdDir); }, 600);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-600 font-bold">Fehler</span>';
            alert('Löschfehler vom Board:\n' + (row.error_msg || 'Unbekannter Fehler'));
        }
    } else if (row.command === 'GPS') {
        if (row.status === 'DONE' && payload) {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ GPS-Fix erfasst!</span>';
            appendTerminalLog(`[GPS FIX] Lat: ${payload.lat} | Lon: ${payload.lon} | Sats: ${payload.sats}`);
            if (window.updateGpsUI) window.updateGpsUI(payload);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-600 font-bold">GPS-Fehler</span>';
            appendTerminalLog(`[GPS FEHLER] ${row.error_msg || 'Kein Satellitenempfang.'}`);
            if (window.updateGpsUI) window.updateGpsUI({ has_fix: false });
        }
    } else if (row.command === 'LTE_TEST') { // <-- HIER: Sauberes 'else if' OHNE vorherige schließende Klammer
        if (row.status === 'DONE') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ LTE-Test gestartet!</span>';
            appendTerminalLog(`[LTE TEST] Befehl von ${selectedDeviceId} empfangen. Modem-Diagnose läuft...`);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-600 font-bold">LTE-Fehler</span>';
            appendTerminalLog(`[LTE TEST FEHLER] Start fehlgeschlagen: ${row.error_msg || 'Unbekannter Fehler'}`);
        }
    }
}

async function sendCloudCommand(command, path, statusPrompt) {
    const stat = document.getElementById('sd-cloud-status-badge');
    if (stat) stat.innerHTML = `<span class="text-amber-600 font-mono animate-pulse">${statusPrompt}</span>`;

    if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
    initCloudCommandChannel();

    appendTerminalLog(`\n[CLOUD CMD] Sende Befehl '${command}' an ${selectedDeviceId} (Pfad: "${path}")...`);

    const { data, error } = await sbClient.from('sd_cloud_commands').insert([{
        device_id: selectedDeviceId,
        command: command,
        path: path,
        status: 'PENDING'
    }]).select().single();

    if (error) {
        console.error('[SD CLOUD] FEHLER beim INSERT:', error);
        appendTerminalLog(`[CLOUD CMD FEHLER] INSERT gescheitert: ${error.message}`);
        if (stat) stat.innerHTML = `<span class="text-red-600 font-bold">Fehler: ${error.message}</span>`;
        alert(`Befehlsfehler (${command}): ${error.message}\n\nPrüfe RLS-Policies auf 'sd_cloud_commands'!`);
        return;
    }

    activeCommandId = data.id;
    appendTerminalLog(`[CLOUD CMD] Befehl #${data.id} aktiv. Sende Echtzeit-Trigger...`);

    // Sofortiger Direkt-Versand über den offenen WebSocket
    if (liveChannel) {
        liveChannel.send({
            type: 'broadcast',
            event: 'cmd',
            payload: {
                id: data.id,
                command: command,
                path: path
            }
        });
    }

    const startTime = Date.now();
    activeCommandPollTimer = setInterval(async () => {
        if (!activeCommandId) {
            clearInterval(activeCommandPollTimer);
            return;
        }

        const { data: checkData, error: pollErr } = await sbClient
            .from('sd_cloud_commands')
            .select('*')
            .eq('id', activeCommandId)
            .single();

        if (checkData && (checkData.status === 'DONE' || checkData.status === 'ERROR')) {
            handleCommandResult(checkData);
        }

        const maxWaitMs = (command === 'DOWNLOAD') ? 60000 : 25000;
        if (Date.now() - startTime > maxWaitMs) {
            clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            appendTerminalLog(`[CLOUD CMD TIMEOUT] Keine Rückmeldung auf '${command}' nach ${maxWaitMs / 1000}s.`);
            if (stat) stat.innerHTML = '<span class="text-amber-600 font-bold">Timeout</span>';
        }
    }, 1500);
}

/*
 * Breadcrumb: 2026-09-15 00:05 - Storage Fallback Directory Loader
 * [CRITICAL BUGFIX FLAG - OFFLINE BOARD STORAGE RENDERING]:
 * If board does not respond or is in deep sleep, directly lists synced files
 * from Supabase Storage bucket 'imu-logs' for the active device.
 */
/*
 * Breadcrumb: 2026-09-15 00:05 - Storage Fallback Directory Loader
 * [CRITICAL BUGFIX FLAG - OFFLINE BOARD STORAGE RENDERING]:
 * If board does not respond or is in deep sleep, directly lists synced files
 * from Supabase Storage bucket 'imu-logs' for the active device.
 */
async function loadCloudSdDirectory(dir) {
    let cleanDir = dir || '/';
    while (cleanDir.includes('//')) cleanDir = cleanDir.replace('//', '/');
    if (!cleanDir.startsWith('/')) cleanDir = '/' + cleanDir;
    if (cleanDir.length > 1 && cleanDir.endsWith('/')) cleanDir = cleanDir.substring(0, cleanDir.length - 1);

    currentCloudSdDir = cleanDir;
    const pathEl = document.getElementById('sd-current-path');
    if (pathEl) pathEl.innerText = currentCloudSdDir;

    document.getElementById('sd-file-list').innerHTML = `
      <div class="text-xs text-green-700 py-4 text-center space-y-2">
        <div class="animate-pulse">⏳ Frage ${selectedDeviceId} an...</div>
        <p class="text-[11px] text-slate-500">Falls Board offline ist, wird Supabase Storage geladen...</p>
      </div>
    `;

    // 1. Primär: Direkte Abfrage an das Board senden
    await sendCloudCommand('LIST', currentCloudSdDir, 'Lade Ordner...');

    // 2. Fallback-Timer: Antwortet das Board nach 3 Sekunden nicht (Deep Sleep), lade Storage-Bucket
    setTimeout(async () => {
        if (activeCommandId) {
            appendTerminalLog(`[CLOUD SD] Board ${selectedDeviceId} antwortet nicht (Schlafmodus). Lade Cloud-Storage...`);
            clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            await loadFromSupabaseStorageDirect();
        }
    }, 3500);
}

async function loadFromSupabaseStorageDirect() {
    const stat = document.getElementById('sd-cloud-status-badge');
    if (stat) stat.innerHTML = '<span class="text-emerald-700 font-bold">☁ Supabase Cloud</span>';

    // Geräte-ID für Storage-Pfad angleichen (STAG-IMU-01 und STAG-IMU-1 prüfen)
    const candidates = [selectedDeviceId, selectedDeviceId.replace('-01', '-1'), selectedDeviceId.replace('-1', '-01')];
    let storageItems = [];
    let usedId = selectedDeviceId;

    for (const devId of candidates) {
        const { data, error } = await sbClient.storage.from('imu-logs').list(devId, {
            limit: 100,
            sortBy: { column: 'name', order: 'desc' }
        });
        if (data && data.length > 0) {
            storageItems = data;
            usedId = devId;
            break;
        }
    }

    if (!storageItems || storageItems.length === 0) {
        document.getElementById('sd-file-list').innerHTML =
            `<div class="text-xs text-slate-500 py-4 text-center">Keine synchronisierten Dateien in Supabase Storage für ${selectedDeviceId} gefunden.</div>`;
        return;
    }

    // Darstellung der Dateien mit direktem Cloud-Download-Link
    const listEl = document.getElementById('sd-file-list');
    listEl.innerHTML = storageItems.map(folderOrFile => {
        // Handelt es sich um Tagesordner oder direkte Dateien
        const isFolder = !folderOrFile.id && !folderOrFile.metadata;
        if (isFolder) {
            return `
              <div class="flex justify-between items-center p-2.5 rounded bg-emerald-50 border border-emerald-200 cursor-pointer hover:bg-emerald-100 transition shadow-sm"
                   onclick="loadCloudStorageFolder('${usedId}', '${folderOrFile.name}')">
                <span class="text-xs font-bold text-emerald-800">📁 ${folderOrFile.name} (Cloud)</span>
                <span class="text-xs text-emerald-600 font-semibold">Öffnen ➔</span>
              </div>
            `;
        }

        const sizeKb = folderOrFile.metadata?.size ? (folderOrFile.metadata.size / 1024).toFixed(1) : '--';
        const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${usedId}/${folderOrFile.name}`;

        return `
          <div class="flex justify-between items-center p-2.5 rounded bg-white border border-slate-200 text-xs font-mono hover:border-slate-400 transition shadow-sm">
            <span class="text-slate-800 truncate mr-2">📄 ${folderOrFile.name} <span class="text-slate-500 text-[10px]">(${sizeKb} KB)</span></span>
            <a href="${fileUrl}" download target="_blank"
               class="bg-slate-100 hover:bg-slate-200 text-green-700 border border-slate-300 px-2.5 py-1 rounded text-xs font-bold transition">
              ⬇ Download
            </a>
          </div>
        `;
    }).join('');
}

async function loadCloudStorageFolder(devId, folderName) {
    const pathEl = document.getElementById('sd-current-path');
    if (pathEl) pathEl.innerText = `/Logs/${folderName}`;

    const { data, error } = await sbClient.storage.from('imu-logs').list(`${devId}/${folderName}`, {
        limit: 100,
        sortBy: { column: 'name', order: 'desc' }
    });

    const listEl = document.getElementById('sd-file-list');
    if (!data || data.length === 0) {
        listEl.innerHTML = '<div class="text-xs text-slate-500 py-4 text-center">Ordner ist leer.</div>';
        return;
    }

    listEl.innerHTML = `
      <div class="mb-2">
        <button onclick="loadFromSupabaseStorageDirect()" class="text-xs text-green-700 font-bold hover:underline">⬆ Zurück zur Cloud-Übersicht</button>
      </div>
    ` + data.map(item => {
        const sizeKb = item.metadata?.size ? (item.metadata.size / 1024).toFixed(1) : '--';
        const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${devId}/${folderName}/${item.name}`;

        return `
          <div class="flex justify-between items-center p-2.5 rounded bg-white border border-slate-200 text-xs font-mono hover:border-slate-400 transition shadow-sm">
            <span class="text-slate-800 truncate mr-2">📄 ${item.name} <span class="text-slate-500 text-[10px]">(${sizeKb} KB)</span></span>
            <a href="${fileUrl}" download target="_blank"
               class="bg-slate-100 hover:bg-slate-200 text-green-700 border border-slate-300 px-2.5 py-1 rounded text-xs font-bold transition">
              ⬇ Download
            </a>
          </div>
        `;
    }).join('');
}

function renderCloudFileList(items) {
    const listEl = document.getElementById('sd-file-list');
    if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="text-xs text-slate-500 py-4 text-center">Dieser Ordner ist leer.</div>';
        return;
    }

    listEl.innerHTML = items.map(item => {
        const fullPath = (currentCloudSdDir === '/' ? '' : currentCloudSdDir) + '/' + item.name;
        if (item.is_dir) {
            return `
              <div class="flex justify-between items-center p-2.5 rounded bg-emerald-50 border border-emerald-200 cursor-pointer hover:bg-emerald-100 transition shadow-sm"
                   onclick="loadCloudSdDirectory('${fullPath}')">
                <span class="text-xs font-bold text-emerald-800">📁 ${item.name}</span>
                <span class="text-xs text-emerald-600 font-semibold">Öffnen ➔</span>
              </div>
            `;
        } else {
            const kb = (item.size / 1024).toFixed(1);
            return `
              <div class="flex justify-between items-center p-2.5 rounded bg-white border border-slate-200 text-xs font-mono hover:border-slate-400 transition shadow-sm">
                <span class="text-slate-800 truncate mr-2">📄 ${item.name} <span class="text-slate-500 text-[10px]">(${kb} KB)</span></span>
                <div class="flex items-center gap-2 shrink-0">
                  <button onclick="requestCloudDownload('${fullPath}', '${item.name}')" 
                          class="bg-slate-100 hover:bg-slate-200 text-green-700 border border-slate-300 px-2.5 py-1 rounded text-xs font-bold transition">
                    ⬇ Download
                  </button>
                  <button onclick="requestCloudDelete('${fullPath}', '${item.name}')" 
                          class="text-red-600 hover:text-red-800 hover:bg-red-50 p-1 rounded transition text-xs" title="Löschen">
                    ✕
                  </button>
                </div>
              </div>
            `;
        }
    }).join('');
}

function navigateCloudSdUp() {
    if (currentCloudSdDir === '/' || currentCloudSdDir === '') return;
    const lastSlash = currentCloudSdDir.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : currentCloudSdDir.substring(0, lastSlash);
    loadCloudSdDirectory(parent);
}

/*
 * Breadcrumb: 2026-09-14 00:50 - Instant CDN Download for Synced Chunks & 60s Timeout
 * [CRITICAL BUGFIX FLAG - ZERO LATENCY DOWNLOAD]:
 * 1. .synced files are ALREADY in Supabase Storage: downloads instantly from CDN URL without ESP32 radio load.
 * 2. Unsynced files (configs, active logs) are uploaded by ESP32 with an extended 60s timeout.
 */
async function requestCloudDownload(path, fileName) {
    const stat = document.getElementById('sd-cloud-status-badge');

    // FAST-PATH: Datei wurde bereits in die Cloud synchronisiert
    if (fileName.endsWith('.synced')) {
        const cleanName = fileName.replace('.synced', '');
        const parts = path.split('/');
        // Ordner ermitteln (z.B. '2026-09-12' aus '/Logs/2026-09-12/...')
        const dayFolder = parts[parts.length - 2] || '';
        const directUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${selectedDeviceId}/${dayFolder}/${cleanName}`;

        appendTerminalLog(`\n[DOWNLOAD] Direkter CDN-Download aus Supabase Storage: ${cleanName}`);
        if (stat) stat.innerHTML = '<span class="text-green-700 font-bold">✓ Download gestartet!</span>';

        const a = document.createElement('a');
        a.href = directUrl;
        a.download = cleanName;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
    }

    // SLOW-PATH: Unsynchronisierte Datei (z.B. config.json) vom Board anfordern
    await sendCloudCommand('DOWNLOAD', path, `Bereite "${fileName}" vor...`);
}

async function requestCloudDelete(path, fileName) {
    if (!confirm(`Datei "${fileName}" wirklich von der physischen SD-Karte löschen?\n\nGerät: ${selectedDeviceId}\nPfad: ${path}`)) return;
    await sendCloudCommand('DELETE', path, `Lösche "${fileName}"...`);
}

async function fetchConfig() {
    const { data, error } = await sbClient.from('device_config').select('*').eq('device_id', selectedDeviceId).single();
    if (error || !data) return;

    document.getElementById('cfg-idle').value = data.idle_timeout_sec || 10;
    document.getElementById('cfg-idle-val').innerText = (data.idle_timeout_sec || 10) + ' s';
    /*
     * Breadcrumb: 2026-09-21 19:52 - Aligned Config Fetcher Fallback Floor (0.05 m/s²)
     * [CRITICAL BUGFIX FLAG - SENSITIVITY DEFAULT PARITY]:
     * Replaced 0.20 fallback with 0.05 so default or uncalibrated records render at 0.05 m/s².
     */
    const sensVal = (data.sens !== undefined && data.sens !== null) ? data.sens : 0.05;
    document.getElementById('cfg-sens').value = sensVal;
    document.getElementById('cfg-sens-val').innerText = Number(sensVal).toFixed(2) + ' m/s²';
    document.getElementById('cfg-delta').value = data.delta || 0.10;
    document.getElementById('cfg-delta-val').innerText = Number(data.delta || 0.10).toFixed(2);
    document.getElementById('cfg-rate').value = data.rate || 10;
    document.getElementById('cfg-rate-val').innerText = (data.rate || 10) + ' Hz';
    document.getElementById('cfg-lte').value = data.lte_interval || 5;
    document.getElementById('cfg-lte-val').innerText = (data.lte_interval || 5) + ' min';

    if (data.sim_pin) document.getElementById('cfg-sim-pin').value = data.sim_pin;
    if (data.sim_apn) document.getElementById('cfg-sim-apn').value = data.sim_apn;

    liveModeActive = data.continuous_mode || false;
    updateStreamUI(liveModeActive);
    updateLockUI(); // <-- DIESE ZEILE AM ENDE VON fetchConfig() ERGÄNZEN
}

async function saveConfigToCloud() {
    if (!isSessionUnlocked()) {
        openSessionAuthModal();
        return;
    }

    const btn = document.getElementById('btn-save-cfg');
    const status = document.getElementById('cfg-status-msg');
    btn.disabled = true;
    btn.classList.add('opacity-50');
    status.innerText = `Speichere Parameter für ${selectedDeviceId}...`;

    const basePayload = {
        device_id: selectedDeviceId,
        idle_timeout_sec: parseInt(document.getElementById('cfg-idle').value, 10),
        sens: parseFloat(document.getElementById('cfg-sens').value),
        delta: parseFloat(document.getElementById('cfg-delta').value),
        rate: parseInt(document.getElementById('cfg-rate').value, 10),
        lte_interval: parseInt(document.getElementById('cfg-lte').value, 10),
        continuous_mode: liveModeActive,
        updated_at: new Date().toISOString()
    };

    let payload = {
        ...basePayload,
        sim_pin: document.getElementById('cfg-sim-pin').value.trim(),
        sim_apn: document.getElementById('cfg-sim-apn').value.trim()
    };

    let { error } = await sbClient.from('device_config').upsert(payload);
    if (error && error.message.includes('column')) {
        const retry = await sbClient.from('device_config').upsert(basePayload);
        error = retry.error;
    }

    btn.disabled = false;
    btn.classList.remove('opacity-50');

    if (error) {
        status.innerText = 'Fehler beim Speichern: ' + error.message;
        status.className = 'text-xs text-center mt-2 text-red-600 font-mono font-bold';
    } else {
        status.innerText = `✓ Gespeichert! ${selectedDeviceId} synchronisiert beim nächsten Sync.`;
        status.className = 'text-xs text-center mt-2 text-green-700 font-mono font-bold';
    }
}

// ============================================================================
// LTE LIVE-STREAM STEUERUNG & CLOUD-PARAMETER
// ============================================================================

async function toggleLteLiveStreaming() {
    if (!isSessionUnlocked()) {
        openSessionAuthModal();
        return;
    }

    const newState = !liveModeActive;
    updateStreamUI(newState, true);

    try {
        const { error } = await sbClient
            .from('device_config')
            .update({
                continuous_mode: newState,
                updated_at: new Date().toISOString()
            })
            .eq('device_id', selectedDeviceId);

        if (error) throw error;

        liveModeActive = newState;
        updateStreamUI(newState, false);
        appendTerminalLog(`\n[CLOUD] LTE Live-Stream für ${selectedDeviceId} auf ${newState ? 'AKTIV' : 'AUS'} gesetzt.`);
    } catch (err) {
        console.error("Fehler beim Schalten des Live-Modus:", err);
        alert("Cloud-Fehler: Konnte Streaming-Status nicht aktualisieren.");
        updateStreamUI(liveModeActive, false);
    }
}

function updateStreamUI(isActive, isPending = false) {
    const hdrBtn = document.getElementById('header-lte-stream-btn');
    const hdrTxt = document.getElementById('header-stream-txt');
    const hdrDot = document.getElementById('header-stream-dot');
    const tabBtn = document.getElementById('btn-toggle-live'); // Button im Parameter-Tab

    if (isPending) {
        if (hdrTxt) hdrTxt.innerText = "Schalte...";
        return;
    }

    if (isActive) {
        if (hdrBtn) hdrBtn.className = "flex items-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 px-2.5 py-1.5 rounded-lg cursor-pointer transition select-none shadow-sm group";
        if (hdrDot) hdrDot.className = "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
        if (hdrTxt) { hdrTxt.innerText = "Stream: AN"; hdrTxt.className = "text-xs font-mono font-bold text-emerald-800"; }
        if (tabBtn) { tabBtn.innerText = "AKTIV"; tabBtn.className = "px-3 py-1.5 rounded text-xs font-bold bg-stag-green text-white shadow-sm transition"; }
    } else {
        if (hdrBtn) hdrBtn.className = "flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-300 px-2.5 py-1.5 rounded-lg cursor-pointer transition select-none shadow-sm group";
        if (hdrDot) hdrDot.className = "w-2 h-2 rounded-full bg-slate-400";
        if (hdrTxt) { hdrTxt.innerText = "Stream: AUS"; hdrTxt.className = "text-xs font-mono font-bold text-slate-700"; }
        if (tabBtn) { tabBtn.innerText = "AUS"; tabBtn.className = "px-3 py-1.5 rounded text-xs font-bold bg-white text-slate-700 border border-slate-300 transition"; }
    }
}

// Alias, damit der alte Button im Parameter-Tab weiterhin funktioniert
window.toggleLiveModeUI = toggleLteLiveStreaming;
window.toggleLteLiveStreaming = toggleLteLiveStreaming;

// ============================================================================
// REALTIME LISTENER: LTE TELEMETRIE & AKKU
// ============================================================================
let batteryLogsSubscription = null;

function subscribeToBatteryLogs() {
    if (batteryLogsSubscription) {
        sbClient.removeChannel(batteryLogsSubscription);
    }

    batteryLogsSubscription = sbClient
        .channel(`battery_logs_${selectedDeviceId}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'battery_logs',
            filter: `device_id=eq.${selectedDeviceId}`
        }, payload => {
            const row = payload.new;

            // 1. Akku-UI und Graphen sofort aktualisieren
            if (window.fetchLatestBatteryData) {
                window.fetchLatestBatteryData();
            }

            // 2. Erkennung aktiver LTE-Streams (alle 2 Sekunden)
            if (row.charging_status === "LTE Live Stream") {
                const overlay = document.getElementById('overlay-status');
                if (overlay) {
                    overlay.innerHTML = `[${selectedDeviceId}] LTE-Stream aktiv (${Number(row.battery_voltage).toFixed(2)} V)`;
                }
                appendTerminalLog(`[LTE STREAM IN] ${new Date(row.recorded_at).toLocaleTimeString()} | ${Number(row.battery_voltage).toFixed(2)}V | Akku: ${row.battery_percent}%`);

                // Der Watchdog aus main.js wird dadurch am Leben gehalten
                window.lastLiveTelemetryTime = Date.now();
            }
        })
        .subscribe();
}

window.subscribeToBatteryLogs = subscribeToBatteryLogs;

/*
* Breadcrumb: 2026-09-13 10:15 - Cloud-Triggered LTE Diagnostic Test Dispatcher
*/
async function triggerLteDiagnosticTest() {
    if (!isSessionUnlocked()) {
        openSessionAuthModal();
        return;
    }

    if (window.ensureTerminalOpen) {
        window.ensureTerminalOpen();
    }
    appendTerminalLog(`\n[LTE TEST] Fordere Mobilfunk-Diagnose für ${selectedDeviceId} an...`);
    await sendCloudCommand('LTE_TEST', '/', `Starte LTE-Test auf ${selectedDeviceId}...`);
}

window.triggerLteDiagnosticTest = triggerLteDiagnosticTest;

// ============================================================================
// KALENDER & 24H-ZEITLEISTE FÜR CLOUD IMU LOGS
// ============================================================================
let currentDeviceFiles = [];
let calendarDate = new Date();
let calendarViewMode = 'month'; // 'month' oder 'week'
let calendarInitialized = false;

// Vereinheitlichte Datumsextraktion (bevorzugt day_folder, sonst Zeitstempel)
function getFileDayKey(f) {
    if (f.day_folder && /^\d{4}-\d{2}-\d{2}$/.test(f.day_folder)) {
        return f.day_folder;
    }
    const d = new Date(f.uploaded_at);
    if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return '';
}

async function fetchImuCloudLogs() {
    const container = document.getElementById('imu-logs-container');
    if (!container) return;

    container.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">Lade IMU-Archive für ${selectedDeviceId}...</div>`;

    const { data: allFiles, error } = await sbClient
        .from('imu_log_files')
        .select('*')
        .order('uploaded_at', { ascending: false });

    if (error) {
        container.innerHTML = `<div class="p-3 bg-red-50 border border-red-300 rounded text-xs text-red-700">Fehler beim Laden: ${error.message}</div>`;
        return;
    }

    // Storage-Auslastung aktualisieren
    const FREE_TIER_LIMIT_MB = 1024;
    const totalBytesAll = (allFiles || []).reduce((sum, f) => sum + Number(f.file_size_bytes || 0), 0);
    const totalMbAll = (totalBytesAll / (1024 * 1024)).toFixed(1);
    const pctAll = Math.min(Math.max(((totalMbAll / FREE_TIER_LIMIT_MB) * 100), 0), 100).toFixed(1);

    currentDeviceFiles = (allFiles || []).filter(f => f.device_id === selectedDeviceId);
    const deviceBytes = currentDeviceFiles.reduce((sum, f) => sum + Number(f.file_size_bytes || 0), 0);
    const deviceMb = (deviceBytes / (1024 * 1024)).toFixed(1);
    const freeMb = Math.max(0, (FREE_TIER_LIMIT_MB - totalMbAll)).toFixed(1);

    const sumEl = document.getElementById('storage-used-summary');
    const barEl = document.getElementById('storage-progress-bar');
    const shareEl = document.getElementById('storage-device-share');
    const freeEl = document.getElementById('storage-free-capacity');

    if (sumEl) sumEl.innerText = `${totalMbAll} MB von ${FREE_TIER_LIMIT_MB} MB (${pctAll}%)`;
    if (shareEl) shareEl.innerText = `${selectedDeviceId}: ${deviceMb} MB (${currentDeviceFiles.length} Chunks)`;
    if (freeEl) freeEl.innerText = `Verbleibend: ${freeMb} MB frei`;

    if (barEl) {
        barEl.style.width = `${pctAll}%`;
        barEl.className = pctAll >= 90 ? 'h-full bg-red-500 transition-all' : (pctAll >= 75 ? 'h-full bg-amber-500 transition-all' : 'h-full bg-green-600 transition-all');
    }

    // Springt beim Erstaufruf automatisch in den Monat der neuesten Messung
    if (!calendarInitialized && currentDeviceFiles.length > 0) {
        const newestDate = new Date(currentDeviceFiles[0].uploaded_at);
        if (!isNaN(newestDate.getTime())) {
            calendarDate = new Date(newestDate.getFullYear(), newestDate.getMonth(), newestDate.getDate());
            calendarInitialized = true;
        }
    }

    renderCalendarUI();
}

function changeCalendarMonth(offset) {
    if (calendarViewMode === 'month') {
        calendarDate.setMonth(calendarDate.getMonth() + offset);
    } else {
        calendarDate.setDate(calendarDate.getDate() + (offset * 7));
    }
    renderCalendarUI();
}

function setCalendarViewMode(mode) {
    calendarViewMode = mode;
    renderCalendarUI();
}

function renderCalendarUI() {
    const container = document.getElementById('imu-logs-container');
    if (!container) return;

    // Dateien nach Tagen bündeln
    const filesByDate = {};
    currentDeviceFiles.forEach(f => {
        const dayKey = getFileDayKey(f);
        if (dayKey) {
            if (!filesByDate[dayKey]) filesByDate[dayKey] = [];
            filesByDate[dayKey].push(f);
        }
    });

    const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
    const currentMonthLabel = `${monthNames[calendarDate.getMonth()]} ${calendarDate.getFullYear()}`;

    let html = `
        <!-- Zeitleiste wird HIER über dem Kalender eingeblendet -->
        <div id="daily-timeline-wrapper" class="hidden mb-6"></div>

        <div id="calendar-wrapper">
            <!-- Kalender Header mit Monats-/Wochen-Umschalter -->
            <div class="flex flex-wrap justify-between items-center mb-4 gap-2">
                <div class="flex items-center gap-1 sm:gap-2">
                    <button onclick="changeCalendarMonth(-1)" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded text-slate-700 font-bold transition">◀</button>
                    <h3 class="text-sm font-bold text-slate-800 w-36 text-center select-none font-mono">${currentMonthLabel}</h3>
                    <button onclick="changeCalendarMonth(1)" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded text-slate-700 font-bold transition">▶</button>
                </div>
                <div class="flex items-center gap-1 bg-slate-100 border border-slate-300 p-1 rounded-lg">
                    <button onclick="setCalendarViewMode('month')" class="px-3 py-1 text-[11px] font-bold rounded transition ${calendarViewMode === 'month' ? 'bg-white shadow-sm text-stag-green' : 'text-slate-500 hover:text-slate-700'}">Monat</button>
                    <button onclick="setCalendarViewMode('week')" class="px-3 py-1 text-[11px] font-bold rounded transition ${calendarViewMode === 'week' ? 'bg-white shadow-sm text-stag-green' : 'text-slate-500 hover:text-slate-700'}">Woche</button>
                </div>
            </div>

            <!-- Kalender Raster -->
            <div class="grid grid-cols-7 gap-1.5 sm:gap-2 mb-2">
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Mo</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Di</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Mi</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Do</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Fr</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">Sa</div>
                <div class="text-[10px] font-bold text-slate-400 text-center uppercase pb-1">So</div>
    `;

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    let startDate = new Date(year, month, 1);
    let endDate = new Date(year, month + 1, 0);

    if (calendarViewMode === 'week') {
        const dayOfWeek = calendarDate.getDay() === 0 ? 6 : calendarDate.getDay() - 1;
        startDate = new Date(calendarDate);
        startDate.setDate(calendarDate.getDate() - dayOfWeek);
        endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
    }

    const firstDayIndex = startDate.getDay() === 0 ? 6 : startDate.getDay() - 1;
    const lastDate = endDate.getDate();

    if (calendarViewMode === 'month') {
        for (let i = 0; i < firstDayIndex; i++) {
            html += `<div class="p-2 rounded-lg bg-slate-50/40 border border-slate-100"></div>`;
        }
    }

    const daysToRender = calendarViewMode === 'month' ? lastDate : 7;
    let currentRenderDate = new Date(startDate);

    for (let i = 1; i <= daysToRender; i++) {
        const dayKey = `${currentRenderDate.getFullYear()}-${String(currentRenderDate.getMonth() + 1).padStart(2, '0')}-${String(currentRenderDate.getDate()).padStart(2, '0')}`;
        const dayFiles = filesByDate[dayKey] || [];

        const todayStr = new Date().toISOString().split('T')[0];
        const isToday = (dayKey === todayStr);

        let cellClass = "p-1.5 sm:p-2 rounded-lg border flex flex-col h-16 sm:h-20 transition ";
        let contentHtml = `<span class="text-xs font-bold ${isToday ? 'text-blue-600' : 'text-slate-600'}">${currentRenderDate.getDate()}</span>`;

        if (dayFiles.length > 0) {
            // Ungefähre Dauer: 100 KB Chunk = ca. 1 Minute Aufzeichnung
            const totalBytes = dayFiles.reduce((sum, f) => sum + Number(f.file_size_bytes || 0), 0);
            const estMinutes = Math.max(1, Math.round(totalBytes / 102400));

            cellClass += "bg-emerald-50 border-emerald-400 hover:bg-emerald-100 cursor-pointer shadow-sm";
            contentHtml += `
                <div class="mt-auto">
                    <div class="text-[9px] sm:text-[10px] font-bold text-emerald-800 bg-emerald-200/60 rounded px-1 mb-0.5 w-fit">${dayFiles.length} Weck-Events</div>
                    <div class="text-[9px] sm:text-[10px] font-mono text-emerald-700 w-fit">~ ${estMinutes} Min</div>
                </div>
            `;
            html += `<div class="${cellClass}" onclick="openDailyTimeline('${dayKey}')" title="Klicken für 24h-Zeitleiste">${contentHtml}</div>`;
        } else {
            cellClass += "bg-slate-50 border-slate-200";
            html += `<div class="${cellClass}">${contentHtml}</div>`;
        }

        currentRenderDate.setDate(currentRenderDate.getDate() + 1);
    }

    html += `</div></div>`;
    container.innerHTML = html;
}

/*
 * Breadcrumb: 2026-09-20 07:45 - Robust 24h Timeline & Scope-Safe Day Replay Dispatcher
 * [CRITICAL BUGFIX FLAG - RESTORED TIMELINE BAR & SCOPE SAFE DISPATCH]:
 * 1. Restored missing 24h timeline graphic container (relative w-full h-10 & absolute inset-0).
 * 2. Replaced fragile inline onclick filter logic with scope-safe openDayReplay(dateStr).
 * 3. Normalizes storage file paths (removes leading slashes).
 */


/*
 * Breadcrumb: 2026-09-20 09:05 - Auto-Launch Full Day Replay on Calendar Day Click
 * [CRITICAL BUGFIX FLAG - INSTANT DAY REPLAY ON CLICK]:
 * 1. Automatically calls openDayReplay(dateStr) when a day is opened.
 * 2. Unhides 24h timeline and immediately streams merged day chunks to oscilloscope.
 */
/*
 * Breadcrumb: 2026-09-20 09:15 - Auto-Launch Full Day Replay on Calendar Day Click
 * [CRITICAL BUGFIX FLAG - DEDUPLICATED DISPATCHER & INSTANT REPLAY]:
 * 1. Deduplicated openDayReplay function declaration.
 * 2. Unhides 24h timeline and immediately streams merged day chunks to oscilloscope on calendar click.
 */
function openDayReplay(dateStr) {
    const dayFiles = currentDeviceFiles
        .filter(f => getFileDayKey(f) === dateStr)
        .sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));

    if (!dayFiles || dayFiles.length === 0) {
        alert(`Keine Messdateien für den Tag ${dateStr} gefunden.`);
        return;
    }

    if (window.inspectImuDayMerged) {
        window.inspectImuDayMerged(dateStr, dayFiles);
    } else {
        console.error("inspectImuDayMerged ist nicht verfügbar.");
    }
}
window.openDayReplay = openDayReplay;

function openDailyTimeline(dateStr) {
    const timelineWrapper = document.getElementById('daily-timeline-wrapper');
    if (!timelineWrapper) return;
    timelineWrapper.classList.remove('hidden');

    const displayDate = new Date(dateStr + "T00:00:00").toLocaleDateString('de-CH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const dayFiles = currentDeviceFiles.filter(f => getFileDayKey(f) === dateStr)
        .sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));

    let html = `
        <div class="bg-white border-2 border-stag-green rounded-lg p-3 sm:p-4 shadow-md relative">
            <div class="flex flex-wrap justify-between items-center gap-2 mb-4 pb-2 border-b border-slate-200">
                <div>
                    <h4 class="text-sm font-bold text-stag-green">📅 24-Stunden Zeitleiste: ${displayDate}</h4>
                    <p class="text-[11px] text-slate-500 font-mono">${dayFiles.length} erfasste Mess-Chunks an diesem Tag</p>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    <button onclick="openDayReplay('${dateStr}')"
                            class="bg-stag-green hover:bg-emerald-600 text-white font-bold px-3 py-1.5 rounded text-xs shadow-sm transition flex items-center gap-1.5">
                        <span>🔄 Tag neu laden</span>
                    </button>
                    <button onclick="closeDailyTimeline()" class="text-slate-500 hover:text-slate-800 font-bold bg-slate-100 hover:bg-slate-200 rounded px-2.5 py-1.5 text-xs transition border border-slate-300">
                        ✕ Schließen
                    </button>
                </div>
            </div>
            
            <div class="relative w-full h-10 bg-slate-100 border border-slate-300 rounded-md mb-8">
                <div class="absolute top-full left-0 text-[10px] text-slate-500 mt-1 font-mono">00:00</div>
                <div class="absolute top-full left-1/4 text-[10px] text-slate-500 mt-1 -ml-3 font-mono">06:00</div>
                <div class="absolute top-full left-2/4 text-[10px] text-slate-500 mt-1 -ml-3 font-mono">12:00</div>
                <div class="absolute top-full left-3/4 text-[10px] text-slate-500 mt-1 -ml-3 font-mono">18:00</div>
                <div class="absolute top-full right-0 text-[10px] text-slate-500 mt-1 -mr-2 font-mono">24:00</div>
                <div class="absolute inset-0">
    `;

    dayFiles.forEach(f => {
        const d = new Date(f.uploaded_at);
        const minutesFromMidnight = d.getHours() * 60 + d.getMinutes();
        const leftPercent = (minutesFromMidnight / 1440) * 100;

        let widthPercent = ((f.file_size_bytes / 102400) * 1) / 1440 * 100;
        if (widthPercent < 0.8) widthPercent = 0.8;

        const cleanPath = f.file_path.startsWith('/') ? f.file_path.substring(1) : f.file_path;
        const downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
        const tipTime = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
        const kb = (f.file_size_bytes / 1024).toFixed(0);

        // Mindestbreite 12px für verlässliche Touch-Bedienung mit Daumen/Finger
        html += `
            <div onclick="inspectImuFile('${downloadUrl}', '${f.file_name}')"
                 class="absolute h-full bg-stag-green active:bg-emerald-600 hover:bg-emerald-500 cursor-pointer border-r border-white transition flex items-center justify-center rounded-[2px] shadow-sm touch-manipulation"
                 style="left: ${leftPercent}%; width: ${widthPercent}%; min-width: 12px;"
                 title="${tipTime} Uhr - ${kb} KB">
            </div>
        `;
    });

    html += `
                </div>
            </div>
            
            <p class="text-[11px] text-slate-500 mb-4 text-center">Gesamter Tag wurde automatisch im Oszilloskop geöffnet. Klick auf einen grünen Balken isoliert die jeweilige Einzeldatei.</p>

            <p class="text-[11px] font-bold uppercase text-slate-500 mb-2 border-b border-slate-200 pb-1 tracking-wider">Erfasste Aufzeichnungen (${dayFiles.length})</p>
            <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
    `;

    dayFiles.forEach(f => {
        const kb = (Number(f.file_size_bytes || 0) / 1024).toFixed(1);
        const uploadTime = new Date(f.uploaded_at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const cleanPath = f.file_path.startsWith('/') ? f.file_path.substring(1) : f.file_path;
        const downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;

        html += `
            <div class="flex justify-between items-center p-2 rounded bg-slate-50 hover:bg-white border border-slate-200 hover:border-emerald-300 text-xs font-mono transition shadow-sm">
                <div class="flex items-center gap-2 truncate mr-3">
                    <span class="text-slate-800 font-semibold truncate">📄 ${f.file_name}</span>
                    <span class="text-[10px] text-slate-500 shrink-0">(${kb} KB)</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <span class="text-[10px] text-slate-500 font-bold bg-slate-200 px-1.5 py-0.5 rounded hidden md:inline mr-1">${uploadTime}</span>
                    <button onclick="inspectImuFile('${downloadUrl}', '${f.file_name}')" class="bg-slate-200 hover:bg-stag-green hover:text-white text-slate-700 px-2.5 py-1 rounded text-[11px] font-bold transition" title="Nur diesen Chunk öffnen">
                        📊
                    </button>
                    <button onclick="deleteImuCloudFile('${f.file_path}', '${f.file_name}')" 
                            class="btn-delete-log text-red-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 px-2 py-1 rounded transition text-xs" 
                            style="display: ${isSessionUnlocked() ? 'inline-flex' : 'none'};"
                            title="Aus Cloud löschen">
                        🗑️
                    </button>
                </div>
            </div>
        `;
    });

    html += `</div></div>`;
    timelineWrapper.innerHTML = html;

    // Lädt den gesamten Tag automatisch beim Klick auf die Tageskachel
    openDayReplay(dateStr);
}

function closeDailyTimeline() {
    const timelineWrapper = document.getElementById('daily-timeline-wrapper');
    if (timelineWrapper) timelineWrapper.classList.add('hidden');
}

// ============================================================================
// SESSION-WEITES SCHLOSS & LÖSCHBERECHTIGUNG
// ============================================================================

function isSessionUnlocked() {
    return sessionStorage.getItem('stag_admin_unlocked') === 'true';
}

/*
 * Breadcrumb: 2026-09-20 09:50 - Comprehensive Settings & Action Lock Protection
 * [CRITICAL BUGFIX FLAG - PARAMETER SECURITY LOCK]:
 * 1. Extends isSessionUnlocked() authorization to all sliders, textfields, toggles & save operations in #tab-settings.
 * 2. updateLockUI() toggles disabled states, cursor styles, and opacity on all parameter controls.
 * 3. Renders interactive status banner in #tab-settings allowing one-click authentication.
 * 4. Hard-guards saveConfigToCloud, toggleLteLiveStreaming, and triggerLteDiagnosticTest against unauthenticated execution.
 */

function updateLockUI() {
    const btn = document.getElementById('header-lock-btn');
    const unlocked = isSessionUnlocked();
    if (btn) {
        if (unlocked) {
            btn.innerHTML = `<svg class="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"/></svg>`;
            btn.className = "flex items-center bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 p-2 rounded-lg cursor-pointer transition select-none shadow-sm";
            btn.title = "Lösch- & Parameterfunktionen aktiv (Klicken zum Sperren)";
        } else {
            btn.innerHTML = `<svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>`;
            btn.className = "flex items-center bg-slate-100 hover:bg-slate-200 border border-slate-300 p-2 rounded-lg cursor-pointer transition select-none shadow-sm";
            btn.title = "Lösch- & Parameterfunktionen gesperrt (Klicken zum Entsperren)";
        }
    }

    // 1. Lösch-Buttons in der Zeitleiste
    document.querySelectorAll('.btn-delete-log').forEach(el => {
        el.style.display = unlocked ? 'inline-flex' : 'none';
    });

    // 2. Alle Parameter-Bedienelemente sperren / freigeben
    const settingControlIds = [
        'cfg-idle', 'cfg-sens', 'cfg-delta', 'cfg-rate', 'cfg-lte',
        'cfg-sim-pin', 'cfg-sim-apn', 'btn-toggle-live', 'btn-save-cfg'
    ];
    settingControlIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.disabled = !unlocked;
            if (!unlocked) {
                el.classList.add('opacity-50', 'cursor-not-allowed');
            } else {
                el.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    });

    // LTE-Diagnose Button im Parameter-Tab sperren / freigeben
    const lteBtn = document.querySelector('#tab-settings button[onclick*="triggerLteDiagnosticTest"]');
    if (lteBtn) {
        lteBtn.disabled = !unlocked;
        if (!unlocked) {
            lteBtn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            lteBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    // 3. Status-Banner im Parameter-Tab anzeigen
    const banner = document.getElementById('settings-lock-banner');
    if (banner) {
        if (unlocked) {
            banner.className = "bg-emerald-50 border border-emerald-300 rounded-lg p-3 mb-4 flex justify-between items-center text-xs text-emerald-800 shadow-sm";
            banner.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="text-base">🔓</span>
                    <span><strong class="font-bold">Freigegeben:</strong> Parameter können bearbeitet und gespeichert werden.</span>
                </div>
                <button type="button" onclick="toggleSessionLock()" class="bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 px-2.5 py-1 rounded text-xs font-bold transition">
                    Sperren
                </button>
            `;
        } else {
            banner.className = "bg-amber-50 border border-amber-300 rounded-lg p-3 mb-4 flex justify-between items-center text-xs text-amber-800 shadow-sm";
            banner.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="text-base">🔒</span>
                    <span><strong class="font-bold">Schreibgeschützt:</strong> Zum Ändern von Parametern ist eine Freigabe erforderlich.</span>
                </div>
                <button type="button" onclick="openSessionAuthModal()" class="bg-stag-green hover:bg-emerald-600 text-white px-3 py-1 rounded text-xs font-bold transition shadow-sm">
                    Freischalten
                </button>
            `;
        }
    }
}

function toggleSessionLock() {
    if (isSessionUnlocked()) {
        sessionStorage.removeItem('stag_admin_unlocked');
        updateLockUI();
        appendTerminalLog('[AUTH] Sitzung gesperrt. Löschfunktionen ausgeblendet.');
    } else {
        openSessionAuthModal();
    }
}

function openSessionAuthModal() {
    const modal = document.getElementById('session-auth-modal');
    const input = document.getElementById('session-pass-input');
    const err = document.getElementById('session-auth-err');
    if (modal) modal.classList.remove('hidden');
    if (input) { input.value = ''; input.focus(); }
    if (err) err.classList.add('hidden');
}

function closeSessionAuthModal() {
    const modal = document.getElementById('session-auth-modal');
    if (modal) modal.classList.add('hidden');
}

function handleSessionAuthSubmit(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('session-pass-input');
    const err = document.getElementById('session-auth-err');
    if (input && input.value === 'stag2026') {
        sessionStorage.setItem('stag_admin_unlocked', 'true');
        closeSessionAuthModal();
        updateLockUI();
        appendTerminalLog('[AUTH] Sitzung erfolgreich entsperrt. Löschfunktionen freigegeben.');
    } else {
        if (err) err.classList.remove('hidden');
        if (input) input.select();
    }
}

// Bereinigtes Löschen: Kein prompt() mehr, sondern einfaches confirm() bei entsperrtem Schloss
async function deleteImuCloudFile(filePath, fileName) {
    if (!isSessionUnlocked()) {
        openSessionAuthModal();
        return;
    }

    if (!confirm(`Möchten Sie "${fileName}" unwiderruflich aus der Cloud löschen?`)) {
        return;
    }

    try {
        const { error: sErr } = await sbClient.storage.from('imu-logs').remove([filePath]);
        if (sErr) throw sErr;

        const { error: dbErr } = await sbClient.from('imu_log_files').delete().eq('file_path', filePath);
        if (dbErr) throw dbErr;

        const titleEl = document.getElementById('replay-file-title');
        if (titleEl && titleEl.innerText === fileName) {
            closeImuReplayDeck();
        }

        currentDeviceFiles = currentDeviceFiles.filter(f => f.file_path !== filePath);
        const parts = filePath.split('/');
        const activeDateStr = parts.find(p => /^\d{4}-\d{2}-\d{2}$/.test(p)) || parts[1] || '';

        const dayFilesRemaining = currentDeviceFiles.filter(f => getFileDayKey(f) === activeDateStr);

        if (dayFilesRemaining.length > 0) {
            openDailyTimeline(activeDateStr);
            renderCalendarUI();
        } else {
            closeDailyTimeline();
            fetchImuCloudLogs();
        }
        appendTerminalLog(`[STORAGE] Datei gelöscht: ${fileName}`);
    } catch (err) {
        alert('Fehler beim Löschen: ' + (err.message || JSON.stringify(err)));
    }
}

// Window Exporte sicherstellen
window.fetchImuCloudLogs = fetchImuCloudLogs;
window.changeCalendarMonth = changeCalendarMonth;
window.setCalendarViewMode = setCalendarViewMode;
window.openDailyTimeline = openDailyTimeline;
window.closeDailyTimeline = closeDailyTimeline;
window.deleteImuCloudFile = deleteImuCloudFile;
window.toggleSessionLock = toggleSessionLock;
window.openSessionAuthModal = openSessionAuthModal;
window.closeSessionAuthModal = closeSessionAuthModal;
window.handleSessionAuthSubmit = handleSessionAuthSubmit;
window.updateLockUI = updateLockUI;
window.isSessionUnlocked = isSessionUnlocked;