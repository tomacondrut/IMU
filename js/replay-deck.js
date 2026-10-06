/*
 * Breadcrumb: 2026-10-05 20:30 - Live Tare Re-Calculation & Side-View OrbitControls
 * [CRITICAL BUGFIX FLAG - DYNAMIC ZERO & SMOOTH TILT REPLAY]:
 * 1. recalculateAllEuler() recomputes Roll/Pitch/Yaw across all raw data points on Tare.
 * 2. Removed broken invalidateReplayGraphCache reference; drawReplayGraph updates immediately.
 * 3. Restored resizeReplay3D() and window.resizeReplayDeck lifecycle hooks.
 * 4. 3D Model maps relative rotation when tared, starting level and pitching +42.5°.
 * 5. Window-scope camera view presets (iso, top, front, side, reset) with functional OrbitControls.
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
let replayAccThreshold = 0.0;

// Zoom- und Interaktionsstatus
let replayZoomStartSec = 0.0;
let replayZoomEndSec = 0.0;
let isReplayZoomed = false;
let isSelectingZoom = false;
let selectStartX = 0;
let selectCurrentX = 0;
let canvasListenersAttached = false;
let isDayMergedMode = false;

// Three.js Replay Instanzen
let repScene, repCamera, repRenderer, repMesh;
let repControls = null;
let repAnimId3D = null;
let repContainerObserver = null;

// Globales Tare-Quaternion (Standard: null = Rohdaten)
let replayTareQuat = null;

const imuMemoryCache = new Map();

async function fetchCachedCsv(url) {
    if (imuMemoryCache.has(url)) {
        return imuMemoryCache.get(url);
    }
    if ('caches' in window) {
        try {
            const cache = await caches.open('stag-imu-csv-cache-v1');
            const cachedResponse = await cache.match(url);
            if (cachedResponse) {
                const text = await cachedResponse.text();
                imuMemoryCache.set(url, text);
                return text;
            }
            const netResponse = await fetch(url);
            if (!netResponse.ok) throw new Error(`HTTP ${netResponse.status}`);
            await cache.put(url, netResponse.clone());
            const text = await netResponse.text();
            imuMemoryCache.set(url, text);
            return text;
        } catch (e) {
            console.warn('[CACHE] Cache API Fallback:', e);
        }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    imuMemoryCache.set(url, text);
    return text;
}

async function clearImuLogCache() {
    imuMemoryCache.clear();
    if ('caches' in window) {
        await caches.delete('stag-imu-csv-cache-v1');
    }
    console.log('[CACHE] Lokaler IMU-Log Cache geleert.');
}
window.clearImuLogCache = clearImuLogCache;

// ============================================================================
// 1. THREE.JS 3D VIEWPORT & MODELL-LADEN
// ============================================================================

function resizeReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container || !repRenderer || !repCamera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
        repCamera.aspect = w / h;
        repCamera.updateProjectionMatrix();
        repRenderer.setSize(w, h);
        if (repScene) repRenderer.render(repScene, repCamera);
    }
}

function resizeReplayDeck() {
    resizeReplay3D();
    drawReplayGraph(replayCurrentTimeSec);
}
window.resizeReplayDeck = resizeReplayDeck;

// Schnellauswahl der Kameraperspektive (inkl. Seitenansicht der Kippachse)
window.setReplayCameraView = function (viewName) {
    if (!repCamera) return;

    if (viewName === 'iso' || viewName === 'reset') {
        repCamera.position.set(2.4, 2.0, 2.8);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    } else if (viewName === 'top') {
        repCamera.position.set(0, 4.0, 0.001);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    } else if (viewName === 'front') {
        // Blick auf die Frontfläche des Rahmens
        repCamera.position.set(3.8, 0.3, 0);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    } else if (viewName === 'side') {
        // SEITENANSICHT: Blick direkt entlang der Dreh-/Kippachse (Z-Achse)
        // Zeigt die Hebel- und Kippbewegung der 90°-Montage perfekt im Profil!
        repCamera.position.set(0, 0.3, 3.8);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    }

    if (repControls) repControls.update();
    if (repRenderer && repScene && repCamera) {
        repRenderer.render(repScene, repCamera);
    }
};

function initReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container) return;
    if (typeof THREE === 'undefined') {
        console.warn('[REPLAY-3D] Three.js Bibliothek noch nicht geladen.');
        return;
    }

    if (repRenderer) {
        resizeReplay3D();
        return;
    }

    const w = container.clientWidth || 300;
    const h = container.clientHeight || 240;

    repScene = new THREE.Scene();
    repScene.background = new THREE.Color(0xdbe2ea);
    repCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    repCamera.position.set(2.4, 2.0, 2.8);
    repCamera.lookAt(0, 0, 0);

    repRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    repRenderer.setSize(w, h);
    repRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    repRenderer.setClearColor(0xdbe2ea, 1.0);
    container.appendChild(repRenderer.domElement);

    // 360° Maus- und Touch-Steuerung
    if (typeof THREE.OrbitControls !== 'undefined') {
        repControls = new THREE.OrbitControls(repCamera, repRenderer.domElement);
        repControls.enableDamping = true;
        repControls.dampingFactor = 0.08;
        repControls.target.set(0, 0, 0);
        repControls.maxDistance = 8.0;
        repControls.minDistance = 1.2;
    }

    const l1 = new THREE.DirectionalLight(0xffffff, 1.3);
    l1.position.set(5, 10, 7);
    repScene.add(l1);

    const l2 = new THREE.DirectionalLight(0xffffff, 0.7);
    l2.position.set(-5, -5, -3);
    repScene.add(l2);

    repScene.add(new THREE.AmbientLight(0xffffff, 0.85));

    // Bodengitter in der XZ-Ebene als Referenzebene
    const grid = new THREE.GridHelper(6, 12, 0x009B4C, 0xcbd5e1);
    grid.position.y = -0.5;
    repScene.add(grid);

    createReplayFallbackCube();
    loadReplayGLBModel();

    if (!repContainerObserver && window.ResizeObserver) {
        repContainerObserver = new ResizeObserver(() => {
            resizeReplay3D();
        });
        repContainerObserver.observe(container);
    }

    window.addEventListener('resize', resizeReplay3D);

    function animateReplay3D() {
        repAnimId3D = requestAnimationFrame(animateReplay3D);
        const cont = document.getElementById('replay-canvas-container');
        if (!cont || cont.clientWidth === 0) return;
        if (repControls) repControls.update();
        if (repRenderer && repScene && repCamera) {
            repRenderer.render(repScene, repCamera);
        }
    }
    animateReplay3D();
}

function createReplayFallbackCube() {
    if (repMesh && repScene) repScene.remove(repMesh);
    const group = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(1.8, 0.42, 0.95);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.2, roughness: 0.5 });
    group.add(new THREE.Mesh(bodyGeo, bodyMat));

    const topGeo = new THREE.BoxGeometry(1.68, 0.04, 0.82);
    const topMat = new THREE.MeshStandardMaterial({ color: 0x009B4C, metalness: 0.3, roughness: 0.3 });
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.y = 0.21;
    group.add(topMesh);

    const frontGeo = new THREE.BoxGeometry(0.5, 0.08, 0.04);
    const frontMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0 });
    const frontMesh = new THREE.Mesh(frontGeo, frontMat);
    frontMesh.position.set(0, 0.1, 0.48);
    group.add(frontMesh);

    repMesh = group;
    repScene.add(repMesh);
}

function setupReplayModelMesh(gltfScene) {
    if (repMesh && repScene) repScene.remove(repMesh);

    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    gltfScene.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.side = THREE.DoubleSide;
        }
    });

    const group = new THREE.Group();
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        gltfScene.scale.set(s, s, s);
        gltfScene.position.set(-center.x * s, -center.y * s, -center.z * s);
    }
    group.add(gltfScene);

    repMesh = group;
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
    if (repAnimId3D) {
        cancelAnimationFrame(repAnimId3D);
        repAnimId3D = null;
    }
    isDayMergedMode = false;
    replayCurrentTimeSec = 0.0;
    const deck = document.getElementById('imu-replay-deck');
    if (deck) deck.classList.add('hidden');
}

// ============================================================================
// 2. MATHEMATIK, TARE & REPLAY INSPEKTOR
// ============================================================================

function quatToEulerDeg(qw, qx, qy, qz) {
    let w = qw, x = qx, y = qy, z = qz;

    // Relative Drehung berechnen falls Nulllage aktiv: q_rel = q_tare^-1 * q_raw
    if (replayTareQuat) {
        const tw = replayTareQuat.w, tx = replayTareQuat.x, ty = replayTareQuat.y, tz = replayTareQuat.z;
        w = tw * qw + tx * qx + ty * qy + tz * qz;
        x = tw * qx - tx * qw - ty * qz + tz * qy;
        y = tw * qy + tx * qz - ty * qw - tz * qx;
        z = tw * qz - tx * qy + ty * qx - tz * qw;
    }

    const norm = Math.hypot(w, x, y, z) || 1.0;
    const nw = w / norm, nx = x / norm, ny = y / norm, nz = z / norm;

    const sinr_cosp = 2 * (nw * nx + ny * nz);
    const cosr_cosp = 1 - 2 * (nx * nx + ny * ny);
    const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

    const sinp = 2 * (nw * ny - nz * nx);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * 90 : Math.asin(Math.max(-1.0, Math.min(1.0, sinp))) * (180 / Math.PI);

    const siny_cosp = 2 * (nw * nz + nx * ny);
    const cosy_cosp = 1 - 2 * (ny * ny + nz * nz);
    const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

    return { roll, pitch, yaw };
}

// Berechnet alle Kurvenpunkte im RAM blitzschnell neu
function recalculateAllEuler() {
    for (let i = 0; i < replayDataRaw.length; i++) {
        const item = replayDataRaw[i];
        const e = quatToEulerDeg(item.qw, item.qx, item.qy, item.qz);
        item.roll = e.roll;
        item.pitch = e.pitch;
        item.yaw = e.yaw;
    }
}
/*
 * Breadcrumb: 2026-10-06 19:50 - Realtime Double-Integration for Displacement in mm
 * [CRITICAL BUGFIX FLAG - LEAKY INTEGRATION PREVENTS DRIFT]:
 * 1. DC-Offset-Bereinigung pro Messzyklus eliminiert statische Gravitationsvektoren.
 * 2. Trapezförmige doppelte Integration (a -> v -> s) mit Hochpass-Dämpfung (alpha 0.94).
 * 3. Skaliert Meter zu Millimeter (* 1000) für direkten mechanischen Vibrationsabgleich.
 */
/*
 * Breadcrumb: 2026-10-06 20:30 - Zero-Phase Bandpass Double-Integration for Dynamic Displacement (mm)
 * [CRITICAL BUGFIX FLAG - ELIMINATE 1/w^2 LOW-FREQ DRIFT]:
 * 1. Ersetzt den fehlerhaften Leaky-Integrator, der hochfrequente Vibrationen auslöschte.
 * 2. Zero-Phase Forward-Backward High-Pass (fc ~ 0.75 Hz) eliminiert DC-Offset und Kipp-Drifts restlos.
 * 3. Schwingweg bildet die Beschleunigungsspitzen phasensynchron in realistischen Millimetern (mm) ab.
 */
function calculateAllDisplacements() {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    const dt = 0.1; // 10 Hz Abtastrate
    // Highpass-Koeffizient fuer fc ~ 0.75 Hz bei fs = 10 Hz (alpha = 1 / (1 + 2*pi*fc*dt))
    const hpAlpha = 0.68;

    function zeroPhaseHighPass(arr) {
        const n = arr.length;
        if (n < 4) return new Float64Array(arr);

        // Vorwärtsdurchlauf
        const fwd = new Float64Array(n);
        fwd[0] = 0;
        for (let i = 1; i < n; i++) {
            fwd[i] = hpAlpha * (fwd[i - 1] + arr[i] - arr[i - 1]);
        }

        // Rückwärtsdurchlauf (hebt Phasenverschiebung exakt auf)
        const out = new Float64Array(n);
        out[n - 1] = fwd[n - 1];
        for (let i = n - 2; i >= 0; i--) {
            out[i] = hpAlpha * (out[i + 1] + fwd[i] - fwd[i + 1]);
        }
        return out;
    }

    let currentCycle = null;
    let cycleIndices = [];

    function processCycle(indices) {
        const n = indices.length;
        if (n === 0) return;

        ['ax', 'ay', 'az'].forEach(axisKey => {
            const dispKey = axisKey === 'ax' ? 'dx' : (axisKey === 'ay' ? 'dy' : 'dz');

            // 1. Rohbeschleunigung extrahieren und statischen Mittelwert abziehen
            const rawA = new Float64Array(n);
            let sumA = 0;
            for (let k = 0; k < n; k++) {
                const val = replayDataRaw[indices[k]][axisKey] || 0;
                rawA[k] = val;
                sumA += val;
            }
            const meanA = sumA / n;
            for (let k = 0; k < n; k++) rawA[k] -= meanA;

            // 2. Beschleunigung vorfiltern (Zero-Phase)
            const aFilt = zeroPhaseHighPass(rawA);

            // 3. Erste Integration: a -> v
            const v = new Float64Array(n);
            v[0] = 0;
            for (let k = 1; k < n; k++) {
                v[k] = v[k - 1] + 0.5 * (aFilt[k] + aFilt[k - 1]) * dt;
            }

            // 4. Geschwindigkeit filtern (eliminiert Integrationsdrifts)
            const vFilt = zeroPhaseHighPass(v);

            // 5. Zweite Integration: v -> s
            const s = new Float64Array(n);
            s[0] = 0;
            for (let k = 1; k < n; k++) {
                s[k] = s[k - 1] + 0.5 * (vFilt[k] + vFilt[k - 1]) * dt;
            }

            // 6. Weg filtern und in Millimeter (* 1000) skalieren
            const sFilt = zeroPhaseHighPass(s);

            for (let k = 0; k < n; k++) {
                replayDataRaw[indices[k]][dispKey] = sFilt[k] * 1000.0;
            }
        });
    }

    for (let i = 0; i < replayDataRaw.length; i++) {
        const c = replayDataRaw[i].cycle || 0;
        if (currentCycle === null || c !== currentCycle) {
            if (cycleIndices.length > 0) processCycle(cycleIndices);
            currentCycle = c;
            cycleIndices = [i];
        } else {
            cycleIndices.push(i);
        }
    }
    if (cycleIndices.length > 0) processCycle(cycleIndices);
}


function setReplayTareCurrentFrame() {
    if (!replayFilteredData || replayFilteredData.length === 0) return;

    const sampleInterval = 0.1;
    const exactIndex = Math.min(Math.floor(replayCurrentTimeSec / sampleInterval), replayFilteredData.length - 1);
    const pt = replayFilteredData[exactIndex];

    const norm = Math.hypot(pt.qw, pt.qx, pt.qy, pt.qz) || 1.0;
    replayTareQuat = {
        w: pt.qw / norm,
        x: pt.qx / norm,
        y: pt.qy / norm,
        z: pt.qz / norm
    };

    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    localStorage.setItem(`stag_tare_${devId}`, JSON.stringify(replayTareQuat));

    recalculateAllEuler();
    updateTareUI(true);
    drawReplayGraph(replayCurrentTimeSec);
    renderInterpolatedFrame(replayCurrentTimeSec);
}

function resetReplayTare() {
    replayTareQuat = null;
    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    localStorage.removeItem(`stag_tare_${devId}`);

    recalculateAllEuler();
    updateTareUI(false);
    drawReplayGraph(replayCurrentTimeSec);
    renderInterpolatedFrame(replayCurrentTimeSec);
}

function updateTareUI(isTared) {
    const btnSet = document.getElementById('btn-replay-tare');
    const btnReset = document.getElementById('btn-replay-tare-reset');
    if (btnSet) {
        btnSet.className = isTared
            ? 'px-2.5 py-1 text-[11px] font-bold rounded bg-emerald-600 text-white transition'
            : 'px-2.5 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 transition flex items-center gap-1';
        btnSet.innerText = isTared ? '✓ Genullt' : '🎯 Nulllage hier setzen';
    }
    if (btnReset) {
        btnReset.classList.toggle('hidden', !isTared);
    }
}

function checkAndApplySavedTare() {
    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    const saved = localStorage.getItem(`stag_tare_${devId}`);
    if (saved) {
        try {
            replayTareQuat = JSON.parse(saved);
            recalculateAllEuler();
            updateTareUI(true);
            return;
        } catch (e) {
            replayTareQuat = null;
        }
    }
    replayTareQuat = null;
    updateTareUI(false);
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

function formatReplayTimestamp(tsStr, withSec = true) {
    if (!tsStr) return '';
    const d = new Date(tsStr);
    if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString('de-CH', {
            hour: '2-digit',
            minute: '2-digit',
            ...(withSec ? { second: '2-digit' } : {})
        });
    }
    const m = String(tsStr).match(/(\d{2}:\d{2}(?::\d{2})?)/);
    return m ? m[1] : String(tsStr);
}

/*
 * Breadcrumb: 2026-10-06 20:00 - Performance Fix: Bulk Calculation Outside CSV Parse Loop
 * [CRITICAL BUGFIX FLAG - ELIMINATE O(N^2) PARSE FREEZE]:
 * 1. recalculateAllEuler() and calculateAllDisplacements() moved strictly after loop completion.
 * 2. Prevents catastrophic main-thread locking on multi-thousand line telemetry files.
 */
async function inspectImuFile(downloadUrl, fileName) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;

    isDayMergedMode = false;
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;

    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('replay-file-title').innerText = fileName;
    document.getElementById('replay-meta-info').innerText = 'Lade Daten (Cache / Cloud)...';

    initReplay3D();

    try {
        const text = await fetchCachedCsv(downloadUrl);
        const lines = text.split('\n');
        replayDataRaw = [];
        const cyclesMap = new Set();

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const sep = line.includes(';') ? ';' : ',';
            const parts = line.split(sep);
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

        // [WICHTIG]: Erst nach vollständigem Einlesen genau EINMAL im RAM durchrechnen!
        recalculateAllEuler();
        calculateAllDisplacements();

        const select = document.getElementById('replay-cycle-select');
        select.innerHTML = '<option value="ALL">Alle Zyklen der Datei (' + replayDataRaw.length + ' Pkt)</option>';

        Array.from(cyclesMap).sort((a, b) => a - b).forEach(c => {
            const cyclePts = replayDataRaw.filter(d => d.cycle === c);
            const count = cyclePts.length;
            const firstPt = cyclePts[0];
            const eventTime = (firstPt && firstPt.ts) ? formatReplayTimestamp(firstPt.ts) : '';
            const timeLabel = eventTime ? `${eventTime} Uhr - ` : '';
            select.innerHTML += `<option value="${c}">Aufweckzyklus #${c} (${timeLabel}${count} Samples)</option>`;
        });

        checkAndApplySavedTare();
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
    const durSec = total > 0 ? ((total - 1) * 0.1).toFixed(1) : "0.0";

    document.getElementById('replay-meta-info').innerText =
        `${total} Messpunkte geladen | Dauer: ${durSec} s | 100 ms Raster`;

    const durLabel = document.getElementById('replay-duration-label');
    if (durLabel) durLabel.innerText = durSec + ' s';
    const totalTimeLabel = document.getElementById('replay-total-time-label');
    if (totalTimeLabel) totalTimeLabel.innerText = durSec + 's';

    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;

    resetReplayZoom();
    if (replayAccThreshold > 0 && typeof setReplayThreshold === 'function') {
        setReplayThreshold(replayAccThreshold);
    }
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

    /*
 * 3D-MODELL: Echte, absolute Ausrichtung im Raum (KEIN Tare)
 * Zeigt das Gehäuse exakt in der realen 90°-Montage am Rahmen.
 */
    if (repMesh && repScene && repCamera) {
        const normA = Math.hypot(ptA.qw, ptA.qx, ptA.qy, ptA.qz) || 1.0;
        const normB = Math.hypot(ptB.qw, ptB.qx, ptB.qy, ptB.qz) || 1.0;

        // Absolute Sensordaten ohne Nulllagen-Offset:
        const qA = new THREE.Quaternion(-ptA.qy / normA, ptA.qx / normA, ptA.qz / normA, ptA.qw / normA);
        const qB = new THREE.Quaternion(-ptB.qy / normB, ptB.qx / normB, ptB.qz / normB, ptB.qw / normB);

        if (qA.dot(qB) < 0) qB.set(-qB.x, -qB.y, -qB.z, -qB.w);
        qA.slerp(qB, alpha);

        // Sensor-Offset in die Y-Up-Welt (Gehäuse steht bei 90° senkrecht im Raum)
        qA.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107)); // 90° Z
        qA.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)); // -90° X
        repMesh.quaternion.copy(qA);

        // Translationsauslenkung bei Vibration
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

    const dxD = ((ptA.dx || 0) + ((ptB.dx || 0) - (ptA.dx || 0)) * alpha);
    const dyD = ((ptA.dy || 0) + ((ptB.dy || 0) - (ptA.dy || 0)) * alpha);
    const dzD = ((ptA.dz || 0) + ((ptB.dz || 0) - (ptA.dz || 0)) * alpha);

    const hud = document.getElementById('replay-overlay-hud');
    if (hud) {
        hud.innerHTML =
            `ANG: R:${roll.toFixed(1)}° P:${pitch.toFixed(1)}° Y:${yaw.toFixed(1)}°<br>` +
            `ACC: X:${axD.toFixed(2)} Y:${ayD.toFixed(2)} Z:${azD.toFixed(2)} m/s²<br>` +
            `HUB: X:${dxD.toFixed(2)} Y:${dyD.toFixed(2)} Z:${dzD.toFixed(2)} mm | Zyklus #${ptA.cycle}`;
    }

    const curTimeEl = document.getElementById('replay-cursor-time');
    if (curTimeEl) {
        let localTime = ptA.ts;
        if (ptA.ts && ptA.ts.includes('T') && ptA.ts.endsWith('Z')) {
            const d = new Date(ptA.ts);
            if (!isNaN(d)) {
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

/*
 * Breadcrumb: 2026-10-06 19:50 - Multi-Canvas Synchronized Pointer & Zoom Engine
 * [CRITICAL BUGFIX FLAG - CROSS-TIER DRAG-TO-ZOOM]:
 * 1. Event-Listener auf allen drei Leinwänden (Acc, Euler, Disp) gebunden.
 * 2. Globaler Pointer-Release auf Window-Ebene gegen hängende Selektionsrahmen.
 * 3. Klick springt im Zeitstrahl; Wischgeste zoomt simultan auf allen 3 Achsen.
 */
function attachCanvasInteraction() {
    const canvases = [
        document.getElementById('replayGraphCanvasAcc'),
        document.getElementById('replayGraphCanvasEuler'),
        document.getElementById('replayGraphCanvasDisp')
    ].filter(Boolean);

    if (canvases.length === 0 || canvasListenersAttached) return;
    canvasListenersAttached = true;

    const leftMargin = 38;

    function getEventX(e, cv) {
        const rect = cv.getBoundingClientRect();
        const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
        return clientX - rect.left;
    }

    function handleStart(clientX) {
        if (clientX < leftMargin) return;
        isSelectingZoom = true;
        selectStartX = clientX;
        selectCurrentX = clientX;
    }

    function handleMove(clientX, w) {
        if (!isSelectingZoom) return;
        selectCurrentX = Math.max(leftMargin, Math.min(w, clientX));
        drawReplayGraph(replayCurrentTimeSec);
    }

    function handleEnd(w) {
        if (!isSelectingZoom) return;
        isSelectingZoom = false;

        const dx = Math.abs(selectCurrentX - selectStartX);
        if (dx >= 6) {
            const t1 = xToTime(Math.min(selectStartX, selectCurrentX), w, leftMargin);
            const t2 = xToTime(Math.max(selectStartX, selectCurrentX), w, leftMargin);

            if (t2 - t1 >= 0.02) {
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
    }

    canvases.forEach(cv => {
        cv.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            handleStart(getEventX(e, cv));
        });

        cv.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                e.preventDefault();
                handleStart(getEventX(e, cv));
            }
        }, { passive: false });

        cv.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (replayFilteredData.length === 0) return;
            if (replayIsPlaying) toggleReplayPlay();

            const { tStart, tEnd } = getTimeBounds();
            const direction = e.deltaY > 0 ? 1 : -1;
            const stepSec = 0.1;

            let newTime = replayCurrentTimeSec + (direction * stepSec);
            newTime = Math.max(tStart, Math.min(tEnd, Math.round(newTime * 10) / 10));

            replayCurrentTimeSec = newTime;
            renderInterpolatedFrame(replayCurrentTimeSec);
        }, { passive: false });
    });

    window.addEventListener('mousemove', (e) => {
        if (!isSelectingZoom) return;
        const refCv = canvases[0];
        if (!refCv) return;
        handleMove(getEventX(e, refCv), refCv.clientWidth);
    });

    window.addEventListener('mouseup', () => {
        if (!isSelectingZoom) return;
        const refCv = canvases[0];
        if (!refCv) return;
        handleEnd(refCv.clientWidth);
    });

    window.addEventListener('touchmove', (e) => {
        if (!isSelectingZoom || e.touches.length !== 1) return;
        const refCv = canvases[0];
        if (!refCv) return;
        handleMove(getEventX(e, refCv), refCv.clientWidth);
    }, { passive: false });

    window.addEventListener('touchend', () => {
        if (!isSelectingZoom) return;
        const refCv = canvases[0];
        if (!refCv) return;
        handleEnd(refCv.clientWidth);
    });
}

/*
 * Breadcrumb: 2026-10-06 19:50 - 3-Tier Synchronized Canvas Drawing & Adaptive Y-Scale
 * [OPTIMIZED Y-SCALING & SYNCED CURSORS]:
 * 1. Beschleunigung: Gestufte Rundung (0.5 bis 50 m/s²) mit Schwellenwert-Puffer.
 * 2. Winkel: Dynamisch an sichtbares Delta angepasst (2° bis 180°), kein starres 45°-Minimum mehr.
 * 3. Ausschlag: Sub-Millimeter- und Millimeter-Schritte (0.2 bis 100 mm) um Nulllinie.
 * 4. Durchgehender orangefarbener Zeit-Cursor und synchrones Drag-Overlay auf allen 3 Ebenen.
 */
/*
 * Breadcrumb: 2026-10-06 20:30 - Decoupled Y-Axis Layout & Synchronized Vibration Rendering
 * [CRITICAL BUGFIX FLAG - LAYOUT PARITY & ZERO-OVERLAP]:
 * 1. Dedizierter topMargin (18px) verhindert Überschneidung von Einheit und oberstem Skalenwert.
 * 2. Rechtsbündige Ausrichtung der Y-Werte (textAlign: right) mit 44px Achsenabstand.
 * 3. Eindeutige Einheitenangabe im Canvas und im Cursor-Badge (BESCHLEUNIGUNG [m/s²], WINKEL [°], SCHWINGWEG [mm]).
 * 4. Saubere Clipping-Begrenzung schützt Kopfzeile und Zeitraster vor Kurvenüberläufen.
 */
function getNiceScale(maxVal, minScale, steps) {
    const target = Math.max(minScale, maxVal * 1.18);
    for (let s of steps) {
        if (s >= target) return s;
    }
    return Math.ceil(target);
}

function drawReplayGraph(curTimeSec) {
    const cvAcc = document.getElementById('replayGraphCanvasAcc');
    const cvEuler = document.getElementById('replayGraphCanvasEuler');
    const cvDisp = document.getElementById('replayGraphCanvasDisp');
    if (!cvAcc || !cvEuler || !cvDisp || replayFilteredData.length === 0) return;

    attachCanvasInteraction();

    const count = replayFilteredData.length;
    if (count < 2) return;

    const { tStart, tEnd, tSpan } = getTimeBounds();
    const startIndex = Math.max(0, Math.floor(tStart / 0.1) - 1);
    const endIndex = Math.min(count - 1, Math.ceil(tEnd / 0.1) + 1);

    // 1. Skalenermittlung für den sichtbaren Zeitausschnitt
    let maxAcc = 0.1, maxAngle = 0.1, maxDisp = 0.05;
    for (let i = startIndex; i <= endIndex; i++) {
        const d = replayFilteredData[i];
        maxAcc = Math.max(maxAcc, Math.abs(d.ax), Math.abs(d.ay), Math.abs(d.az));
        maxAngle = Math.max(maxAngle, Math.abs(d.roll), Math.abs(d.pitch), Math.abs(d.yaw));
        maxDisp = Math.max(maxDisp, Math.abs(d.dx || 0), Math.abs(d.dy || 0), Math.abs(d.dz || 0));
    }
    if (replayAccThreshold > 0 && replayAccThreshold > maxAcc) {
        maxAcc = replayAccThreshold;
    }

    const scaleAcc = getNiceScale(maxAcc, 1.0, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0]);
    const scaleEuler = getNiceScale(maxAngle, 2.0, [2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180]);
    const scaleDisp = getNiceScale(maxDisp, 0.5, [0.5, 1.0, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0, 100.0]);

    const leftMargin = 44; // Genug Raum für 4-stellige Werte inkl. Vorzeichen
    const curTime = (curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec);
    const curExactIdx = Math.min(Math.floor(curTime / 0.1), count - 1);
    const curPt = replayFilteredData[Math.max(0, curExactIdx)] || replayFilteredData[0];

    function renderTier(cv, maxScale, unitLabel, curves, badgeTitle, isBottomTier, isAccTier) {
        const w = cv.width = cv.clientWidth;
        const h = cv.height = cv.clientHeight;
        if (w === 0 || h === 0) return;

        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        const topMargin = 18; // Verhindert Überlappung der Einheit mit der +1.0 Linie
        const bottomMargin = isBottomTier ? 16 : 8;
        const plotW = w - leftMargin;
        const plotH = h - topMargin - bottomMargin;
        const midY = topMargin + plotH / 2;
        const halfH = plotH / 2;

        // Schwellenwert-Hintergrund bei Peaks (nur Beschleunigung)
        if (isAccTier && replayAccThreshold > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(leftMargin, topMargin, plotW, plotH);
            ctx.clip();
            ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
            for (let i = startIndex; i <= endIndex; i++) {
                const d = replayFilteredData[i];
                if (Math.hypot(d.ax, d.ay, d.az) >= replayAccThreshold) {
                    const px = timeToX(i * 0.1, w, leftMargin);
                    const stepW = Math.max(2, (0.1 / tSpan) * plotW);
                    ctx.fillRect(px - stepW / 2, topMargin, stepW, plotH);
                }
            }
            ctx.restore();
        }

        // Horizontale Rasterlinien & Achsenwerte
        const gridPoints = [1.0, 0.5, 0.0, -0.5, -1.0];
        ctx.font = '9px monospace';
        gridPoints.forEach(ratio => {
            const y = midY - ratio * halfH;
            ctx.strokeStyle = ratio === 0 ? 'rgba(15, 23, 42, 0.25)' : 'rgba(15, 23, 42, 0.07)';
            ctx.lineWidth = 1;
            if (ratio === 0) ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(leftMargin, y); ctx.lineTo(w, y); ctx.stroke();

            ctx.fillStyle = '#64748b';
            const val = ratio * maxScale;
            const str = (ratio > 0 ? '+' : '') + (Number.isInteger(maxScale) ? val.toFixed(0) : val.toFixed(1));

            // Rechtsbündig mit klarem Abstand zur Diagrammkante
            ctx.textAlign = 'right';
            ctx.fillText(str, leftMargin - 6, y + 3);
            ctx.textAlign = 'left';
        });
        ctx.setLineDash([]);

        // Einheit sauber oberhalb der Skalenlinie platziert
        ctx.fillStyle = '#475569';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(unitLabel, 4, 12);

        // Schwellenwert-Grenzlinien
        if (isAccTier && replayAccThreshold > 0 && replayAccThreshold <= maxScale) {
            ctx.save();
            ctx.strokeStyle = 'rgba(220, 38, 38, 0.75)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 3]);
            const yPos = midY - (replayAccThreshold / maxScale) * halfH;
            const yNeg = midY + (replayAccThreshold / maxScale) * halfH;
            ctx.beginPath();
            ctx.moveTo(leftMargin, yPos); ctx.lineTo(w, yPos);
            ctx.moveTo(leftMargin, yNeg); ctx.lineTo(w, yNeg);
            ctx.stroke();
            ctx.fillStyle = '#dc2626';
            ctx.fillText(`±${replayAccThreshold.toFixed(1)}`, leftMargin + 4, yPos - 3);
            ctx.restore();
        }

        // Vertikale Zeitrasterlinien (Beschriftung nur im untersten Graphen)
        const minPixelPerTick = 75;
        const maxTicks = Math.max(2, Math.floor(plotW / minPixelPerTick));
        const rawStep = tSpan / maxTicks;
        const niceIntervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
        const timeStep = niceIntervals.find(s => s >= rawStep) || Math.ceil(rawStep / 60) * 60;
        const firstTick = Math.ceil(tStart / timeStep) * timeStep;

        ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
        ctx.fillStyle = '#94a3b8';

        let lastLabelX = -999;
        for (let t = firstTick; t <= tEnd; t += timeStep) {
            const px = timeToX(t, w, leftMargin);
            if (px >= leftMargin && px <= w) {
                ctx.beginPath();
                ctx.moveTo(px, topMargin); ctx.lineTo(px, h - bottomMargin);
                ctx.stroke();

                if (isBottomTier) {
                    let labelText = timeStep < 0.1 ? t.toFixed(2) + 's' : (timeStep < 1.0 ? t.toFixed(1) + 's' : Math.round(t) + 's');
                    const textWidth = ctx.measureText(labelText).width;
                    if (px - lastLabelX >= textWidth + 10 && (px + textWidth) <= (w - 35)) {
                        ctx.fillText(labelText, px + 2, h - 4);
                        lastLabelX = px;
                    }
                }
            }
        }

        // Signalverläufe zeichnen (mit Clipping auf Plotbereich)
        curves.forEach(({ key, color }) => {
            ctx.save();
            ctx.beginPath();
            ctx.rect(leftMargin, topMargin, plotW, plotH);
            ctx.clip();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.8;
            ctx.beginPath();

            let first = true;
            for (let i = startIndex; i <= endIndex; i++) {
                const px = timeToX(i * 0.1, w, leftMargin);
                const py = midY - ((replayFilteredData[i][key] || 0) / maxScale) * halfH;
                if (first) { ctx.moveTo(px, py); first = false; }
                else { ctx.lineTo(px, py); }
            }
            ctx.stroke();
            ctx.restore();
        });

        // Interaktiver Zoom-Auswahlrahmen
        if (isSelectingZoom && Math.abs(selectCurrentX - selectStartX) > 2) {
            const xMin = Math.max(leftMargin, Math.min(selectStartX, selectCurrentX));
            const xMax = Math.min(w, Math.max(selectStartX, selectCurrentX));
            const selW = xMax - xMin;

            ctx.fillStyle = 'rgba(0, 155, 76, 0.16)';
            ctx.fillRect(xMin, topMargin, selW, plotH);
            ctx.strokeStyle = '#009B4C';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(xMin, topMargin, selW, plotH);

            if (isBottomTier) {
                const tSelA = xToTime(xMin, w, leftMargin);
                const tSelB = xToTime(xMax, w, leftMargin);
                ctx.fillStyle = '#009B4C';
                ctx.font = 'bold 9px monospace';
                ctx.fillText(`Δ ${(tSelB - tSelA).toFixed(2)}s`, xMin + 4, topMargin + 14);
            }
        }

        // Synchroner Zeit-Cursor (orange)
        const curX = timeToX(curTime, w, leftMargin);
        if (curX >= leftMargin && curX <= w) {
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(curX, topMargin); ctx.lineTo(curX, h - bottomMargin); ctx.stroke();
            ctx.fillStyle = '#d97706';
            ctx.beginPath(); ctx.arc(curX, topMargin + 4, 3.5, 0, Math.PI * 2); ctx.fill();
        }

        // Kopf-Badge mit eindeutiger Einheit und Werten
        ctx.font = 'bold 9px monospace';
        let valInfo = curves.map(c => `${c.label}: ${(curPt[c.key] || 0).toFixed(c.dec || 2)}`).join('  ');
        let fullBadge = `${badgeTitle} [${unitLabel}] | ${valInfo}`;
        let badgeW = ctx.measureText(fullBadge).width;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.fillRect(w - badgeW - 14, 3, badgeW + 10, 15);
        ctx.strokeStyle = '#cbd5e1';
        ctx.strokeRect(w - badgeW - 14, 3, badgeW + 10, 15);

        let drawX = w - badgeW - 9;
        ctx.fillStyle = '#0f172a';
        ctx.fillText(`${badgeTitle} [${unitLabel}] | `, drawX, 14);
        drawX += ctx.measureText(`${badgeTitle} [${unitLabel}] | `).width;

        curves.forEach(c => {
            ctx.fillStyle = c.color;
            const textSeg = `${c.label}: ${(curPt[c.key] || 0).toFixed(c.dec || 2)}  `;
            ctx.fillText(textSeg, drawX, 14);
            drawX += ctx.measureText(textSeg).width;
        });
    }

    // 1. Kanal: Beschleunigung
    renderTier(cvAcc, scaleAcc, 'm/s²', [
        { key: 'ax', color: '#dc2626', label: 'ACC X', dec: 2 },
        { key: 'ay', color: '#009B4C', label: 'ACC Y', dec: 2 },
        { key: 'az', color: '#2563eb', label: 'ACC Z', dec: 2 }
    ], 'BESCHLEUNIGUNG', false, true);

    // 2. Kanal: Neigungswinkel
    renderTier(cvEuler, scaleEuler, '°', [
        { key: 'roll', color: '#dc2626', label: 'Roll', dec: 1 },
        { key: 'pitch', color: '#009B4C', label: 'Pitch', dec: 1 },
        { key: 'yaw', color: '#7c3aed', label: 'Yaw', dec: 1 }
    ], 'WINKEL', false, false);

    // 3. Kanal: Dynamischer Schwingweg
    renderTier(cvDisp, scaleDisp, 'mm', [
        { key: 'dx', color: '#dc2626', label: 'X', dec: 2 },
        { key: 'dy', color: '#009B4C', label: 'Y', dec: 2 },
        { key: 'dz', color: '#2563eb', label: 'Z', dec: 2 }
    ], 'SCHWINGWEG', true, false);
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
            const countStr = peakCount >= 10000 ? `${(peakCount / 1000).toFixed(1)}k` : peakCount;
            lbl.innerText = `${replayAccThreshold.toFixed(1)} m/s² (${countStr} Pkt)`;
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

    isDayMergedMode = true;
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
    document.getElementById('replay-meta-info').innerText = `Lade ${dayFiles.length} Archive (Cache / Cloud)...`;

    initReplay3D();

    try {
        const fetchPromises = dayFiles.map(async (f, idx) => {
            try {
                const cleanPath = f.file_path.startsWith('/') ? f.file_path.substring(1) : f.file_path;
                const url = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
                const text = await fetchCachedCsv(url);
                return { file: f, fileIdx: idx, text };
            } catch (err) {
                console.warn(`[CACHE MERGE] Fehler bei ${f.file_name}:`, err);
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
            const cycleId = fileIdx + 1;
            let firstTs = null;

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const sep = line.includes(';') ? ';' : ',';
                const parts = line.split(sep);
                if (parts.length >= 8) {
                    if (!firstTs && parts[0]) {
                        firstTs = parts[0].trim();
                    }

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
                const eventTime = formatReplayTimestamp(firstTs);
                const timeStr = eventTime || (file.uploaded_at
                    ? formatReplayTimestamp(file.uploaded_at)
                    : `Chunk #${cycleId}`);
                chunkStats.push({ cycleId, timeStr, samplesInChunk, fileName: file.file_name });
            }
        });

        if (replayDataRaw.length === 0) {
            document.getElementById('replay-meta-info').innerText = 'Keine gültigen Messzeilen in den Tagesdateien gefunden.';
            return;
        }

        // [NEU]: Displacement auch für zusammengeführte Tagesdateien ermitteln
        calculateAllDisplacements();

        const select = document.getElementById('replay-cycle-select');
        select.innerHTML = `<option value="ALL">Gesamter Tag (${replayDataRaw.length} Punkte, ${chunkStats.length} Events)</option>`;

        chunkStats.forEach(cs => {
            select.innerHTML += `<option value="${cs.cycleId}">Event #${cs.cycleId} (${cs.timeStr} Uhr - ${cs.samplesInChunk} Samples)</option>`;
        });

        checkAndApplySavedTare();
        onReplayCycleSelect('ALL');
    } catch (err) {
        console.error('[CACHE MERGE FEHLER]', err);
        document.getElementById('replay-meta-info').innerText = 'Fehler beim Laden: ' + err.message;
    }
}
window.inspectImuDayMerged = inspectImuDayMerged;

function exportReplayVisibleCsv() {
    if (!replayFilteredData || replayFilteredData.length === 0) {
        alert('Keine Messdaten im Oszilloskop zum Exportieren vorhanden.');
        return;
    }

    const { tStart, tEnd } = getTimeBounds();
    let exportRows = [];

    if (isReplayZoomed) {
        const startIdx = Math.max(0, Math.floor(tStart / 0.1));
        const endIdx = Math.min(replayFilteredData.length - 1, Math.ceil(tEnd / 0.1));
        exportRows = replayFilteredData.slice(startIdx, endIdx + 1);
    } else {
        exportRows = replayFilteredData;
    }

    if (exportRows.length === 0) {
        alert('Keine Datenpunkte im gewählten Bereich gefunden.');
        return;
    }

    const header = 'timestamp,qw,qx,qy,qz,ax,ay,az,cycle\n';
    const csvContent = header + exportRows.map(r =>
        `${r.ts},${r.qw.toFixed(4)},${r.qx.toFixed(4)},${r.qy.toFixed(4)},${r.qz.toFixed(4)},${r.ax.toFixed(3)},${r.ay.toFixed(3)},${r.az.toFixed(3)},${r.cycle}`
    ).join('\n');

    const titleEl = document.getElementById('replay-file-title');
    let baseName = titleEl ? titleEl.innerText.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'IMU_Export';
    if (baseName.endsWith('.csv')) baseName = baseName.replace('.csv', '');

    const rangeSuffix = isReplayZoomed
        ? `_zoom_${tStart.toFixed(1)}s-${tEnd.toFixed(1)}s`
        : '_full';
    const targetFilename = `${baseName}${rangeSuffix}.csv`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = targetFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.appendTerminalLog) {
        window.appendTerminalLog(`[EXPORT] ${exportRows.length} Messpunkte erfolgreich als "${targetFilename}" exportiert.`);
    }
}
window.exportReplayVisibleCsv = exportReplayVisibleCsv;

// Window Exporte
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
window.setReplayCameraView = setReplayCameraView;
window.setReplayTareCurrentFrame = setReplayTareCurrentFrame;
window.resetReplayTare = resetReplayTare;