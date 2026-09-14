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
        if (!ind) return;
        if (status === 'SUBSCRIBED') {
            ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ${selectedDeviceId} LIVE`;
            ind.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-300';
        } else {
            ind.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> ${status}`;
            ind.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-300';
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
    document.getElementById('cfg-sens').value = data.sens || 0.20;
    document.getElementById('cfg-sens-val').innerText = Number(data.sens || 0.20).toFixed(2) + ' m/s²';
    document.getElementById('cfg-delta').value = data.delta || 0.10;
    document.getElementById('cfg-delta-val').innerText = Number(data.delta || 0.10).toFixed(2);
    document.getElementById('cfg-rate').value = data.rate || 10;
    document.getElementById('cfg-rate-val').innerText = (data.rate || 10) + ' Hz';
    document.getElementById('cfg-lte').value = data.lte_interval || 5;
    document.getElementById('cfg-lte-val').innerText = (data.lte_interval || 5) + ' min';

    if (data.sim_pin) document.getElementById('cfg-sim-pin').value = data.sim_pin;
    if (data.sim_apn) document.getElementById('cfg-sim-apn').value = data.sim_apn;

    liveModeActive = data.continuous_mode || false;
    const btn = document.getElementById('btn-toggle-live');
    btn.innerText = liveModeActive ? 'AKTIV' : 'AUS';
    btn.className = liveModeActive
        ? "px-3 py-1.5 rounded text-xs font-bold bg-stag-green text-white shadow-sm transition"
        : "px-3 py-1.5 rounded text-xs font-bold bg-white text-slate-700 border border-slate-300 transition";
}

async function saveConfigToCloud() {
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

function toggleLiveModeUI() {
    liveModeActive = !liveModeActive;
    const btn = document.getElementById('btn-toggle-live');
    btn.innerText = liveModeActive ? 'AKTIV' : 'AUS';
    btn.className = liveModeActive
        ? "px-3 py-1.5 rounded text-xs font-bold bg-stag-green text-white shadow-sm transition"
        : "px-3 py-1.5 rounded text-xs font-bold bg-white text-slate-700 border border-slate-300 transition";
}

/*
* Breadcrumb: 2026-09-13 10:15 - Cloud-Triggered LTE Diagnostic Test Dispatcher
*/
async function triggerLteDiagnosticTest() {
    if (window.ensureTerminalOpen) {
        window.ensureTerminalOpen();
    }
    appendTerminalLog(`\n[LTE TEST] Fordere Mobilfunk-Diagnose für ${selectedDeviceId} an...`);
    await sendCloudCommand('LTE_TEST', '/', `Starte LTE-Test auf ${selectedDeviceId}...`);
}

window.triggerLteDiagnosticTest = triggerLteDiagnosticTest;