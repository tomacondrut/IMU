/*
 * Breadcrumb: 2026-09-13 09:35 - Interactive IMU Storage Browser & Replay Deck
 * [CRITICAL BUGFIX FLAG - MULTI-DEVICE STORAGE & 60 FPS REPLAY]:
 * 1. fetchImuCloudLogs() filters chunks strictly by selectedDeviceId.
 * 2. Dedicated Three.js canvas instance isolated from live viewport to prevent context thrashing.
 * 3. Sub-sample SLERP interpolation across 100ms CSV records with scrubbable timeline.
 * 4. Dual-mode curve visualizer: 3-axis Linear Acceleration vs. 3D Euler Angles (Roll, Pitch, Yaw).
 */

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
    repScene.background = new THREE.Color(0xe2e8f0);
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
    const deck = document.getElementById('imu-replay-deck');
    if (deck) deck.classList.add('hidden');
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

/*
 * Breadcrumb: 2026-09-13 10:00 - Light Theme Replay Graph & Storage Browser
 * [CRITICAL BUGFIX FLAG - REPLAY CANVAS & FILE LIST]:
 * 1. Gridlines rendered in subtle dark alpha on white canvas.
 * 2. Legend and time markers adapted for bright backgrounds.
 * 3. File browser items rendered in clean slate-100 with distinct border lines.
 */

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
        ctx.strokeStyle = ratio === 0 ? 'rgba(15, 23, 42, 0.25)' : 'rgba(15, 23, 42, 0.07)';
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
        drawCurve('ax', '#dc2626');
        drawCurve('ay', '#009B4C');
        drawCurve('az', '#2563eb');
    } else {
        drawCurve('roll', '#dc2626');
        drawCurve('pitch', '#009B4C');
        drawCurve('yaw', '#7c3aed');
    }

    ctx.font = 'bold 9px monospace';
    const legendText = isEuler ? '● Roll  ● Pitch  ● Yaw' : '● ACC X  ● ACC Y  ● ACC Z';
    const legendWidth = ctx.measureText(legendText).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(w - legendWidth - 14, 3, legendWidth + 10, 15);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(w - legendWidth - 14, 3, legendWidth + 10, 15);

    if (!isEuler) {
        ctx.fillStyle = '#dc2626'; ctx.fillText('● ACC X', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● ACC Y', w - legendWidth + 37, 14);
        ctx.fillStyle = '#2563eb'; ctx.fillText('● ACC Z', w - legendWidth + 83, 14);
    } else {
        ctx.fillStyle = '#dc2626'; ctx.fillText('● Roll', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● Pitch', w - legendWidth + 31, 14);
        ctx.fillStyle = '#7c3aed'; ctx.fillText('● Yaw', w - legendWidth + 77, 14);
    }

    const maxDur = Math.max((count - 1) * 0.1, 0.001);
    const progress = Math.min(Math.max((curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec) / maxDur, 0), 1);
    const curX = leftMargin + progress * (w - leftMargin);

    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(curX, 0); ctx.lineTo(curX, h); ctx.stroke();
    ctx.fillStyle = '#d97706';
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

async function deleteImuCloudFile(filePath, fileName) {
    if (!confirm(`Möchtest du "${fileName}" (${selectedDeviceId}) wirklich aus Supabase löschen?\n\nHinweis: Die Originaldatei bleibt auf der SD-Karte des Boards erhalten.`)) {
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

    container.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">Lade IMU-Archive für ${selectedDeviceId}...</div>`;

    const { data, error } = await sbClient
        .from('imu_log_files')
        .select('*')
        .eq('device_id', selectedDeviceId)
        .order('uploaded_at', { ascending: false });

    if (error) {
        container.innerHTML = `<div class="p-3 bg-red-50 border border-red-300 rounded text-xs text-red-700">Fehler beim Laden: ${error.message}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">Keine IMU-Dateiblöcke für ${selectedDeviceId} vorhanden.</div>`;
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
        <div class="bg-slate-50 border border-slate-300 rounded-lg p-3.5 shadow-sm">
            <div class="flex justify-between items-center mb-2.5 pb-2 border-b border-slate-200">
                <div class="flex items-center gap-2">
                    <span class="text-green-700 font-bold text-xs">📅 ${day}</span>
                    <span class="text-[11px] text-slate-500 font-mono">(${files.length} ${files.length === 1 ? 'Block' : 'Blöcke'} &bull; ${totalMb} MB gesamt)</span>
                </div>
            </div>
            <div class="space-y-1.5">
        `;

        files.forEach(f => {
            const kb = (Number(f.file_size_bytes || 0) / 1024).toFixed(1);
            const uploadTime = new Date(f.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(f.file_path)}`;

            html += `
                <div class="flex justify-between items-center p-2 rounded bg-white border border-slate-200 text-xs font-mono hover:border-slate-400 transition shadow-sm">
                    <div class="flex items-center gap-2 truncate mr-3">
                        <span class="text-slate-800 font-semibold truncate">📄 ${f.file_name}</span>
                        <span class="text-[10px] text-slate-500">(${kb} KB)</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="text-[10px] text-slate-500 hidden sm:inline mr-1">${uploadTime}</span>
                        <button onclick="inspectImuFile('${downloadUrl}', '${f.file_name}')"
                                class="bg-slate-100 hover:bg-slate-200 text-green-700 border border-slate-300 px-2.5 py-1 rounded text-xs font-bold transition">
                            📊 Visualisieren
                        </button>
                        <a href="${downloadUrl}" download="${f.file_name}" target="_blank"
                           class="text-slate-600 hover:text-slate-900 px-2 py-1 text-xs transition">
                            ⬇
                        </a>
                        <button onclick="deleteImuCloudFile('${f.file_path}', '${f.file_name}')" title="Aus Cloud löschen"
                                class="text-red-600 hover:text-red-700 hover:bg-red-50 p-1 rounded transition text-xs">
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

window.fetchImuCloudLogs = fetchImuCloudLogs;