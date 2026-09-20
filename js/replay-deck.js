/*
 * Breadcrumb: 2026-09-14 20:45 - Complete Unified Replay Deck Engine
 * [CRITICAL BUGFIX FLAG - FULL REPLAY ENGINE RESTORATION]:
 * 1. Restored missing 3D Viewport engine (initReplay3D, loadReplayGLBModel, setupReplayModelMesh).
 * 2. Restored CSV file inspector (inspectImuFile) and cycle selector (onReplayCycleSelect).
 * 3. Restored sub-sample SLERP frame interpolation (renderInterpolatedFrame).
 * 4. Region Drag-to-Zoom, Wheel Panning & 0.1x Slow-Mo integrated without function duplicates.
 * 5. Collapsible Daily Log Accordion and bulk controls fully functional.
 */

// Globaler Status für Replay-Deck
let replayDataRaw = [];
let replayFilteredData = [];
let replayCurrentTimeSec = 0.0;
let replayIsPlaying = false;
let replaySpeed = 1.0;
let replayAnimId = null;
let replayLastFrameTime = 0;
let replayGraphMode = 'accel';

// Zoom- und Interaktionsstatus
let replayZoomStartSec = 0.0;
let replayZoomEndSec = 0.0;
let isReplayZoomed = false;
let isSelectingZoom = false;
let selectStartX = 0;
let selectCurrentX = 0;
let canvasListenersAttached = false;

// Three.js Replay Instanzen
let repScene, repCamera, repRenderer, repMesh;

// ============================================================================
// 1. THREE.JS 3D VIEWPORT & MODELL-LADEN
// ============================================================================

function initReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container || repRenderer) return;

    const w = container.clientWidth || 300;
    const h = container.clientHeight || 240;

    repScene = new THREE.Scene();
    repScene.background = new THREE.Color(0xdbe2ea);
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
    const candidatePaths = ['./IMU.glb', 'IMU.glb', './model.glb', 'model.glb', '/IMU.glb'];

    function tryLoad(index) {
        if (index >= candidatePaths.length) {
            createReplayFallbackCube();
            return;
        }
        loader.load(
            candidatePaths[index],
            (gltf) => { setupReplayModelMesh(gltf.scene); },
            undefined,
            () => { tryLoad(index + 1); }
        );
    }
    tryLoad(0);
}

function closeImuReplayDeck() {
    if (replayIsPlaying) toggleReplayPlay();
    const deck = document.getElementById('imu-replay-deck');
    if (deck) deck.classList.add('hidden');
}

// ============================================================================
// 2. MATHEMATIK & REPLAY INSPEKTOR (DATEIEN ÖFFNEN)
// ============================================================================

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

    const activeClass = 'px-2.5 py-1 text-[11px] font-bold rounded bg-stag-green text-white transition shadow-sm';
    const inactiveClass = 'px-2.5 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 transition';

    if (mode === 'accel') {
        if (btnAcc) btnAcc.className = activeClass;
        if (btnEuler) btnEuler.className = inactiveClass;
    } else {
        if (btnEuler) btnEuler.className = activeClass;
        if (btnAcc) btnAcc.className = inactiveClass;
    }
    drawReplayGraph(replayCurrentTimeSec);
}

async function inspectImuFile(downloadUrl, fileName) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;
    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('replay-file-title').innerText = fileName;
    document.getElementById('replay-meta-info').innerText = 'Lade Datensätze aus Supabase Storage...';

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

    resetReplayZoom();
}

// ============================================================================
// 3. FRAME-INTERPOLATION & 3D RENDERING
// ============================================================================

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
    if (curTimeEl) {
        let localTime = ptA.ts;
        if (ptA.ts && ptA.ts.includes('T') && ptA.ts.endsWith('Z')) {
            const d = new Date(ptA.ts);
            if (!isNaN(d)) {
                // Konvertiert UTC zu lokaler Schweizer Zeit (HH:MM:SS.mmm)
                localTime = d.toLocaleTimeString('de-CH', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
            }
        }
        curTimeEl.innerText = `+${tSec.toFixed(2)}s (${localTime})`;
    }

    const curTimeLbl = document.getElementById('replay-current-time-label');
    if (curTimeLbl) curTimeLbl.innerText = tSec.toFixed(1) + 's';

    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) scrubber.value = Math.round(exactIndex);

    drawReplayGraph(tSec);
}

// ============================================================================
// 4. BEREICHS-ZOOM, PAN & INTERAKTIVES OSZILLOSKOP
// ============================================================================

function getTimeBounds() {
    const maxDur = Math.max((replayFilteredData.length - 1) * 0.1, 0.001);
    const tStart = isReplayZoomed ? replayZoomStartSec : 0.0;
    const tEnd = isReplayZoomed ? replayZoomEndSec : maxDur;
    return { tStart, tEnd, tSpan: Math.max(tEnd - tStart, 0.05), maxDur };
}

function timeToX(t, w, leftMargin) {
    const { tStart, tSpan } = getTimeBounds();
    const plotW = w - leftMargin;
    return leftMargin + ((t - tStart) / tSpan) * plotW;
}

function xToTime(x, w, leftMargin) {
    const { tStart, tEnd, tSpan } = getTimeBounds();
    const plotW = w - leftMargin;
    const clampedX = Math.max(leftMargin, Math.min(w, x));
    const ratio = (clampedX - leftMargin) / plotW;
    return Math.max(tStart, Math.min(tEnd, tStart + ratio * tSpan));
}

function setReplaySpeedPreset(spd) {
    replaySpeed = parseFloat(spd);
    [0.1, 0.25, 0.5, 1.0, 2.0].forEach(s => {
        const btn = document.getElementById(`btn-spd-${s}`);
        if (btn) {
            btn.className = (s === replaySpeed)
                ? 'px-2 py-1 text-[11px] font-bold rounded bg-stag-green text-white shadow-sm transition'
                : 'px-2 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition';
        }
    });
}

function resetReplayZoom() {
    isReplayZoomed = false;
    const { maxDur } = getTimeBounds();
    replayZoomStartSec = 0.0;
    replayZoomEndSec = maxDur;

    const btnReset = document.getElementById('btn-replay-reset-zoom');
    if (btnReset) btnReset.classList.add('hidden');

    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) {
        scrubber.min = 0;
        scrubber.max = Math.max(0, replayFilteredData.length - 1);
        scrubber.value = Math.round(replayCurrentTimeSec / 0.1);
    }

    renderInterpolatedFrame(replayCurrentTimeSec);
}

function attachCanvasInteraction() {
    const cv = document.getElementById('replayGraphCanvas');
    if (!cv || canvasListenersAttached) return;
    canvasListenersAttached = true;

    const leftMargin = 38;

    cv.addEventListener('mousedown', (e) => {
        const rect = cv.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        if (mouseX < leftMargin) return;

        isSelectingZoom = true;
        selectStartX = mouseX;
        selectCurrentX = mouseX;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isSelectingZoom) return;
        const cvNow = document.getElementById('replayGraphCanvas');
        if (!cvNow) return;
        const rect = cvNow.getBoundingClientRect();
        selectCurrentX = Math.max(leftMargin, Math.min(cvNow.clientWidth, e.clientX - rect.left));
        drawReplayGraph(replayCurrentTimeSec);
    });

    window.addEventListener('mouseup', (e) => {
        if (!isSelectingZoom) return;
        isSelectingZoom = false;

        const cvNow = document.getElementById('replayGraphCanvas');
        if (!cvNow) return;

        const dx = Math.abs(selectCurrentX - selectStartX);
        const w = cvNow.clientWidth;

        if (dx >= 15) {
            const t1 = xToTime(Math.min(selectStartX, selectCurrentX), w, leftMargin);
            const t2 = xToTime(Math.max(selectStartX, selectCurrentX), w, leftMargin);

            if (t2 - t1 >= 0.05) {
                replayZoomStartSec = t1;
                replayZoomEndSec = t2;
                isReplayZoomed = true;
                replayCurrentTimeSec = replayZoomStartSec;

                const btnReset = document.getElementById('btn-replay-reset-zoom');
                const spanLbl = document.getElementById('replay-zoom-span-label');
                if (btnReset) btnReset.classList.remove('hidden');
                if (spanLbl) spanLbl.innerText = `${(t2 - t1).toFixed(2)}s`;

                const scrubber = document.getElementById('replay-scrubber');
                if (scrubber) {
                    scrubber.min = Math.floor(t1 / 0.1);
                    scrubber.max = Math.ceil(t2 / 0.1);
                    scrubber.value = Math.round(t1 / 0.1);
                }

                renderInterpolatedFrame(replayCurrentTimeSec);
            }
        } else {
            const targetTime = xToTime(selectStartX, w, leftMargin);
            replayCurrentTimeSec = targetTime;
            renderInterpolatedFrame(replayCurrentTimeSec);
        }
    });

    cv.addEventListener('wheel', (e) => {
        if (!isReplayZoomed) return;
        e.preventDefault();

        const { maxDur, tSpan } = getTimeBounds();
        const panDeltaSec = (e.deltaY > 0 ? 1 : -1) * (tSpan * 0.15);

        let newStart = replayZoomStartSec + panDeltaSec;
        let newEnd = replayZoomEndSec + panDeltaSec;

        if (newStart < 0) {
            newEnd -= newStart;
            newStart = 0;
        }
        if (newEnd > maxDur) {
            newStart -= (newEnd - maxDur);
            newEnd = maxDur;
            if (newStart < 0) newStart = 0;
        }

        replayZoomStartSec = newStart;
        replayZoomEndSec = newEnd;

        if (replayCurrentTimeSec < replayZoomStartSec) replayCurrentTimeSec = replayZoomStartSec;
        if (replayCurrentTimeSec > replayZoomEndSec) replayCurrentTimeSec = replayZoomEndSec;

        renderInterpolatedFrame(replayCurrentTimeSec);
    }, { passive: false });
}

/*
 * Breadcrumb: 2026-09-20 07:45 - Highlighting & Threshold Grid Line Renderer
 * [CRITICAL BUGFIX FLAG - CANVAS THRESHOLD SHADING RESTORATION]:
 * 1. Integrated background red warning tint (rgba(239, 68, 68, 0.22)) for points exceeding replayAccThreshold.
 * 2. Renders dashed red reference lines at ±replayAccThreshold when threshold is active.
 * 3. Clips threshold highlights strictly within plot margins to prevent canvas bleed.
 */
function drawReplayGraph(curTimeSec) {
    const cv = document.getElementById('replayGraphCanvas');
    if (!cv || replayFilteredData.length === 0) return;

    attachCanvasInteraction();

    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    if (w === 0 || h === 0) return;

    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const count = replayFilteredData.length;
    const midY = h / 2;
    const leftMargin = 38;
    const plotW = w - leftMargin;

    if (count < 2) return;

    const { tStart, tEnd, tSpan } = getTimeBounds();

    let maxScale = 2.0;
    const isEuler = (replayGraphMode === 'euler');

    const startIndex = Math.max(0, Math.floor(tStart / 0.1) - 1);
    const endIndex = Math.min(count - 1, Math.ceil(tEnd / 0.1) + 1);

    if (!isEuler) {
        for (let i = startIndex; i <= endIndex; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.ax) > maxScale) maxScale = Math.abs(d.ax);
            if (Math.abs(d.ay) > maxScale) maxScale = Math.abs(d.ay);
            if (Math.abs(d.az) > maxScale) maxScale = Math.abs(d.az);
        }
        if (replayAccThreshold > 0 && replayAccThreshold > maxScale) {
            maxScale = replayAccThreshold * 1.1;
        }
        maxScale = Math.ceil(maxScale * 1.15 * 10) / 10;
    } else {
        maxScale = 45.0;
        for (let i = startIndex; i <= endIndex; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.roll) > maxScale) maxScale = Math.abs(d.roll);
            if (Math.abs(d.pitch) > maxScale) maxScale = Math.abs(d.pitch);
            if (Math.abs(d.yaw) > maxScale) maxScale = Math.abs(d.yaw);
        }
        maxScale = Math.min(180.0, Math.ceil(maxScale / 15) * 15);
    }

    // ========================================================================
    // 1. SCHWELLENWERT-HINTERGRUND (ROTE WARNZONEN BEI PEAKS)
    // ========================================================================
    if (replayAccThreshold > 0 && !isEuler) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(leftMargin, 0, plotW, h);
        ctx.clip();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';

        for (let i = startIndex; i <= endIndex; i++) {
            const d = replayFilteredData[i];
            const aLen = Math.hypot(d.ax, d.ay, d.az);

            if (aLen >= replayAccThreshold) {
                const t = i * 0.1;
                const px = timeToX(t, w, leftMargin);
                const stepW = Math.max(2, (0.1 / tSpan) * plotW);
                ctx.fillRect(px - stepW / 2, 0, stepW, h);
            }
        }
        ctx.restore();
    }

    // Amplituden-Raster
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

    // ========================================================================
    // 2. HORIZONTALE SCHWELLENWERT-GRENZLINIEN (± SCHWELLE)
    // ========================================================================
    if (replayAccThreshold > 0 && !isEuler && replayAccThreshold <= maxScale) {
        ctx.save();
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.75)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);

        const yPos = midY - (replayAccThreshold / maxScale) * (midY - 8);
        const yNeg = midY + (replayAccThreshold / maxScale) * (midY - 8);

        ctx.beginPath();
        ctx.moveTo(leftMargin, yPos); ctx.lineTo(w, yPos);
        ctx.moveTo(leftMargin, yNeg); ctx.lineTo(w, yNeg);
        ctx.stroke();

        ctx.fillStyle = '#dc2626';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`Schwelle ±${replayAccThreshold.toFixed(1)}`, leftMargin + 4, yPos - 3);
        ctx.restore();
    }

    // Zeitraster
    let timeStep = 1.0;
    if (tSpan <= 0.5) timeStep = 0.05;
    else if (tSpan <= 2.0) timeStep = 0.2;
    else if (tSpan <= 5.0) timeStep = 0.5;
    else if (tSpan <= 20.0) timeStep = 2.0;
    else timeStep = 5.0;

    const firstTick = Math.ceil(tStart / timeStep) * timeStep;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.fillStyle = '#94a3b8';

    for (let t = firstTick; t <= tEnd; t += timeStep) {
        const px = timeToX(t, w, leftMargin);
        if (px >= leftMargin && px <= w) {
            ctx.beginPath();
            ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
            ctx.fillText(`${t.toFixed(tSpan <= 1 ? 2 : 1)}s`, px + 2, h - 4);
        }
    }

    const drawCurve = (key, colorHex) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(leftMargin, 0, plotW, h);
        ctx.clip();
        ctx.strokeStyle = colorHex;
        ctx.lineWidth = 1.8;
        ctx.beginPath();

        let first = true;
        for (let i = startIndex; i <= endIndex; i++) {
            const t = i * 0.1;
            const px = timeToX(t, w, leftMargin);
            const py = midY - (replayFilteredData[i][key] / maxScale) * (midY - 8);
            if (first) { ctx.moveTo(px, py); first = false; }
            else { ctx.lineTo(px, py); }
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

    if (isSelectingZoom && Math.abs(selectCurrentX - selectStartX) > 2) {
        const xMin = Math.max(leftMargin, Math.min(selectStartX, selectCurrentX));
        const xMax = Math.min(w, Math.max(selectStartX, selectCurrentX));
        const selW = xMax - xMin;

        ctx.fillStyle = 'rgba(0, 155, 76, 0.16)';
        ctx.fillRect(xMin, 0, selW, h);
        ctx.strokeStyle = '#009B4C';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(xMin, 0, selW, h);

        const tSelA = xToTime(xMin, w, leftMargin);
        const tSelB = xToTime(xMax, w, leftMargin);
        ctx.fillStyle = '#009B4C';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`Δ ${(tSelB - tSelA).toFixed(2)}s`, xMin + 4, 18);
    }

    const curTime = (curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec);
    const curX = timeToX(curTime, w, leftMargin);

    if (curX >= leftMargin && curX <= w) {
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(curX, 0); ctx.lineTo(curX, h); ctx.stroke();
        ctx.fillStyle = '#d97706';
        ctx.beginPath(); ctx.arc(curX, 6, 4, 0, Math.PI * 2); ctx.fill();
    }
}

// ============================================================================
// 5. PLAYBACK CONTROLS (PLAY, PAUSE, RESET, SCRUB)
// ============================================================================

function onReplayScrub(val) {
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = parseInt(val, 10) * 0.1;
    renderInterpolatedFrame(replayCurrentTimeSec);
}

function toggleReplayPlay() {
    replayIsPlaying = !replayIsPlaying;
    const btn = document.getElementById('btn-replay-play');
    const { tStart, tEnd } = getTimeBounds();

    if (replayIsPlaying) {
        if (replayCurrentTimeSec >= tEnd) {
            replayCurrentTimeSec = tStart;
        }
        btn.innerText = '⏸ Pause';
        btn.className = 'bg-yellow-600 text-white px-4 py-1.5 rounded text-xs font-bold transition';
        replayLastFrameTime = performance.now();
        replayAnimId = requestAnimationFrame(playLoop);
    } else {
        btn.innerText = '▶ Abspielen';
        btn.className = 'bg-stag-green text-white px-4 py-1.5 rounded text-xs font-bold hover:opacity-90 shadow-sm transition';
        if (replayAnimId) cancelAnimationFrame(replayAnimId);
    }
}

function playLoop(timestamp) {
    if (!replayIsPlaying) return;
    const dt = (timestamp - replayLastFrameTime) / 1000.0;
    replayLastFrameTime = timestamp;

    const { tStart, tEnd } = getTimeBounds();
    replayCurrentTimeSec += dt * replaySpeed;

    if (replayCurrentTimeSec >= tEnd) {
        replayCurrentTimeSec = tStart;
    }

    renderInterpolatedFrame(replayCurrentTimeSec);
    replayAnimId = requestAnimationFrame(playLoop);
}

function resetReplayPlayback() {
    if (replayIsPlaying) toggleReplayPlay();
    const { tStart } = getTimeBounds();
    replayCurrentTimeSec = tStart;
    renderInterpolatedFrame(replayCurrentTimeSec);
}

function onReplaySpeedChange(spd) {
    replaySpeed = parseFloat(spd);
}

// ============================================================================
// WINDOW-EXPORTE FÜR DAS REPLAY-DECK (OHNE KALENDER-DOPPLUNG)
// ============================================================================
window.inspectImuFile = inspectImuFile;
window.closeImuReplayDeck = closeImuReplayDeck;
window.onReplayCycleSelect = onReplayCycleSelect;
window.onReplayScrub = onReplayScrub;
window.toggleReplayPlay = toggleReplayPlay;
window.resetReplayPlayback = resetReplayPlayback;
window.onReplaySpeedChange = onReplaySpeedChange;
window.setReplaySpeedPreset = setReplaySpeedPreset;
window.resetReplayZoom = resetReplayZoom;
window.setReplayGraphMode = setReplayGraphMode;

/*
 * Breadcrumb: 2026-09-20 07:30 - Multi-Chunk Day Aggregator Engine
 * [CRITICAL BUGFIX FLAG - DAY LOG CONCATENATION]:
 * 1. Fetches all CSV chunks of a single date in parallel via Promise.all.
 * 2. Merges CSV rows preserving sample order and normalizing wake cycles.
 * 3. Populates cycle selector with both full-day and single-cycle drilldowns.
 */
/*
 * Breadcrumb: 2026-09-20 07:45 - Robust Multi-Chunk Day Aggregator & Threshold Counter
 * [CRITICAL BUGFIX FLAG - DAY LOG CONCATENATION & PEAK COUNTER]:
 * 1. Resets active playback and current scrubber position before populating day data.
 * 2. Normalizes storage paths (strips leading slashes) and catches per-file HTTP errors.
 * 3. Builds detailed event options in cycle selector with timestamp and sample count.
 * 4. Counts live threshold exceedances in real-time when adjusting threshold slider.
 */
let replayAccThreshold = 0.0; // 0.0 = Deaktiviert

function setReplayThreshold(val) {
    replayAccThreshold = parseFloat(val) || 0.0;
    const lbl = document.getElementById('replay-threshold-val');

    let peakCount = 0;
    if (replayAccThreshold > 0 && replayFilteredData.length > 0) {
        for (let i = 0; i < replayFilteredData.length; i++) {
            const d = replayFilteredData[i];
            if (Math.hypot(d.ax, d.ay, d.az) >= replayAccThreshold) {
                peakCount++;
            }
        }
    }

    if (lbl) {
        if (replayAccThreshold > 0) {
            lbl.innerText = `${replayAccThreshold.toFixed(1)} m/s² (${peakCount} Pkt)`;
        } else {
            lbl.innerText = 'AUS';
        }
    }
    drawReplayGraph(replayCurrentTimeSec);
}
window.setReplayThreshold = setReplayThreshold;

async function inspectImuDayMerged(dateStr, dayFiles) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;

    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;

    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    if (!dayFiles || dayFiles.length === 0) {
        if (typeof currentDeviceFiles !== 'undefined') {
            dayFiles = currentDeviceFiles.filter(f => getFileDayKey(f) === dateStr);
        }
    }

    if (!dayFiles || dayFiles.length === 0) {
        document.getElementById('replay-meta-info').innerText = `Keine Chunks für ${dateStr} vorhanden.`;
        return;
    }

    document.getElementById('replay-file-title').innerText = `📅 Ganzer Tag: ${dateStr} (${dayFiles.length} Chunks)`;
    document.getElementById('replay-meta-info').innerText = `Lade ${dayFiles.length} Archive parallel aus Supabase Storage...`;

    initReplay3D();

    try {
        // Parallel alle Chunks des Tages abrufen mit isolierter Fehlerbehandlung
        const fetchPromises = dayFiles.map(async (f, idx) => {
            try {
                const cleanPath = f.file_path.startsWith('/') ? f.file_path.substring(1) : f.file_path;
                const url = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
                const r = await fetch(url);
                if (!r.ok) {
                    console.warn(`[MERGE] Chunk #${idx + 1} (${f.file_name}) HTTP ${r.status}`);
                    return { file: f, fileIdx: idx, text: null };
                }
                const text = await r.text();
                return { file: f, fileIdx: idx, text };
            } catch (err) {
                console.warn(`[MERGE] Netzwerkfehler bei ${f.file_name}:`, err);
                return { file: f, fileIdx: idx, text: null };
            }
        });

        const results = await Promise.all(fetchPromises);
        replayDataRaw = [];
        const chunkStats = [];

        results.forEach(({ file, fileIdx, text }) => {
            if (!text) return;

            const lines = text.split('\n');
            let samplesInChunk = 0;
            const cycleId = fileIdx + 1; // Eindeutige ID pro Weck-Chunk des Tages

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
                        cycle: cycleId,
                        fileIndex: fileIdx
                    };
                    replayDataRaw.push(item);
                    samplesInChunk++;
                }
            }

            if (samplesInChunk > 0) {
                const timeStr = file.uploaded_at
                    ? new Date(file.uploaded_at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
                    : `Chunk #${cycleId}`;
                chunkStats.push({ cycleId, timeStr, samplesInChunk, fileName: file.file_name });
            }
        });

        if (replayDataRaw.length === 0) {
            document.getElementById('replay-meta-info').innerText = 'Keine gültigen Messzeilen in den Tagesdateien gefunden.';
            return;
        }

        // Dropdown für Zyklen / Events befüllen
        const select = document.getElementById('replay-cycle-select');
        select.innerHTML = `<option value="ALL">Gesamter Tag (${replayDataRaw.length} Punkte, ${chunkStats.length} Events)</option>`;

        chunkStats.forEach(cs => {
            select.innerHTML += `<option value="${cs.cycleId}">Event #${cs.cycleId} (${cs.timeStr} Uhr - ${cs.samplesInChunk} Samples)</option>`;
        });

        onReplayCycleSelect('ALL');
    } catch (err) {
        console.error('[MERGE FEHLER]', err);
        document.getElementById('replay-meta-info').innerText = 'Fehler beim Laden: ' + err.message;
    }
}
window.inspectImuDayMerged = inspectImuDayMerged;