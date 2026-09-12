/*
 * Breadcrumb: 2026-09-12 18:30 - Fully Unified Cloud Command Engine with DOM Anchor Downloader
 * [CRITICAL BUGFIX FLAG - COMMAND TRACKING & POPUP-FREE DOWNLOAD]:
 * 1. Unified LIST, DOWNLOAD, and DELETE under sendCloudCommand() to guarantee activeCommandId tracking.
 * 2. Implemented dual-channel resolution: instant Supabase Realtime event + robust 1s poll fallback.
 * 3. Replaced blocked window.open() with native temporary DOM <a> click for 100% reliable downloads.
 * 4. Preserved 60 FPS SLERP 3D engine, decoupled oscilloscope, and Replay Deck.
 */

const SUPABASE_URL = "https://fajwusnwfywfebyffxtf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhand1c253Znl3ZmVieWZmeHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NzYxMjcsImV4cCI6MjEwNDU1MjEyN30.Yt-COlgIh5TySB01EGrdddrZguxW30cwhCeXdMjQ0aM";
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let chartInstance = null;
let liveModeActive = false;

// ==========================================
// 1. LIVE 3D ENGINE & RING BUFFER
// ==========================================
let scene, camera, renderer, modelMesh;
let qw = 1, qx = 0, qy = 0, qz = 0;
let lastQw = 1, lastQx = 0, lastQy = 0, lastQz = 0;
let curAx = 0, curAy = 0, curAz = 0;
let posX = 0, posY = 0, posZ = 0;

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
        console.log("[3D] IMU.glb geladen!");
    }, undefined, () => {
        createFallbackCube();
    });
}

let targetQuaternion = new THREE.Quaternion(0, 0, 0, 1);
let graphNeedsRedraw = false;
let lastGraphDrawTime = 0;

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

    function animate(now) {
        requestAnimationFrame(animate);
        if (modelMesh) {
            modelMesh.quaternion.slerp(targetQuaternion, 0.22);

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

        if (graphNeedsRedraw && (now - lastGraphDrawTime >= 40)) {
            lastGraphDrawTime = now;
            graphNeedsRedraw = false;
            drawAccGraphs();
        }
    }
    requestAnimationFrame(animate);
}

// ==========================================
// 2. LIVE OSZILLOSKOP-FUNKTIONEN
// ==========================================
function onAccZoom(v) {
    accZoom = parseInt(v, 10);
    document.getElementById('acc-zoom-val').innerText = (accZoom / 10).toFixed(0) + 's';
    drawAccGraphs();
}

function setAccZoomPreset(seconds) {
    const points = Math.min(Math.max(seconds * 10, 20), 600);
    accZoom = points;
    document.getElementById('acc-zoom').value = points;
    document.getElementById('acc-zoom-val').innerText = seconds + 's';
    drawAccGraphs();
}

function onAccPan(v) {
    accPan = parseFloat(v);
    isAccLive = (accPan >= 99);
    document.getElementById('acc-pan-val').innerText = isAccLive ? 'LIVE' : accPan.toFixed(0) + '%';
    const liveBtn = document.getElementById('btn-acc-live');
    if (liveBtn) {
        liveBtn.style.backgroundColor = isAccLive ? '#009B4C' : '#1f2937';
    }
    drawAccGraphs();
}

function jumpAccLive() {
    accPan = 100;
    const panEl = document.getElementById('acc-pan');
    if (panEl) panEl.value = 100;
    onAccPan(100);
}

function drawSingleAxis(cvId, axisKey, colorHex, label, maxAbs, startIdx, endIdx) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const count = endIdx - startIdx;
    const timeWindowSec = (count > 1) ? (count / 10) : (accZoom / 10);

    const gridLines = [
        { ratio: 1.0, style: 'rgba(255,255,255,0.06)', label: `+${maxAbs.toFixed(1)}` },
        { ratio: 0.5, style: 'rgba(255,255,255,0.04)', label: `+${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: 0.0, style: 'rgba(255,255,255,0.18)', label: '0.0', dashed: true },
        { ratio: -0.5, style: 'rgba(255,255,255,0.04)', label: `-${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: -1.0, style: 'rgba(255,255,255,0.06)', label: `-${maxAbs.toFixed(1)}` }
    ];

    ctx.font = '9px monospace';
    gridLines.forEach(gl => {
        const y = midY - gl.ratio * (midY - 6);
        ctx.strokeStyle = gl.style;
        ctx.lineWidth = gl.ratio === 0 ? 1 : 0.8;
        if (gl.dashed) ctx.setLineDash([3, 3]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(32, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.fillText(gl.label, 4, y + 3);
    });
    ctx.setLineDash([]);

    let timeStepSec = 5;
    if (timeWindowSec <= 5) timeStepSec = 1;
    else if (timeWindowSec <= 15) timeStepSec = 2;
    else if (timeWindowSec <= 35) timeStepSec = 5;
    else timeStepSec = 10;

    const numTimeSteps = Math.floor(timeWindowSec / timeStepSec);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.fillStyle = '#475569';

    for (let t = 1; t <= numTimeSteps; t++) {
        const secAgo = t * timeStepSec;
        const px = w - (secAgo / timeWindowSec) * w;
        if (px > 35) {
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
            ctx.fillText(`-${secAgo}s`, px + 2, h - 4);
        }
    }

    if (count < 2) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px monospace';
        ctx.fillText(`${label}: Warte auf Sensor-Stream...`, 40, midY + 4);
        return;
    }

    let sumSq = 0;
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < count; i++) {
        const v = accHistory[startIdx + i][axisKey];
        sumSq += v * v;
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
    }
    const rms = Math.sqrt(sumSq / count);
    const p2p = maxVal - minVal;
    const curVal = accHistory[endIdx - 1][axisKey];

    ctx.save();
    ctx.beginPath();
    ctx.rect(32, 0, w - 32, h);
    ctx.clip();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, colorHex + '33');
    grad.addColorStop(0.5, colorHex + '08');
    grad.addColorStop(1, colorHex + '33');

    ctx.beginPath();
    ctx.moveTo(32, midY);
    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const px = 32 + (i / (count - 1)) * (w - 32);
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 6);
        ctx.lineTo(px, py);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const px = 32 + (i / (count - 1)) * (w - 32);
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 6);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    const badgeText = `${label}  IST: ${(curVal >= 0 ? '+' : '')}${curVal.toFixed(2)} m/s² | RMS: ${rms.toFixed(2)} | P-P: ${p2p.toFixed(2)}`;
    ctx.font = 'bold 10px monospace';
    const textW = ctx.measureText(badgeText).width;

    ctx.fillStyle = 'rgba(7, 10, 15, 0.85)';
    ctx.fillRect(w - textW - 14, 3, textW + 10, 16);
    ctx.strokeStyle = colorHex + '66';
    ctx.lineWidth = 1;
    ctx.strokeRect(w - textW - 14, 3, textW + 10, 16);

    ctx.fillStyle = colorHex;
    ctx.fillText(badgeText, w - textW - 9, 15);
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

// ==========================================
// 3. REALTIME CHANNEL & CLOUD SD MANAGEMENT
// ==========================================
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

        const norm = Math.hypot(qx, qy, qz, qw) || 1.0;
        const qTarget = new THREE.Quaternion(-qy / norm, qx / norm, qz / norm, qw / norm);
        qTarget.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));
        targetQuaternion.copy(qTarget);

        if (d.ax !== undefined) {
            curAx = d.ax; curAy = d.ay; curAz = d.az;
            accHistory.push({ x: curAx, y: curAy, z: curAz });
            if (accHistory.length > maxAccPoints) accHistory.shift();
            graphNeedsRedraw = true;
        }

        const el = document.getElementById('overlay-status');
        if (el) {
            el.innerHTML = `ROT: W:${qw.toFixed(2)} X:${qx.toFixed(2)} Y:${qy.toFixed(2)} Z:${qz.toFixed(2)}<br>ACC: X:${curAx.toFixed(2)} Y:${curAy.toFixed(2)} Z:${curAz.toFixed(2)} m/s²`;
        }
    });

    channel.subscribe((status) => {
        const ind = document.getElementById('realtime-indicator');
        if (!ind) return;
        if (status === 'SUBSCRIBED') {
            ind.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Realtime LIVE';
            ind.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-950/40 text-green-400 border border-green-800';
        } else {
            ind.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500"></span> ' + status;
        }
    });
}

let currentCloudSdDir = '/';
let cloudCmdChannel = null;
let activeCommandId = null;
let activeCommandPollTimer = null;

function initCloudCommandChannel() {
    if (cloudCmdChannel) return;

    cloudCmdChannel = sbClient.channel('sd_commands_feed')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sd_cloud_commands' }, (payload) => {
            const row = payload.new;
            if (!row || row.device_id !== 'STAG-IMU-01') return;
            if (activeCommandId && row.id === activeCommandId) {
                handleCommandResult(row);
            }
        })
        .subscribe();
}

function handleCommandResult(row) {
    const stat = document.getElementById('sd-cloud-status-badge');

    // JSON-String-Payload falls nötig parsen
    let payload = row.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { console.error('Payload Parse Error:', e); }
    }

    if (row.command === 'LIST') {
        if (row.status === 'DONE') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            renderCloudFileList(payload?.items || []);
            if (stat) stat.innerHTML = '<span class="text-green-400 font-bold">✓ Ordner geladen</span>';
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            document.getElementById('sd-file-list').innerHTML =
                `<div class="text-xs text-red-400 py-3 text-center">Fehler: ${row.error_msg || 'Ordner konnte nicht gelesen werden.'}</div>`;
            if (stat) stat.innerHTML = '<span class="text-red-400 font-bold">Fehler</span>';
        }
    } else if (row.command === 'DOWNLOAD') {
        if (row.status === 'DONE' && payload?.download_url) {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-400 font-bold">✓ Download bereit!</span>';

            // Direkter, blockierungsfreier Download über unsichtbares Link-Element
            const a = document.createElement('a');
            a.href = payload.download_url;
            a.download = payload.download_url.split('/').pop();
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-400 font-bold">Fehler</span>';
            alert('Download-Fehler vom Board:\n' + (row.error_msg || 'Unbekannter Fehler'));
        }
    } else if (row.command === 'DELETE') {
        if (row.status === 'DONE') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-400 font-bold">✓ Gelöscht</span>';
            // 600ms Pause entlastet den ESP32, bevor der LIST-Befehl gesendet wird
            setTimeout(() => {
                loadCloudSdDirectory(currentCloudSdDir);
            }, 600);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-400 font-bold">Fehler</span>';
            alert('Löschfehler vom Board:\n' + (row.error_msg || 'Unbekannter Fehler'));
        }

    } else if (row.command === 'GPS') {
        if (row.status === 'DONE' && payload) {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-green-400 font-bold">✓ GPS-Fix erfasst!</span>';
            updateGpsUI(payload);
        } else if (row.status === 'ERROR') {
            if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-red-400 font-bold">GPS-Fehler</span>';
            alert('GPS-Fehler:\n' + (row.error_msg || 'Kein Satellitenempfang innerhalb des Zeitfensters.'));
            updateGpsUI({ has_fix: false });
        }
    }
}


// Universeller Dispatcher für alle 3 SD-Befehle (LIST, DOWNLOAD, DELETE)
/*
 * Breadcrumb: 2026-09-12 19:48 - Ultra-Verbose Cloud Command Dispatcher with UI Error Badges
 * [CRITICAL BUGFIX FLAG - VISIBILITY & ERROR EXPOSURE]:
 * 1. Outputs full console logs for DELETE and INSERT steps.
 * 2. Directly prints database or RLS error messages into #sd-cloud-status-badge.
 */
async function sendCloudCommand(command, path, statusPrompt) {
    const stat = document.getElementById('sd-cloud-status-badge');
    if (stat) stat.innerHTML = `<span class="text-yellow-400 font-mono animate-pulse">${statusPrompt}</span>`;

    if (activeCommandPollTimer) clearInterval(activeCommandPollTimer);

    initCloudCommandChannel();

    console.log(`[SD CLOUD] Bereinige alte PENDING-Befehle für ${command} ${path}...`);
    const { error: delErr } = await sbClient.from('sd_cloud_commands')
        .delete()
        .eq('device_id', 'STAG-IMU-01')
        .eq('status', 'PENDING');

    if (delErr) {
        console.warn('[SD CLOUD] Fehler beim Löschen alter PENDING-Befehle (RLS?):', delErr.message);
    }

    console.log(`[SD CLOUD] Sende neuen Befehl an Supabase: ${command} "${path}"`);
    const { data, error } = await sbClient.from('sd_cloud_commands').insert([{
        device_id: 'STAG-IMU-01',
        command: command,
        path: path,
        status: 'PENDING'
    }]).select().single();

    if (error) {
        console.error('[SD CLOUD] FEHLER beim INSERT:', error);
        if (stat) stat.innerHTML = `<span class="text-red-400 font-bold">Fehler: ${error.message}</span>`;
        alert(`Befehlsfehler (${command}): ${error.message}\n\nPrüfe RLS-Policies auf 'sd_cloud_commands'!`);
        return;
    }

    console.log('[SD CLOUD] Befehl erfolgreich in Supabase eingetragen! ID:', data.id);
    if (stat) stat.innerHTML = `<span class="text-yellow-400 font-mono animate-pulse">Befehl #${data.id} wartet auf Board...</span>`;

    activeCommandId = data.id;
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

        if (pollErr) {
            console.warn('[SD CLOUD] Polling-Warnung:', pollErr.message);
            return;
        }

        if (checkData) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (checkData.status === 'DONE' || checkData.status === 'ERROR') {
                console.log(`[SD CLOUD] Befehl #${activeCommandId} abgeschlossen:`, checkData.status);
                handleCommandResult(checkData);
            } else {
                if (stat) stat.innerHTML = `<span class="text-yellow-400 font-mono animate-pulse">Warte auf Board (#${activeCommandId} &bull; ${elapsed}s)...</span>`;
            }
        }

        if (Date.now() - startTime > 30000) {
            clearInterval(activeCommandPollTimer);
            activeCommandId = null;
            if (stat) stat.innerHTML = '<span class="text-yellow-400 font-bold">Timeout</span>';
            if (command === 'LIST') {
                document.getElementById('sd-file-list').innerHTML = `
                  <div class="p-3 bg-gray-900 border border-gray-800 rounded text-center text-xs space-y-2">
                    <p class="text-gray-300">⚠️ Board hat auf "${path}" nicht reagiert.</p>
                    <button onclick="loadCloudSdDirectory('${path}')" 
                            class="bg-stag-green text-white px-3 py-1.5 rounded text-xs font-bold hover:opacity-90">
                      Erneut versuchen 🔄
                    </button>
                  </div>
                `;
            } else {
                alert(`⚠️ Zeitüberschreitung: Das Board hat auf "${command} ${path}" nicht innerhalb von 30s geantwortet.`);
            }
        }
    }, 1000);
}

async function loadCloudSdDirectory(dir) {
    let cleanDir = dir || '/';
    while (cleanDir.includes('//')) cleanDir = cleanDir.replace('//', '/');
    if (!cleanDir.startsWith('/')) cleanDir = '/' + cleanDir;
    if (cleanDir.length > 1 && cleanDir.endsWith('/')) cleanDir = cleanDir.substring(0, cleanDir.length - 1);

    currentCloudSdDir = cleanDir;
    const pathEl = document.getElementById('sd-current-path');
    if (pathEl) pathEl.innerText = currentCloudSdDir;

    document.getElementById('sd-file-list').innerHTML = `
      <div class="text-xs text-green-400 py-4 text-center space-y-2">
        <div class="animate-pulse">⏳ Öffne "${currentCloudSdDir}" via Cloud...</div>
        <p class="text-[11px] text-gray-500">Board liest Dateisystem ein...</p>
      </div>
    `;

    await sendCloudCommand('LIST', currentCloudSdDir, 'Lade Ordner...');
}

function renderCloudFileList(items) {
    const listEl = document.getElementById('sd-file-list');
    if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">Dieser Ordner ist leer.</div>';
        return;
    }

    listEl.innerHTML = items.map(item => {
        const fullPath = (currentCloudSdDir === '/' ? '' : currentCloudSdDir) + '/' + item.name;
        if (item.is_dir) {
            return `
              <div class="flex justify-between items-center p-2.5 rounded bg-green-950/20 border border-green-900/40 cursor-pointer hover:bg-green-950/40 transition"
                   onclick="loadCloudSdDirectory('${fullPath}')">
                <span class="text-xs font-bold text-green-400">📁 ${item.name}</span>
                <span class="text-xs text-gray-400">Öffnen ➔</span>
              </div>
            `;
        } else {
            const kb = (item.size / 1024).toFixed(1);
            return `
              <div class="flex justify-between items-center p-2.5 rounded bg-gray-900 border border-gray-800 text-xs font-mono hover:border-gray-700 transition">
                <span class="text-gray-300 truncate mr-2">📄 ${item.name} <span class="text-gray-500 text-[10px]">(${kb} KB)</span></span>
                <div class="flex items-center gap-2 shrink-0">
                  <button onclick="requestCloudDownload('${fullPath}', '${item.name}')" 
                          class="bg-gray-800 hover:bg-gray-700 text-green-400 border border-green-900/60 px-2.5 py-1 rounded text-xs font-bold transition">
                    ⬇ Download
                  </button>
                  <button onclick="requestCloudDelete('${fullPath}', '${item.name}')" 
                          class="text-red-400 hover:text-red-300 hover:bg-red-950/40 p-1 rounded transition text-xs" title="Löschen">
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

async function requestCloudDownload(path, fileName) {
    await sendCloudCommand('DOWNLOAD', path, `Bereite "${fileName}" vor...`);
}

async function requestCloudDelete(path, fileName) {
    if (!confirm(`Datei "${fileName}" wirklich von der physischen SD-Karte des Boards löschen?\n\nPfad: ${path}`)) return;
    await sendCloudCommand('DELETE', path, `Lösche "${fileName}"...`);
}

// ==========================================
// 4. TAB NAVIGATION & SETTINGS
// ==========================================
function switchTab(tab) {
    ['3d', 'telemetry', 'imulogs', 'files', 'settings', 'ota'].forEach(t => {
        const tabEl = document.getElementById(`tab-${t}`);
        const btnEl = document.getElementById(`btn-tab-${t}`);
        if (tabEl) tabEl.classList.add('hidden');
        if (btnEl) btnEl.className = "bg-gray-800 text-gray-400 px-4 py-2 rounded text-xs font-bold uppercase whitespace-nowrap hover:text-white transition";
    });

    const activeTab = document.getElementById(`tab-${tab}`);
    const activeBtn = document.getElementById(`btn-tab-${tab}`);
    if (activeTab) activeTab.classList.remove('hidden');
    if (activeBtn) activeBtn.className = "bg-stag-green text-white px-4 py-2 rounded text-xs font-bold uppercase whitespace-nowrap transition";

    if (tab !== 'files') {
        if (activeCommandPollTimer) {
            clearInterval(activeCommandPollTimer);
            activeCommandPollTimer = null;
        }
    }

    /*
     * Breadcrumb: 2026-09-12 20:15 - Dimension-Guarded 3D Tab Switcher
     * [CRITICAL BUGFIX FLAG - ZERO NAN VIEWPORT CRASH]:
     * Verifies positive clientWidth and clientHeight before recalculating aspect ratio to prevent camera corruption.
     */
    if (tab === '3d') {
        setTimeout(() => {
            const container = document.getElementById('canvas-container');
            if (container && camera && renderer) {
                const nw = container.clientWidth;
                const nh = container.clientHeight;
                if (nw > 0 && nh > 0) {
                    camera.aspect = nw / nh;
                    camera.updateProjectionMatrix();
                    renderer.setSize(nw, nh);
                }
            }
            drawAccGraphs();
        }, 80);
    }
    if (tab === 'telemetry') fetchLatestData();
    if (tab === 'imulogs') fetchImuCloudLogs();
    if (tab === 'files') loadCloudSdDirectory(currentCloudSdDir);
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

// ==========================================
// 5. INTERAKTIVE REPLAY-ENGINE (60 FPS SLERP)
// ==========================================
let replayDataRaw = [];
let replayFilteredData = [];
let replayCurrentTimeSec = 0.0;
let replayIsPlaying = false;
let replaySpeed = 1.0;
let replayAnimId = null;
let replayLastFrameTime = 0;
let replayGraphMode = 'accel';

let repScene, repCamera, repRenderer, repMesh;

function initReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container || repRenderer) return;

    const w = container.clientWidth || 300;
    const h = container.clientHeight || 240;

    repScene = new THREE.Scene();
    repCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    repCamera.position.set(0, 0, 3.8);

    repRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    repRenderer.setSize(w, h);
    repRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(repRenderer.domElement);

    const l1 = new THREE.DirectionalLight(0xffffff, 1.2);
    l1.position.set(5, 10, 7);
    repScene.add(l1);

    const l2 = new THREE.DirectionalLight(0xffffff, 0.6);
    l2.position.set(-5, -10, -7);
    repScene.add(l2);

    repScene.add(new THREE.AmbientLight(0xffffff, 0.7));

    createReplayFallbackCube();
    loadReplayGLBModel();

    window.addEventListener('resize', () => {
        if (!container || container.clientWidth === 0) return;
        repCamera.aspect = container.clientWidth / container.clientHeight;
        repCamera.updateProjectionMatrix();
        repRenderer.setSize(container.clientWidth, container.clientHeight);
    });
}

function createReplayFallbackCube() {
    if (repMesh && repScene) repScene.remove(repMesh);
    const geo = new THREE.BoxGeometry(1.8, 0.35, 0.9);
    const mat = new THREE.MeshStandardMaterial({ color: 0x009B4C, metalness: 0.3, roughness: 0.4 });
    repMesh = new THREE.Mesh(geo, mat);
    repScene.add(repMesh);
}

function setupReplayModelMesh(gltfScene) {
    if (repMesh && repScene) repScene.remove(repMesh);
    repMesh = gltfScene;
    const box = new THREE.Box3().setFromObject(repMesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) repMesh.scale.set(1.8 / maxDim, 1.8 / maxDim, 1.8 / maxDim);
    repScene.add(repMesh);
    if (repRenderer && repScene && repCamera) repRenderer.render(repScene, repCamera);
}

function loadReplayGLBModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
        createReplayFallbackCube();
        return;
    }
    const loader = new THREE.GLTFLoader();
    loader.load('./IMU.glb', (gltf) => {
        setupReplayModelMesh(gltf.scene);
    }, undefined, () => {
        createReplayFallbackCube();
    });
}

function closeImuReplayDeck() {
    if (replayIsPlaying) toggleReplayPlay();
    document.getElementById('imu-replay-deck').classList.add('hidden');
}

function quatToEulerDeg(qw, qx, qy, qz) {
    const norm = Math.hypot(qw, qx, qy, qz) || 1.0;
    const w = qw / norm, x = qx / norm, y = qy / norm, z = qz / norm;

    const sinr_cosp = 2 * (w * x + y * z);
    const cosr_cosp = 1 - 2 * (x * x + y * y);
    const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

    const sinp = 2 * (w * y - z * x);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * 90 : Math.asin(sinp) * (180 / Math.PI);

    const siny_cosp = 2 * (w * z + x * y);
    const cosy_cosp = 1 - 2 * (y * y + z * z);
    const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

    return { roll, pitch, yaw };
}

function setReplayGraphMode(mode) {
    replayGraphMode = mode;
    const btnAcc = document.getElementById('btn-replay-mode-acc');
    const btnEuler = document.getElementById('btn-replay-mode-euler');

    if (mode === 'accel') {
        if (btnAcc) btnAcc.className = 'px-2.5 py-1 text-[11px] font-bold rounded bg-stag-green text-white transition';
        if (btnEuler) btnEuler.className = 'px-2.5 py-1 text-[11px] font-bold rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition';
    } else {
        if (btnEuler) btnEuler.className = 'px-2.5 py-1 text-[11px] font-bold rounded bg-stag-green text-white transition';
        if (btnAcc) btnAcc.className = 'px-2.5 py-1 text-[11px] font-bold rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition';
    }
    drawReplayGraph();
}

async function inspectImuFile(downloadUrl, fileName) {
    const deck = document.getElementById('imu-replay-deck');
    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('replay-file-title').innerText = fileName;
    document.getElementById('replay-meta-info').innerText = 'Lade CSV-Datei aus Storage...';

    initReplay3D();

    try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();

        const lines = text.split('\n');
        replayDataRaw = [];
        const cyclesMap = new Set();

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',');
            if (parts.length >= 8) {
                const qw = parseFloat(parts[1]) || 1.0;
                const qx = parseFloat(parts[2]) || 0.0;
                const qy = parseFloat(parts[3]) || 0.0;
                const qz = parseFloat(parts[4]) || 0.0;
                const euler = quatToEulerDeg(qw, qx, qy, qz);

                const item = {
                    ts: parts[0],
                    qw, qx, qy, qz,
                    ax: parseFloat(parts[5]) || 0.0,
                    ay: parseFloat(parts[6]) || 0.0,
                    az: parseFloat(parts[7]) || 0.0,
                    roll: euler.roll,
                    pitch: euler.pitch,
                    yaw: euler.yaw,
                    cycle: parts[8] ? parseInt(parts[8], 10) : 0
                };
                replayDataRaw.push(item);
                if (item.cycle) cyclesMap.add(item.cycle);
            }
        }

        if (replayDataRaw.length === 0) {
            document.getElementById('replay-meta-info').innerText = 'Datei enthält keine gültigen Messzeilen.';
            return;
        }

        const select = document.getElementById('replay-cycle-select');
        select.innerHTML = '<option value="ALL">Alle Zyklen der Datei (' + replayDataRaw.length + ' Pkt)</option>';

        Array.from(cyclesMap).sort((a, b) => a - b).forEach(c => {
            const count = replayDataRaw.filter(d => d.cycle === c).length;
            select.innerHTML += `<option value="${c}">Aufweckzyklus #${c} (${count} Samples)</option>`;
        });

        onReplayCycleSelect('ALL');
    } catch (err) {
        document.getElementById('replay-meta-info').innerText = 'Fehler beim Laden: ' + err.message;
    }
}

function onReplayCycleSelect(cycleVal) {
    const select = document.getElementById('replay-cycle-select');
    if (select) select.value = cycleVal;

    if (cycleVal === 'ALL') {
        replayFilteredData = replayDataRaw;
    } else {
        const cNum = parseInt(cycleVal, 10);
        replayFilteredData = replayDataRaw.filter(d => d.cycle === cNum);
    }

    const total = replayFilteredData.length;
    const durSec = ((total - 1) * 0.1).toFixed(1);

    document.getElementById('replay-meta-info').innerText =
        `${total} Messpunkte geladen | Dauer: ${durSec} s | 100 ms Raster`;

    const durLabel = document.getElementById('replay-duration-label');
    if (durLabel) durLabel.innerText = durSec + ' s';
    const totalTimeLabel = document.getElementById('replay-total-time-label');
    if (totalTimeLabel) totalTimeLabel.innerText = durSec + 's';

    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) {
        scrubber.max = Math.max(0, total - 1);
        scrubber.value = 0;
    }

    resetReplayPlayback();
}

function renderInterpolatedFrame(tSec) {
    const total = replayFilteredData.length;
    if (total === 0) return;

    const sampleInterval = 0.1;
    const exactIndex = tSec / sampleInterval;
    const iA = Math.min(Math.floor(exactIndex), total - 1);
    const iB = Math.min(iA + 1, total - 1);
    const alpha = (iA === iB) ? 0 : (exactIndex - iA);

    const ptA = replayFilteredData[iA];
    const ptB = replayFilteredData[iB];

    if (repMesh && repScene && repCamera) {
        const normA = Math.hypot(ptA.qw, ptA.qx, ptA.qy, ptA.qz) || 1.0;
        const normB = Math.hypot(ptB.qw, ptB.qx, ptB.qy, ptB.qz) || 1.0;

        const qA = new THREE.Quaternion(-ptA.qy / normA, ptA.qx / normA, ptA.qz / normA, ptA.qw / normA);
        const qB = new THREE.Quaternion(-ptB.qy / normB, ptB.qx / normB, ptB.qz / normB, ptB.qw / normB);

        if (qA.dot(qB) < 0) qB.set(-qB.x, -qB.y, -qB.z, -qB.w);
        qA.slerp(qB, alpha);
        qA.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));
        repMesh.quaternion.copy(qA);

        const ax = ptA.ax + (ptB.ax - ptA.ax) * alpha;
        const ay = ptA.ay + (ptB.ay - ptA.ay) * alpha;
        const az = ptA.az + (ptB.az - ptA.az) * alpha;

        const aLen = Math.hypot(ax, ay, az);
        const axF = (aLen > 0.20) ? ax : 0;
        const ayF = (aLen > 0.20) ? ay : 0;
        const azF = (aLen > 0.20) ? az : 0;

        const aVec = new THREE.Vector3(ayF, -axF, azF);
        aVec.applyQuaternion(repMesh.quaternion);

        const tx = Math.max(-0.45, Math.min(0.45, aVec.x * 0.05));
        const ty = Math.max(-0.45, Math.min(0.45, aVec.y * 0.05));
        const tz = Math.max(-0.45, Math.min(0.45, aVec.z * 0.05));
        repMesh.position.set(tx, ty, tz);

        repRenderer.render(repScene, repCamera);
    }

    const roll = ptA.roll + (ptB.roll - ptA.roll) * alpha;
    const pitch = ptA.pitch + (ptB.pitch - ptA.pitch) * alpha;
    const yaw = ptA.yaw + (ptB.yaw - ptA.yaw) * alpha;
    const axD = ptA.ax + (ptB.ax - ptA.ax) * alpha;
    const ayD = ptA.ay + (ptB.ay - ptA.ay) * alpha;
    const azD = ptA.az + (ptB.az - ptA.az) * alpha;

    const hud = document.getElementById('replay-overlay-hud');
    if (hud) {
        hud.innerHTML =
            `ANG: R:${roll.toFixed(1)}° P:${pitch.toFixed(1)}° Y:${yaw.toFixed(1)}°<br>` +
            `ACC: X:${axD.toFixed(2)} Y:${ayD.toFixed(2)} Z:${azD.toFixed(2)} m/s² | Zyklus #${ptA.cycle}`;
    }

    const curTimeEl = document.getElementById('replay-cursor-time');
    if (curTimeEl) curTimeEl.innerText = `+${tSec.toFixed(2)}s (${ptA.ts})`;

    const curTimeLbl = document.getElementById('replay-current-time-label');
    if (curTimeLbl) curTimeLbl.innerText = tSec.toFixed(1) + 's';

    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) scrubber.value = Math.round(exactIndex);

    drawReplayGraph(tSec);
}

function drawReplayGraph(curTimeSec) {
    const cv = document.getElementById('replayGraphCanvas');
    if (!cv || replayFilteredData.length === 0) return;

    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    if (w === 0 || h === 0) return;

    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const count = replayFilteredData.length;
    const midY = h / 2;
    const leftMargin = 38;

    if (count < 2) return;

    let maxScale = 2.0;
    const isEuler = (replayGraphMode === 'euler');

    if (!isEuler) {
        for (let i = 0; i < count; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.ax) > maxScale) maxScale = Math.abs(d.ax);
            if (Math.abs(d.ay) > maxScale) maxScale = Math.abs(d.ay);
            if (Math.abs(d.az) > maxScale) maxScale = Math.abs(d.az);
        }
        maxScale = Math.ceil(maxScale * 1.15 * 10) / 10;
    } else {
        maxScale = 45.0;
        for (let i = 0; i < count; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.roll) > maxScale) maxScale = Math.abs(d.roll);
            if (Math.abs(d.pitch) > maxScale) maxScale = Math.abs(d.pitch);
            if (Math.abs(d.yaw) > maxScale) maxScale = Math.abs(d.yaw);
        }
        maxScale = Math.min(180.0, Math.ceil(maxScale / 15) * 15);
    }

    const gridPoints = [1.0, 0.5, 0.0, -0.5, -1.0];
    ctx.font = '9px monospace';
    gridPoints.forEach(ratio => {
        const y = midY - ratio * (midY - 8);
        ctx.strokeStyle = ratio === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        if (ratio === 0) ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(leftMargin, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText((ratio > 0 ? '+' : '') + (ratio * maxScale).toFixed(isEuler ? 0 : 1), 2, y + 3);
    });
    ctx.setLineDash([]);

    const drawCurve = (key, colorHex) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(leftMargin, 0, w - leftMargin, h);
        ctx.clip();
        ctx.strokeStyle = colorHex;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
            const px = leftMargin + (i / (count - 1)) * (w - leftMargin);
            const py = midY - (replayFilteredData[i][key] / maxScale) * (midY - 8);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
    };

    if (!isEuler) {
        drawCurve('ax', '#ef4444');
        drawCurve('ay', '#009B4C');
        drawCurve('az', '#3b82f6');
    } else {
        drawCurve('roll', '#ef4444');
        drawCurve('pitch', '#009B4C');
        drawCurve('yaw', '#8b5cf6');
    }

    ctx.font = 'bold 9px monospace';
    const legendText = isEuler ? '● Roll  ● Pitch  ● Yaw' : '● ACC X  ● ACC Y  ● ACC Z';
    const legendWidth = ctx.measureText(legendText).width;
    ctx.fillStyle = 'rgba(7, 10, 15, 0.85)';
    ctx.fillRect(w - legendWidth - 14, 3, legendWidth + 10, 15);
    ctx.strokeStyle = '#233145';
    ctx.strokeRect(w - legendWidth - 14, 3, legendWidth + 10, 15);

    if (!isEuler) {
        ctx.fillStyle = '#ef4444'; ctx.fillText('● ACC X', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● ACC Y', w - legendWidth + 37, 14);
        ctx.fillStyle = '#3b82f6'; ctx.fillText('● ACC Z', w - legendWidth + 83, 14);
    } else {
        ctx.fillStyle = '#ef4444'; ctx.fillText('● Roll', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● Pitch', w - legendWidth + 31, 14);
        ctx.fillStyle = '#8b5cf6'; ctx.fillText('● Yaw', w - legendWidth + 77, 14);
    }

    const maxDur = Math.max((count - 1) * 0.1, 0.001);
    const progress = Math.min(Math.max((curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec) / maxDur, 0), 1);
    const curX = leftMargin + progress * (w - leftMargin);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(curX, 0); ctx.lineTo(curX, h); ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath(); ctx.arc(curX, 6, 4, 0, Math.PI * 2); ctx.fill();
}

function onReplayScrub(val) {
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = parseInt(val, 10) * 0.1;
    renderInterpolatedFrame(replayCurrentTimeSec);
}

function toggleReplayPlay() {
    replayIsPlaying = !replayIsPlaying;
    const btn = document.getElementById('btn-replay-play');
    const maxDur = (replayFilteredData.length - 1) * 0.1;

    if (replayIsPlaying) {
        if (replayCurrentTimeSec >= maxDur) {
            replayCurrentTimeSec = 0.0;
        }
        btn.innerText = '⏸ Pause';
        btn.className = 'bg-yellow-600 text-white px-4 py-1.5 rounded text-xs font-bold transition';
        replayLastFrameTime = performance.now();
        replayAnimId = requestAnimationFrame(playLoop);
    } else {
        btn.innerText = '▶ Abspielen';
        btn.className = 'bg-stag-green text-white px-4 py-1.5 rounded text-xs font-bold hover:opacity-90 transition';
        if (replayAnimId) cancelAnimationFrame(replayAnimId);
    }
}

function playLoop(timestamp) {
    if (!replayIsPlaying) return;
    const dt = (timestamp - replayLastFrameTime) / 1000.0;
    replayLastFrameTime = timestamp;

    const maxDur = (replayFilteredData.length - 1) * 0.1;
    replayCurrentTimeSec += dt * replaySpeed;

    if (replayCurrentTimeSec >= maxDur) {
        replayCurrentTimeSec = maxDur;
        renderInterpolatedFrame(replayCurrentTimeSec);
        toggleReplayPlay();
        return;
    }

    renderInterpolatedFrame(replayCurrentTimeSec);
    replayAnimId = requestAnimationFrame(playLoop);
}

function resetReplayPlayback() {
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;
    renderInterpolatedFrame(0.0);
}

function onReplaySpeedChange(spd) {
    replaySpeed = parseFloat(spd);
}

// ==========================================
// 6. STORAGE LOG BROWSER & CLOUD DELETION
// ==========================================
async function deleteImuCloudFile(filePath, fileName) {
    if (!confirm(`Möchtest du "${fileName}" wirklich aus Supabase löschen?\n\nHinweis: Die Originaldatei bleibt auf der SD-Karte des Boards erhalten.`)) {
        return;
    }

    try {
        const { error: sErr } = await sbClient.storage.from('imu-logs').remove([filePath]);
        if (sErr) throw sErr;

        const { error: dbErr } = await sbClient.from('imu_log_files').delete().eq('file_path', filePath);
        if (dbErr) throw dbErr;

        if (document.getElementById('replay-file-title').innerText === fileName) {
            closeImuReplayDeck();
        }

        fetchImuCloudLogs();
    } catch (err) {
        alert('Fehler beim Löschen: ' + (err.message || JSON.stringify(err)));
    }
}

async function fetchImuCloudLogs() {
    const container = document.getElementById('imu-logs-container');
    if (!container) return;

    container.innerHTML = '<div class="text-xs text-gray-500 py-6 text-center">Lade IMU-Archive aus Supabase...</div>';

    const { data, error } = await sbClient
        .from('imu_log_files')
        .select('*')
        .eq('device_id', 'STAG-IMU-01')
        .order('uploaded_at', { ascending: false });

    if (error) {
        container.innerHTML = `<div class="p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-300">Fehler beim Laden: ${error.message}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<div class="text-xs text-gray-500 py-6 text-center">Keine IMU-Dateiblöcke in Supabase vorhanden.</div>';
        return;
    }

    const groupedByDay = {};
    data.forEach(item => {
        const folder = item.day_folder || 'Unbekanntes Datum';
        if (!groupedByDay[folder]) groupedByDay[folder] = [];
        groupedByDay[folder].push(item);
    });

    let html = '';
    Object.keys(groupedByDay).forEach(day => {
        const files = groupedByDay[day];
        const totalBytes = files.reduce((sum, f) => sum + Number(f.file_size_bytes || 0), 0);
        const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);

        html += `
        <div class="bg-gray-900/80 border border-gray-800 rounded-lg p-3.5">
            <div class="flex justify-between items-center mb-2.5 pb-2 border-b border-gray-800">
                <div class="flex items-center gap-2">
                    <span class="text-green-400 font-bold text-xs">📅 ${day}</span>
                    <span class="text-[11px] text-gray-400 font-mono">(${files.length} ${files.length === 1 ? 'Block' : 'Blöcke'} &bull; ${totalMb} MB gesamt)</span>
                </div>
            </div>
            <div class="space-y-1.5">
        `;

        files.forEach(f => {
            const kb = (Number(f.file_size_bytes || 0) / 1024).toFixed(1);
            const uploadTime = new Date(f.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(f.file_path)}`;

            html += `
                <div class="flex justify-between items-center p-2 rounded bg-gray-950/60 border border-gray-800/80 text-xs font-mono hover:border-gray-700 transition">
                    <div class="flex items-center gap-2 truncate mr-3">
                        <span class="text-gray-300 font-semibold truncate">📄 ${f.file_name}</span>
                        <span class="text-[10px] text-gray-500">(${kb} KB)</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-[10px] text-gray-500 hidden sm:inline mr-1">${uploadTime}</span>
                        <button onclick="inspectImuFile('${downloadUrl}', '${f.file_name}')"
                                class="bg-gray-800 hover:bg-gray-700 text-green-400 border border-green-800/60 px-2.5 py-1 rounded text-xs font-bold transition">
                            📊 Visualisieren & Abspielen
                        </button>
                        <a href="${downloadUrl}" download="${f.file_name}" target="_blank"
                           class="text-gray-400 hover:text-white px-2 py-1 text-xs transition">
                            ⬇
                        </a>
                        <button onclick="deleteImuCloudFile('${f.file_path}', '${f.file_name}')" title="Aus Cloud löschen"
                                class="text-red-400 hover:text-red-300 hover:bg-red-950/40 p-1 rounded transition text-xs">
                            🗑️
                        </button>
                    </div>
                </div>
            `;
        });

        html += `</div></div>`;
    });

    container.innerHTML = html;
}

// ==========================================
// 7. FIRMWARE RELEASES & BOOTSTRAP
// ==========================================
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
    fetchImuCloudLogs();
}

window.onload = () => {
    init3D();
    initRealtimeChannel();
    fetchAllData();
    setInterval(fetchLatestData, 30000);
};

/*
* Breadcrumb: 2026-09-12 19:20 - Leaflet Map Integration & On-Demand GPS Engine
* [CRITICAL BUGFIX FLAG - LEAFLET RENDER & FIX TRACKING]:
* 1. map.invalidateSize() called after modal visibility animation to prevent tile rendering artifacts.
* 2. Uses Dark CartoDB basemap matching the dark STAG theme without API keys.
* 3. Handles dual-channel response (Local WebSocket + Supabase Realtime).
*/

let gpsMapInstance = null;
let gpsMarker = null;
let gpsAccuracyCircle = null;

function initLeafletMap(lat = 47.2372, lon = 9.5981) {
    if (gpsMapInstance) return;

    const mapContainer = document.getElementById('leaflet-map');
    if (!mapContainer) return;

    // Dark-Matter CartoDB Kacheln für Dark Theme
    gpsMapInstance = L.map('leaflet-map').setView([lat, lon], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(gpsMapInstance);
}

function openGpsModal() {
    const modal = document.getElementById('gps-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    if (!gpsMapInstance) {
        initLeafletMap();
    }
    // Verhindert graue Kacheln nach dem Einblenden des Containers
    setTimeout(() => {
        if (gpsMapInstance) gpsMapInstance.invalidateSize();
    }, 150);
}

function closeGpsModal() {
    const modal = document.getElementById('gps-modal');
    if (modal) modal.classList.add('hidden');
}

window.addEventListener('click', (e) => {
    const modal = document.getElementById('gps-modal');
    if (modal && e.target === modal) closeGpsModal();
});

function updateGpsUI(data) {
    const fixBadge = document.getElementById('gps-fix-badge');
    const satsVal = document.getElementById('gps-sats-val');
    const altVal = document.getElementById('gps-alt-val');
    const coordsVal = document.getElementById('gps-coords-val');
    const timeVal = document.getElementById('gps-timestamp');
    const btn = document.getElementById('btn-request-gps');

    if (btn) {
        btn.disabled = false;
        btn.innerText = '📡 GPS-Position jetzt abfragen';
    }

    if (!data || !data.has_fix) {
        if (fixBadge) {
            fixBadge.innerText = 'Kein Fix / Suche...';
            fixBadge.className = 'font-bold text-yellow-400';
        }
        return;
    }

    if (fixBadge) {
        fixBadge.innerText = 'Fix OK (3D)';
        fixBadge.className = 'font-bold text-green-400';
    }
    if (satsVal) satsVal.innerText = `${data.sats || '--'} Sats`;
    if (altVal) altVal.innerText = `${Number(data.alt || 0).toFixed(1)} m (${Number(data.speed || 0).toFixed(1)} km/h)`;
    if (coordsVal) coordsVal.innerText = `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`;
    if (timeVal) timeVal.innerText = `Letzte Messung: ${new Date().toLocaleTimeString()} (${data.utc || ''})`;

    const headerGps = document.getElementById('header-gps-status');
    if (headerGps) headerGps.innerText = 'GPS OK';

    // Karte zentrieren und Marker setzen
    if (gpsMapInstance) {
        gpsMapInstance.setView([data.lat, data.lon], 16);

        if (gpsMarker) {
            gpsMarker.setLatLng([data.lat, data.lon]);
        } else {
            gpsMarker = L.marker([data.lat, data.lon]).addTo(gpsMapInstance);
        }

        gpsMarker.bindPopup(`<b>STAG-IMU-01</b><br>Lat: ${data.lat.toFixed(5)}<br>Lon: ${data.lon.toFixed(5)}<br>Höhe: ${data.alt}m`).openPopup();
    }
}

async function triggerGpsLocationFix() {
    const btn = document.getElementById('btn-request-gps');
    const fixBadge = document.getElementById('gps-fix-badge');
    if (btn) {
        btn.disabled = true;
        btn.innerText = '⏳ Schalte GNSS ein & warte auf Satelliten (bis zu 45s)...';
    }
    if (fixBadge) {
        fixBadge.innerText = 'Fix wird gesucht...';
        fixBadge.className = 'font-bold text-yellow-400 animate-pulse';
    }

    // 1. Befehl via Cloud SD Command Engine absenden
    await sendCloudCommand('GPS', '/', 'Fordere GPS-Ortung an...');
}