/*
 * Breadcrumb: 2026-09-11 06:40 - GitHub Dashboard Triple Accel Engine with Synchronized Global Scaling
 * Feature: 
 *  1. Implements 3 dedicated oscilloscope canvases for Linear Acceleration (X, Y, Z).
 *  2. Synchronized temporal X-axis zoom (2s - 60s) and pan/scroll controls with LIVE auto-snap.
 *  3. Global dynamic vertical scaling across all 3 channels pinned to the highest amplitude in view.
 *  4. Enforces a 1.5 m/s² minimum scale floor to prevent amplification of resting sensor noise.
 */

const SUPABASE_URL = "https://fajwusnwfywfebyffxtf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhand1c253Znl3ZmVieWZmeHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NzYxMjcsImV4cCI6MjEwNDU1MjEyN30.Yt-COlgIh5TySB01EGrdddrZguxW30cwhCeXdMjQ0aM";
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let chartInstance = null;
let liveModeActive = false;

// --- 3D ENGINE STATE ---
let scene, camera, renderer, modelMesh;
let qw = 1, qx = 0, qy = 0, qz = 0;
let lastQw = 1, lastQx = 0, lastQy = 0, lastQz = 0;
let curAx = 0, curAy = 0, curAz = 0;
let posX = 0, posY = 0, posZ = 0;

// --- BESCHLEUNIGUNGS-RINGPUFFER & OSZILLOSKOP STATE ---
const accHistory = [];
const maxAccPoints = 1800; // 180 Sekunden bei 10 Hz
let accZoom = 100;         // 100 Punkte = 10 s Standardfenster
let accPan = 100;          // 0 bis 100% (100 = Live-Rand)
let isAccLive = true;

function createFallbackCube() {
    if (modelMesh && scene) scene.remove(modelMesh);
    const geo = new THREE.BoxGeometry(1.8, 0.35, 0.9);
    const mat = new THREE.MeshStandardMaterial({ color: 0x009B4C, metalness: 0.3, roughness: 0.4 });
    modelMesh = new THREE.Mesh(geo, mat);
    scene.add(modelMesh);
}

function setupModelMesh(gltfScene) {
    if (modelMesh && scene) scene.remove(modelMesh);
    modelMesh = gltfScene;

    const box = new THREE.Box3().setFromObject(modelMesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        modelMesh.scale.set(s, s, s);
    }
    scene.add(modelMesh);
}

function loadGLBModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
        createFallbackCube();
        return;
    }
    const loader = new THREE.GLTFLoader();
    loader.load('./IMU.glb', (gltf) => {
        setupModelMesh(gltf.scene);
        console.log("[3D] IMU.glb erfolgreich geladen!");
    }, undefined, (err) => {
        console.warn("[3D] IMU.glb nicht gefunden, Fallback aktiv:", err);
        createFallbackCube();
    });
}

function init3D() {
    const container = document.getElementById('canvas-container');
    const w = container.clientWidth || (window.innerWidth - 30);
    const h = container.clientHeight || (window.innerHeight * 0.40);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(0, 0, 3.8);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const l1 = new THREE.DirectionalLight(0xffffff, 1.2);
    l1.position.set(5, 10, 7);
    scene.add(l1);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.6);
    l2.position.set(-5, -10, -7);
    scene.add(l2);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    createFallbackCube();
    loadGLBModel();

    window.addEventListener('resize', () => {
        const nw = container.clientWidth;
        const nh = container.clientHeight;
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
        drawAccGraphs();
    });

    function animate() {
        requestAnimationFrame(animate);
        if (modelMesh) {
            const norm = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            if (norm > 0.0001) {
                modelMesh.quaternion.set(-qy / norm, qx / norm, qz / norm, qw / norm);
                modelMesh.quaternion.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));
            }

            const aLen = Math.hypot(curAx, curAy, curAz);
            const axF = (aLen > 0.20) ? curAx : 0;
            const ayF = (aLen > 0.20) ? curAy : 0;
            const azF = (aLen > 0.20) ? curAz : 0;

            const aVec = new THREE.Vector3(ayF, -axF, azF);
            aVec.applyQuaternion(modelMesh.quaternion);

            const tx = Math.max(-0.45, Math.min(0.45, aVec.x * 0.05));
            const ty = Math.max(-0.45, Math.min(0.45, aVec.y * 0.05));
            const tz = Math.max(-0.45, Math.min(0.45, aVec.z * 0.05));

            posX += (tx - posX) * 0.15;
            posY += (ty - posY) * 0.15;
            posZ += (tz - posZ) * 0.15;
            modelMesh.position.set(posX, posY, posZ);
        }
        renderer.render(scene, camera);
    }
    animate();
}

// --- SYNCHRONISIERTE OSZILLOSKOP-FUNKTIONEN ---
function onAccZoom(v) {
    accZoom = parseInt(v, 10);
    document.getElementById('acc-zoom-val').innerText = (accZoom / 10).toFixed(0) + 's';
    drawAccGraphs();
}

function onAccPan(v) {
    accPan = parseFloat(v);
    isAccLive = (accPan >= 99);
    document.getElementById('acc-pan-val').innerText = isAccLive ? 'LIVE' : accPan.toFixed(0) + '%';
    document.getElementById('btn-acc-live').style.backgroundColor = isAccLive ? '#009B4C' : '#1f2937';
    drawAccGraphs();
}

function jumpAccLive() {
    accPan = 100;
    document.getElementById('acc-pan').value = 100;
    onAccPan(100);
}

function drawSingleAxis(cvId, axisKey, color, label, maxAbs, startIdx, endIdx) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;

    // Nulllinie (Dashed)
    ctx.strokeStyle = '#1e2a3a';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    const count = endIdx - startIdx;
    if (count < 2) {
        ctx.fillStyle = '#556677';
        ctx.font = '10px monospace';
        ctx.fillText(`${label} (Warte auf Daten...)`, 10, midY + 3);
        return;
    }

    // Y-Skalenbeschriftung (global synchronisiert)
    ctx.fillStyle = '#607286';
    ctx.font = '9px monospace';
    ctx.fillText(`+${maxAbs.toFixed(1)}`, 4, 11);
    ctx.fillText(`-${maxAbs.toFixed(1)}`, 4, h - 3);

    // Kurvenverlauf
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const px = (i / (count - 1)) * w;
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 4);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Aktueller Messwert
    const cur = accHistory[endIdx - 1][axisKey];
    ctx.fillStyle = color;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`${label}: ${(cur >= 0 ? '+' : '')}${cur.toFixed(2)} m/s²`, w - 140, 11);
}

function drawAccGraphs() {
    const total = accHistory.length;
    if (total < 2) {
        drawSingleAxis('cv-acc-x', 'x', '#ef4444', 'ACC X', 1.5, 0, 0);
        drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', 1.5, 0, 0);
        drawSingleAxis('cv-acc-z', 'z', '#3b82f6', 'ACC Z', 1.5, 0, 0);
        return;
    }

    const win = Math.min(accZoom, total);
    const maxStart = Math.max(0, total - win);
    const startIdx = isAccLive ? maxStart : Math.round((accPan / 100) * maxStart);
    const endIdx = Math.min(total, startIdx + win);

    // Globale Y-Maximalauslenkung über alle 3 Achsen im sichtbaren Ausschnitt berechnen
    let globalMax = 1.5;
    for (let i = startIdx; i < endIdx; i++) {
        const ax = Math.abs(accHistory[i].x);
        const ay = Math.abs(accHistory[i].y);
        const az = Math.abs(accHistory[i].z);
        if (ax > globalMax) globalMax = ax;
        if (ay > globalMax) globalMax = ay;
        if (az > globalMax) globalMax = az;
    }
    globalMax = Math.ceil(globalMax * 1.15 * 10) / 10;

    drawSingleAxis('cv-acc-x', 'x', '#ef4444', 'ACC X', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-z', 'z', '#3b82f6', 'ACC Z', globalMax, startIdx, endIdx);
}

function initRealtimeChannel() {
    const channel = sbClient.channel('imu_live', {
        config: { broadcast: { ack: false } }
    });

    channel.on('broadcast', { event: 'pos' }, (event) => {
        const d = event.payload?.payload || event.payload;
        if (!d) return;

        let inW = d.w, inX = d.x, inY = d.y, inZ = d.z;
        if ((inW * lastQw + inX * lastQx + inY * lastQy + inZ * lastQz) < 0) {
            inW = -inW; inX = -inX; inY = -inY; inZ = -inZ;
        }

        qw = inW; qx = inX; qy = inY; qz = inZ;
        lastQw = qw; lastQx = qx; lastQy = qy; lastQz = qz;

        if (d.ax !== undefined) {
            curAx = d.ax; curAy = d.ay; curAz = d.az;
            accHistory.push({ x: curAx, y: curAy, z: curAz });
            if (accHistory.length > maxAccPoints) accHistory.shift();
            drawAccGraphs();
        }

        document.getElementById('overlay-status').innerHTML =
            `ROT: W:${qw.toFixed(2)} X:${qx.toFixed(2)} Y:${qy.toFixed(2)} Z:${qz.toFixed(2)}<br>ACC: X:${curAx.toFixed(2)} Y:${curAy.toFixed(2)} Z:${curAz.toFixed(2)} m/s²`;
    });

    channel.subscribe((status) => {
        const ind = document.getElementById('realtime-indicator');
        if (status === 'SUBSCRIBED') {
            ind.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Realtime LIVE';
            ind.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-950/40 text-green-400 border border-green-800';
        } else {
            ind.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500"></span> ' + status;
        }
    });
}

// --- SD-DATEIMANAGER ROUTINEN ---
let currentSdDir = '/';

function getBoardBase() {
    let b = document.getElementById('board-endpoint').value.trim();
    while (b.endsWith('/')) b = b.substring(0, b.length - 1);
    return b || 'http://10.10.10.1';
}

async function loadSdDirectory(dir) {
    currentSdDir = dir || '/';
    document.getElementById('sd-current-path').innerText = currentSdDir;
    const listEl = document.getElementById('sd-file-list');
    listEl.innerHTML = '<div class="text-xs text-gray-400 py-3 text-center">Lade Ordnerinhalt...</div>';

    const base = getBoardBase();

    // Mixed-Content-Prüfung: HTTPS-Webseiten blockieren HTTP-Anfragen an lokale IPs
    if (window.location.protocol === 'https:' && base.startsWith('http://')) {
        listEl.innerHTML = `
      <div class="p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-300 leading-relaxed">
        <b>⚠️ Browser-Sicherheitsblockade (Mixed Content):</b><br>
        GitHub Pages läuft über <b>HTTPS</b>. Dein Browser verbietet direkte Abfragen an unverschlüsselte lokale Board-Adressen (<code>${base}</code>).<br><br>
        <b>Lösungsmöglichkeiten:</b><br>
        1. Öffne die <code>index.html</code> lokal von deiner Festplatte per Doppelklick (<code>file:///...</code>) oder über <code>http://localhost</code>.<br>
        2. Klicke im Browser links neben der URL auf das Icon für Website-Einstellungen und setze <i>"Unsichere Inhalte" (Insecure Content)</i> auf <b>Zulassen</b>.<br>
        3. Verbinde dich direkt mit dem Board-WLAN unter <a href="http://10.10.10.1" class="text-green-400 underline font-bold" target="_blank">http://10.10.10.1</a>.
      </div>
    `;
        return;
    }

    try {
        const res = await fetch(`${base}/browse?dir=${encodeURIComponent(currentSdDir)}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        if (!data.items || data.items.length === 0) {
            listEl.innerHTML = '<div class="text-xs text-gray-500 py-3 text-center">Dieser Ordner ist leer.</div>';
            return;
        }

        listEl.innerHTML = data.items.map(item => {
            const fullPath = (currentSdDir === '/' ? '' : currentSdDir) + '/' + item.name;
            if (item.is_dir) {
                return `
          <div class="flex justify-between items-center p-2 rounded bg-green-950/20 border border-green-900/40 cursor-pointer hover:bg-green-950/40 transition"
               onclick="loadSdDirectory('${fullPath}')">
            <span class="text-xs font-bold text-green-400">📁 ${item.name}</span>
            <span class="text-xs text-gray-400">Öffnen ➔</span>
          </div>
        `;
            } else {
                const kb = (item.size / 1024).toFixed(1);
                return `
          <div class="flex justify-between items-center p-2 rounded bg-gray-900 border border-gray-800 text-xs font-mono">
            <span class="text-gray-300 truncate mr-2">📄 ${item.name} <span class="text-gray-500 text-[10px]">(${kb} KB)</span></span>
            <div class="flex items-center gap-2">
              <a href="${base}/download?file=${encodeURIComponent(fullPath)}" download class="text-green-400 hover:underline">Download</a>
              <button onclick="deleteSdFile('${fullPath}')" class="text-red-400 hover:text-red-300">✕</button>
            </div>
          </div>
        `;
            }
        }).join('');
    } catch (err) {
        listEl.innerHTML = `<div class="text-xs text-red-400 py-3 text-center">Verbindung fehlgeschlagen (${err.message}).<br>Stelle sicher, dass du im selben WLAN wie das Board bist.</div>`;
    }
}

function navigateSdUp() {
    if (currentSdDir === '/' || currentSdDir === '') return;
    const lastSlash = currentSdDir.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : currentSdDir.substring(0, lastSlash);
    loadSdDirectory(parent);
}

async function deleteSdFile(path) {
    if (!confirm('Datei wirklich löschen?\n' + path)) return;
    try {
        const base = getBoardBase();
        await fetch(`${base}/delete?file=${encodeURIComponent(path)}`);
        loadSdDirectory(currentSdDir);
    } catch (e) {
        alert('Fehler beim Löschen.');
    }
}

async function uploadFileToSd() {
    const fileInput = document.getElementById('sd-upload-file');
    const stat = document.getElementById('sd-upload-status');
    if (!fileInput.files.length) {
        stat.innerText = 'Bitte eine Datei auswählen.';
        return;
    }

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file, file.name);

    stat.innerText = `Lade ${file.name} nach ${currentSdDir}...`;
    try {
        const base = getBoardBase();
        const res = await fetch(`${base}/upload?dir=${encodeURIComponent(currentSdDir)}`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            stat.innerText = `✓ ${file.name} erfolgreich hochgeladen!`;
            stat.className = 'text-xs font-mono mt-2 text-green-400 font-bold';
            fileInput.value = '';
            setTimeout(() => loadSdDirectory(currentSdDir), 800);
        } else {
            throw new Error('HTTP ' + res.status);
        }
    } catch (e) {
        stat.innerText = 'Upload-Fehler: ' + e.message;
        stat.className = 'text-xs font-mono mt-2 text-red-400 font-bold';
    }
}

// --- TAB NAVIGATION ---
function switchTab(tab) {
    ['3d', 'telemetry', 'files', 'settings', 'ota'].forEach(t => {
        document.getElementById(`tab-${t}`).classList.add('hidden');
        document.getElementById(`btn-tab-${t}`).className = "bg-gray-800 text-gray-400 px-4 py-2 rounded text-xs font-bold uppercase whitespace-nowrap hover:text-white transition";
    });
    document.getElementById(`tab-${tab}`).classList.remove('hidden');
    document.getElementById(`btn-tab-${tab}`).className = "bg-stag-green text-white px-4 py-2 rounded text-xs font-bold uppercase whitespace-nowrap transition";

    if (tab === '3d') setTimeout(drawAccGraphs, 60);
    if (tab === 'telemetry') fetchLatestData();
    if (tab === 'files') loadSdDirectory(currentSdDir);
    if (tab === 'settings') fetchConfig();
    if (tab === 'ota') fetchReleases();
}

function toggleLiveModeUI() {
    liveModeActive = !liveModeActive;
    const btn = document.getElementById('btn-toggle-live');
    btn.innerText = liveModeActive ? 'AKTIV' : 'AUS';
    btn.className = liveModeActive
        ? "px-3 py-1.5 rounded text-xs font-bold bg-stag-green text-white border border-green-400 transition"
        : "px-3 py-1.5 rounded text-xs font-bold bg-gray-800 text-gray-400 border border-gray-600 transition";
}

async function fetchConfig() {
    const { data, error } = await sbClient.from('device_config').select('*').eq('device_id', 'STAG-IMU-01').single();
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
        ? "px-3 py-1.5 rounded text-xs font-bold bg-stag-green text-white border border-green-400 transition"
        : "px-3 py-1.5 rounded text-xs font-bold bg-gray-800 text-gray-400 border border-gray-600 transition";
}

/*
 * Breadcrumb: 2026-09-11 07:05 - Fault-Tolerant Config Upsert & Mixed-Content Guard
 * [CRITICAL BUGFIX FLAG - SCHEMA & MIXED CONTENT]:
 * 1. Falls sim_pin/sim_apn in Supabase fehlen, fällt saveConfigToCloud automatisch auf 
 *    die Basiskonfiguration zurück, damit Abtastrate und Schwellenwerte nie blockiert werden.
 * 2. loadSdDirectory fängt Mixed-Content-Blockaden auf GitHub Pages (HTTPS -> HTTP) ab
 *    und zeigt eine klare Handlungsanweisung im UI.
 */
async function saveConfigToCloud() {
    const btn = document.getElementById('btn-save-cfg');
    const status = document.getElementById('cfg-status-msg');
    btn.disabled = true;
    btn.classList.add('opacity-50');
    status.innerText = 'Speichere Parameter in Supabase...';

    const basePayload = {
        device_id: 'STAG-IMU-01',
        idle_timeout_sec: parseInt(document.getElementById('cfg-idle').value, 10),
        sens: parseFloat(document.getElementById('cfg-sens').value),
        delta: parseFloat(document.getElementById('cfg-delta').value),
        rate: parseInt(document.getElementById('cfg-rate').value, 10),
        lte_interval: parseInt(document.getElementById('cfg-lte').value, 10),
        continuous_mode: liveModeActive,
        updated_at: new Date().toISOString()
    };

    // Versuche zuerst mit SIM-Daten zu speichern
    let payload = {
        ...basePayload,
        sim_pin: document.getElementById('cfg-sim-pin').value.trim(),
        sim_apn: document.getElementById('cfg-sim-apn').value.trim()
    };

    let { error } = await sbClient.from('device_config').upsert(payload);

    // Fallback: Falls Spalten in Supabase noch nicht existieren, ohne SIM-Felder speichern
    if (error && error.message.includes('column')) {
        console.warn('[CONFIG] SIM-Spalten nicht im Schema, speichere Basiskonfiguration:', error.message);
        const retry = await sbClient.from('device_config').upsert(basePayload);
        error = retry.error;
    }

    btn.disabled = false;
    btn.classList.remove('opacity-50');

    if (error) {
        status.innerText = 'Fehler beim Speichern: ' + error.message;
        status.className = 'text-xs text-center mt-2 text-red-400 font-mono font-bold';
    } else {
        status.innerText = '✓ Gespeichert! Board übernimmt Werte beim nächsten Sync.';
        status.className = 'text-xs text-center mt-2 text-green-400 font-mono font-bold';
    }
}

function initChart(labels, voltages, percents) {
    const ctx = document.getElementById('batChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                { label: 'Spannung (V)', data: voltages, borderColor: '#009B4C', backgroundColor: 'rgba(0, 155, 76, 0.1)', yAxisID: 'yVolt', tension: 0.25, fill: true },
                { label: 'Kapazität (%)', data: percents, borderColor: '#3498db', yAxisID: 'yPct', borderDash: [5, 5], tension: 0.2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#7f8c8d', maxTicksLimit: 8 }, grid: { color: '#1a2332' } },
                yVolt: { type: 'linear', position: 'left', min: 3.2, max: 4.3, ticks: { color: '#009B4C' }, grid: { color: '#1a2332' } },
                yPct: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { color: '#3498db' }, grid: { display: false } }
            },
            plugins: { legend: { labels: { color: '#ecf0f1' } } }
        }
    });
}

async function fetchLatestData() {
    const { data, error } = await sbClient
        .from('battery_logs')
        .select('*')
        .eq('device_id', 'STAG-IMU-01')
        .order('recorded_at', { ascending: false })
        .limit(100);

    if (error || !data || data.length === 0) return;

    const latest = data[0];
    const recTime = new Date(latest.recorded_at);

    document.getElementById('metric-pct').innerText = `${latest.battery_percent}%`;
    document.getElementById('metric-volt').innerText = `${Number(latest.battery_voltage).toFixed(3)} V`;
    document.getElementById('metric-status').innerText = latest.charging_status;
    document.getElementById('metric-boot').innerText = `#${latest.boot_cycle}`;
    document.getElementById('metric-time').innerText = recTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('metric-ago').innerText = recTime.toLocaleDateString();

    const reversed = [...data].reverse();
    const labels = reversed.map(r => new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const volts = reversed.map(r => r.battery_voltage);
    const pcts = reversed.map(r => r.battery_percent);

    initChart(labels, volts, pcts);

    document.getElementById('log-table-body').innerHTML = data.slice(0, 20).map(r => `
    <tr class="hover:bg-gray-800/40">
      <td class="py-2 px-3 text-gray-300">${new Date(r.recorded_at).toLocaleString()}</td>
      <td class="py-2 px-3 text-green-400 font-semibold">${Number(r.battery_voltage).toFixed(3)} V</td>
      <td class="py-2 px-3">${r.battery_percent}%</td>
      <td class="py-2 px-3 text-gray-400">${r.charging_status}</td>
      <td class="py-2 px-3">#${r.boot_cycle}</td>
    </tr>
  `).join('');
}

async function fetchReleases() {
    const { data, error } = await sbClient.from('firmware_releases').select('*').order('id', { ascending: false });
    const tbody = document.getElementById('releases-table-body');
    if (error || !data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-500">Keine Releases vorhanden.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map((rel, idx) => `
    <tr class="hover:bg-gray-800/40 ${idx === 0 ? 'bg-green-950/20' : ''}">
      <td class="py-2 px-3 font-bold text-green-400">
        ${rel.version} ${idx === 0 ? '<span class="ml-1 text-[10px] bg-stag-green text-white px-1.5 py-0.5 rounded">LATEST</span>' : ''}
      </td>
      <td class="py-2 px-3 text-gray-400">${new Date(rel.created_at).toLocaleString()}</td>
      <td class="py-2 px-3 text-gray-300 max-w-xs truncate">${rel.release_notes || '-'}</td>
      <td class="py-2 px-3 text-right"><a href="${rel.bin_url}" download class="text-green-500 hover:underline">Download</a></td>
    </tr>
  `).join('');
}

async function handleFirmwareUpload(e) {
    e.preventDefault();
    const file = document.getElementById('ota-file').files[0];
    const version = document.getElementById('ota-version').value.trim();
    const notes = document.getElementById('ota-notes').value.trim();
    const btn = document.getElementById('btn-upload-ota');
    const pBox = document.getElementById('upload-progress-box');
    const pBar = document.getElementById('upload-progress-bar');
    const pMsg = document.getElementById('upload-status-msg');

    if (!file || !version) return;

    btn.disabled = true;
    pBox.classList.remove('hidden');
    pBar.style.width = '25%';
    pMsg.innerText = 'Lade Binary in Storage hoch...';

    try {
        const storagePath = `releases/${version}_${Date.now()}.bin`;
        const { error: upErr } = await sbClient.storage.from('firmware').upload(storagePath, file, { upsert: true });
        if (upErr) throw upErr;

        pBar.style.width = '70%';
        pMsg.innerText = 'Erstelle Datenbank-Eintrag...';

        const { data: urlData } = sbClient.storage.from('firmware').getPublicUrl(storagePath);
        const { error: dbErr } = await sbClient.from('firmware_releases').insert([{
            version: version,
            bin_url: urlData.publicUrl,
            release_notes: notes
        }]);
        if (dbErr) throw dbErr;

        pBar.style.width = '100%';
        pMsg.innerText = `Firmware Release ${version} aktiv!`;
        pMsg.className = 'text-xs text-green-400 mt-2 text-center font-bold';

        document.getElementById('ota-file').value = '';
        document.getElementById('ota-version').value = '';
        document.getElementById('ota-notes').value = '';
        fetchReleases();
    } catch (err) {
        pMsg.innerText = 'Upload-Fehler: ' + (err.message || JSON.stringify(err));
        pMsg.className = 'text-xs text-red-400 mt-2 text-center font-bold';
    } finally {
        btn.disabled = false;
    }
}

function fetchAllData() {
    fetchLatestData();
    fetchConfig();
    fetchReleases();
}

window.onload = () => {
    init3D();
    initRealtimeChannel();
    fetchAllData();
    setInterval(fetchLatestData, 30000);
};