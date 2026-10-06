/*
 * Breadcrumbs & Versionshistorie:
 * - 2026-10-05 20:30: Live Tare Re-Calculation & Side-View OrbitControls (Tait-Bryan Analytik).
 * - 2026-10-06 19:50: Multi-Canvas Synchronized Pointer & Zoom Engine (Acc, Euler, Schwingweg mm).
 * - 2026-10-06 20:45: Selective Y-Scaling & Rendering für aktive Kurven (ax..az, roll..yaw, dx..dz).
 * - 2026-10-06 22:30: Shared GLB Cache für verzögerungsfreie 3D-Modellübernahme ins Einbaulagen-Modal.
 * - 2026-10-06 23:35: Konsolidierter Gesamtwurf:
 *   [CRITICAL BUGFIX & FEATURE PARITY - MOUNTING CONFIG & ZERO BASELINE]:
 *   1. Fehlende globale Instanzvariablen (mountRenderer, mountScene etc.) deklariert -> Behebt ReferenceError.
 *   2. Reines Quaternionen-Tare q_rel = q_mount^-1 * q_raw eliminiert Gimbal Lock und 180°-Sprünge.
 *   3. Volle Einbaulagen-Konfiguration aktiv: Modal mit Schiebereglern, 3D-Vorschau und "Aktuellen Frame übernehmen".
 *   4. Graphen starten am Kipprahmen exakt bei 0.0° und steigen beim Hub stufenlos auf +42.5° an.
 *   [DISMISSED]: sensorToModelQuat mit Euler('ZYX') erzeugte bei 90°-Annäherung Singularitätssprünge auf +137.9°.
 */

// ============================================================================
// GLOBALE STATUS- & INSTANZVARIABLEN
// ============================================================================

// Replay-Deck Daten- und Abspielstatus
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

// Three.js Replay Haupt-Viewport
let repScene, repCamera, repRenderer, repMesh;
let repControls = null;
let repAnimId3D = null;
let repContainerObserver = null;

// Three.js Einbaulagen-Modal Viewport (global deklariert gegen ReferenceErrors)
let mountScene = null, mountCamera = null, mountRenderer = null, mountMesh = null;
let mountControls = null;
let mountAnimId = null;
let mountContainerObserver = null;

// Geteilter GLTF-Rohspeicher (vermeidet HTTP-Neuabrufe beim Öffnen des Einbaulagen-Modals)
let rawGltfScene = null;

// Einbaulagen-Konfiguration & relatives Tare-Quaternion
let replayMountConfig = { roll: 0, pitch: 0, yaw: 0 };
let replayMountQuat = null;

// Lokaler Speicher-Cache für CSV-Logs
const imuMemoryCache = new Map();

// Sichtbarkeitsstatus der einzelnen Kurven
let replayVisibleCurves = {
    ax: true, ay: true, az: true,
    roll: true, pitch: true, yaw: true,
    dx: true, dy: true, dz: true
};

function toggleReplayCurve(key) {
    if (replayVisibleCurves.hasOwnProperty(key)) {
        replayVisibleCurves[key] = !replayVisibleCurves[key];
        updateCurveToggleUI();
        drawReplayGraph(replayCurrentTimeSec);
    }
}
window.toggleReplayCurve = toggleReplayCurve;

function updateCurveToggleUI() {
    const colorThemes = {
        ax: 'red', roll: 'red', dx: 'red',
        ay: 'emerald', pitch: 'emerald', dy: 'emerald',
        az: 'blue', dz: 'blue', yaw: 'purple'
    };

    Object.keys(replayVisibleCurves).forEach(key => {
        const btn = document.getElementById(`btn-filter-${key}`);
        if (!btn) return;
        const active = replayVisibleCurves[key];
        const theme = colorThemes[key] || 'slate';

        if (active) {
            btn.className = `px-2 py-0.5 rounded text-[10px] font-bold border transition bg-${theme}-50 text-${theme}-700 border-${theme}-300 shadow-xs`;
        } else {
            btn.className = 'px-2 py-0.5 rounded text-[10px] font-normal border transition bg-slate-100 text-slate-400 border-slate-200 line-through opacity-60';
        }
    });
}

async function fetchCachedCsv(url) {
    if (imuMemoryCache.has(url)) return imuMemoryCache.get(url);
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
    if ('caches' in window) await caches.delete('stag-imu-csv-cache-v1');
    console.log('[CACHE] Lokaler IMU-Log Cache geleert.');
}
window.clearImuLogCache = clearImuLogCache;

// ============================================================================
// 1. THREE.JS 3D VIEWPORT & MODELL-LADEN (HAUPTFENSTER)
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

/*
 * Breadcrumb: 2026-10-06 23:15 - Camera View Parity with live-3d.js
 * [CRITICAL BUGFIX FLAG - FRONT/SIDE PERSPECTIVE RESTORATION]:
 * 1. Synchronisiert Kamerapositionen exakt mit live-3d.js:
 *    - 'front': (0, 0.3, 3.8) blickt frontal auf die Gehäusefront (+Z / 0.48).
 *    - 'side':  (3.8, 0.3, 0) blickt seitlich auf die Gehäuselänge (+X / 1.8).
 * [DISMISSED]: Invertierte Front/Side-Werte führten zu verfälschter optischer Achsenwahrnehmung.
 */
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
        repCamera.position.set(0, 0.3, 3.8);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    } else if (viewName === 'side') {
        repCamera.position.set(3.8, 0.3, 0);
        repCamera.lookAt(0, 0, 0);
        if (repControls) repControls.target.set(0, 0, 0);
    }

    if (repControls) repControls.update();
    if (repRenderer && repScene && repCamera) repRenderer.render(repScene, repCamera);
};

function initReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container || typeof THREE === 'undefined') return;

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

    const grid = new THREE.GridHelper(6, 12, 0x009B4C, 0xcbd5e1);
    grid.position.y = -0.5;
    repScene.add(grid);

    createReplayFallbackCube();
    loadReplayGLBModel();

    if (!repContainerObserver && window.ResizeObserver) {
        repContainerObserver = new ResizeObserver(() => { resizeReplay3D(); });
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

/*
 * Breadcrumb: 2026-10-06 23:25 - Hardware-Aligned Axis Vectors & Color Mapping
 * [CRITICAL BUGFIX FLAG - CAD MODEL AXIS LABELING & MESH PARITY]:
 * 1. Behebt Achsenvertauschung am 3D-Körper:
 *    - Lokale X-Achse (1, 0, 0) ist die Kippachse (Pitch / Grün #009B4C).
 *    - Lokale Y-Achse (0, 1, 0) ist die Wankachse (Roll / Rot #dc2626).
 *    - Lokale Z-Achse (0, 0, 1) ist die Hochachse (Yaw / Blau #2563eb).
 * 2. Bringt 3D-Visualisierung in Einklang mit den Kurvenfarben und Schiebereglern.
 * [DISMISSED]: Statische X=Roll / Y=Pitch Zuweisung ignorierte den Leiterplatten-Offset.
 */
/*
 * Breadcrumb: 2026-10-06 23:30 - Standard Model Axes Restored
 * [CRITICAL BUGFIX FLAG - CAD MODEL LOCAL COORDINATES]:
 * 1. Pfeile fest an lokale Modellgeometrie gekoppelt:
 *    - X (1, 0, 0): Gehäuselängsachse / Roll (Rot #dc2626)
 *    - Y (0, 1, 0): Gehäusekippachse / Pitch (Grün #009B4C)
 *    - Z (0, 0, 1): Gehäusehochachse / Yaw (Blau #2563eb)
 * [DISMISSED]: Vertauschen der Beschriftungen an den Pfeilen umging die mathematische Ursache nur optisch.
 */
function attachImuAxes(targetGroup) {
    const old = targetGroup.getObjectByName('imuAxesGroup');
    if (old) targetGroup.remove(old);

    const axesGroup = new THREE.Group();
    axesGroup.name = 'imuAxesGroup';

    const len = 1.25;
    const headLen = 0.22;
    const headWidth = 0.12;

    const arrowX = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), len, 0xdc2626, headLen, headWidth);
    const arrowY = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), len, 0x009B4C, headLen, headWidth);
    const arrowZ = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), len, 0x2563eb, headLen, headWidth);

    axesGroup.add(arrowX);
    axesGroup.add(arrowY);
    axesGroup.add(arrowZ);

    function createAxisLabel(text, colorHex) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = colorHex;
        ctx.font = 'bold 26px monospace';
        ctx.fillText(text, 10, 42);
        const texture = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.85, 0.22, 1.0);
        return sprite;
    }

    const lblX = createAxisLabel('Roll (X)', '#dc2626');
    lblX.position.set(len + 0.25, 0, 0);
    axesGroup.add(lblX);

    const lblY = createAxisLabel('Pitch (Y)', '#009B4C');
    lblY.position.set(0, len + 0.25, 0);
    axesGroup.add(lblY);

    const lblZ = createAxisLabel('Yaw (Z)', '#2563eb');
    lblZ.position.set(0, 0, len + 0.25);
    axesGroup.add(lblZ);

    targetGroup.add(axesGroup);
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
    attachImuAxes(repMesh);
    repScene.add(repMesh);
}

/*
 * Breadcrumb: 2026-10-06 23:50 - ESP Captive Portal Parity: Native CAD Mesh Orientation
 * [CRITICAL BUGFIX & FEATURE PARITY - GLTF BASIS ALIGNMENT]:
 * 1. Entfernt 'gltfScene.rotation.x = -Math.PI / 2', das eine 90°-Vordrehung erzwang.
 * 2. Übernimmt die native Orientierung aus setupModelMesh() des ESP32-Dashboards.
 * [DISMISSED]: rotation.x = -Math.PI / 2 erforderte kompensierende Euler-Kippungen.
 */
function setupReplayModelMesh(gltfScene) {
    if (repMesh && repScene) repScene.remove(repMesh);
    if (!rawGltfScene) rawGltfScene = gltfScene.clone(true);

    gltfScene.traverse((child) => {
        if (child.isMesh && child.material) child.material.side = THREE.DoubleSide;
    });

    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    const group = new THREE.Group();
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        gltfScene.scale.set(s, s, s);
        gltfScene.position.set(-center.x * s, -center.y * s, -center.z * s);
    }
    group.add(gltfScene);

    repMesh = group;
    attachImuAxes(repMesh);
    repScene.add(repMesh);
    if (repRenderer && repScene && repCamera) repRenderer.render(repScene, repCamera);

    if (mountScene && (!mountMesh || mountMesh.name !== 'imuCadGroup')) {
        setupMountingModelMesh(rawGltfScene.clone(true));
    }
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
// 2. MATHEMATIK, SCHWINGWEG & EINBAULAGEN-TARE
// ============================================================================

function calculateAllDisplacements() {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    const dt = 0.1;
    const hpAlpha = 0.68; // Zero-Phase Hochpass fc ~ 0.75 Hz bei 10 Hz

    function zeroPhaseHighPass(arr) {
        const n = arr.length;
        if (n < 4) return new Float64Array(arr);

        const fwd = new Float64Array(n);
        fwd[0] = 0;
        for (let i = 1; i < n; i++) {
            fwd[i] = hpAlpha * (fwd[i - 1] + arr[i] - arr[i - 1]);
        }

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

            const rawA = new Float64Array(n);
            let sumA = 0;
            for (let k = 0; k < n; k++) {
                const val = replayDataRaw[indices[k]][axisKey] || 0;
                rawA[k] = val;
                sumA += val;
            }
            const meanA = sumA / n;
            for (let k = 0; k < n; k++) rawA[k] -= meanA;

            const aFilt = zeroPhaseHighPass(rawA);

            const v = new Float64Array(n);
            v[0] = 0;
            for (let k = 1; k < n; k++) {
                v[k] = v[k - 1] + 0.5 * (aFilt[k] + aFilt[k - 1]) * dt;
            }

            const vFilt = zeroPhaseHighPass(v);

            const s = new Float64Array(n);
            s[0] = 0;
            for (let k = 1; k < n; k++) {
                s[k] = s[k - 1] + 0.5 * (vFilt[k] + vFilt[k - 1]) * dt;
            }

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

/*
 * Breadcrumb: 2026-10-06 23:50 - Continuous Euler Unwrapping & Direct Quat Tare
 * [CRITICAL BUGFIX & FEATURE PARITY - ZERO JUMPS & DISCONTINUITY ELIMINATION]:
 * 1. Implementiert antipodale Vorzeichen-Kontinuität (q · q_prev >= 0) identisch zum ESP-Websocket.
 * 2. Relatives Tare q_rel = q_mount^-1 * q_raw eliminiert Singularitäten vollständig.
 * 3. Phasen-Unwrapping verhindert 360°-Sägezahnsprünge an den Schnittstellen (+180° / -180°).
 * 4. clamp(sinp, -1, 1) verhindert NaN-Ausrutscher bei exakten 90°-Zuständen.
 * [DISMISSED]: setFromEuler('ZYX') im Renderloop erzeugte Sprünge bei Annäherung an 90°.
 */


function computeRelativeQuat(qw, qx, qy, qz) {
    let w = qw, x = qx, y = qy, z = qz;

    // Relatives Quaternion: q_rel = q_mount^-1 * q_raw
    if (replayMountQuat) {
        const mw = replayMountQuat.w, mx = replayMountQuat.x, my = replayMountQuat.y, mz = replayMountQuat.z;
        w = mw * qw + mx * qx + my * qy + mz * qz;
        x = mw * qx - mx * qw - my * qz + mz * qy;
        y = mw * qy + mx * qz - my * qw - mz * qx;
        z = mw * qz - mx * qy + my * qx - mz * qw;
    }

    const norm = Math.hypot(w, x, y, z) || 1.0;
    return { w: w / norm, x: x / norm, y: y / norm, z: z / norm };
}

/*
 * Breadcrumb: 2026-10-06 23:30 - Sensor-to-Model Euler Angle Extraction
 * [CRITICAL BUGFIX FLAG - SENSOR AXIS ROTATION PARITY]:
 * 1. Berücksichtigt den BNO085-Hardware-Offset (-qy, qx, qz, qw):
 *    - x_model = -ny  -> Steuert die Roll-Analytik (Wanken um Gehäuselängsachse)
 *    - y_model = +nx  -> Steuert die Pitch-Analytik (Kippen am Rahmen)
 *    - z_model = +nz  -> Steuert die Yaw-Analytik (Gieren)
 * [DISMISSED]: Unverändertes Einsetzen von nx als Roll führte zur Vertauschung von Roll und Pitch im Graph und Tare.
 */
/*
 * Breadcrumb: 2026-10-06 23:45 - Standard Tait-Bryan Z-Y-X Euler Extraction
 * [CRITICAL BUGFIX FLAG - GIMBAL LOCK ELIMINATION]:
 * 1. Berechnet Roll (X), Pitch (Y) und Yaw (Z) direkt aus dem relativen Quaternion.
 * 2. q_rel = (1, 0, 0, 0) ergibt exakt 0.0° auf allen Achsen (Singularitaetsfreier Arbeitsbereich).
 * 3. Beseitigt das Einfrieren von Pitch bei 87.6° und die Roll/Yaw-Sprünge.
 */
function quatToEulerRawDeg(nw, nx, ny, nz) {
    const sinr_cosp = 2 * (nw * nx + ny * nz);
    const cosr_cosp = 1 - 2 * (nx * nx + ny * ny);
    const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

    const sinp = 2 * (nw * ny - nz * nx);
    const clampedSinp = Math.max(-1.0, Math.min(1.0, sinp));
    const pitch = Math.asin(clampedSinp) * (180 / Math.PI);

    const siny_cosp = 2 * (nw * nz + nx * ny);
    const cosy_cosp = 1 - 2 * (ny * ny + nz * nz);
    const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

    return { roll, pitch, yaw };
}

function unwrapAngle(current, previous) {
    let diff = current - previous;
    while (diff > 180) { current -= 360; diff -= 360; }
    while (diff < -180) { current += 360; diff += 360; }
    return current;
}

/*
 * Breadcrumb: 2026-10-06 23:55 - Cycle-Bounded Euler Unwrapping
 * [CRITICAL BUGFIX FLAG - MULTI-CYCLE BASELINE INTEGRITY]:
 * 1. Setzt prevRoll/Pitch/Yaw bei jedem Zykluswechsel (item.cycle) gezielt zurück.
 * 2. Verhindert das Verschleppen von 360°-Wicklungsphasen zwischen getrennten Hub-Events.
 */
function recalculateAllEuler() {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    let prevRoll = null, prevPitch = null, prevYaw = null;
    let prevRawRoll = null, prevRawPitch = null, prevRawYaw = null;
    let activeCycle = null;

    for (let i = 0; i < replayDataRaw.length; i++) {
        const item = replayDataRaw[i];

        // An Zyklus- bzw. Eventgrenzen Unwrapping-Gedächtnis zurücksetzen
        if (activeCycle === null || item.cycle !== activeCycle) {
            activeCycle = item.cycle;
            prevRoll = null; prevPitch = null; prevYaw = null;
            prevRawRoll = null; prevRawPitch = null; prevRawYaw = null;
        }

        // 1. Physische Rohwinkel berechnen
        const rNorm = Math.hypot(item.qw, item.qx, item.qy, item.qz) || 1.0;
        const rawE = quatToEulerRawDeg(item.qw / rNorm, item.qx / rNorm, item.qy / rNorm, item.qz / rNorm);

        if (prevRawRoll === null) {
            item.rawRoll = rawE.roll;
            item.rawPitch = rawE.pitch;
            item.rawYaw = rawE.yaw;
        } else {
            item.rawRoll = unwrapAngle(rawE.roll, prevRawRoll);
            item.rawPitch = unwrapAngle(rawE.pitch, prevRawPitch);
            item.rawYaw = unwrapAngle(rawE.yaw, prevRawYaw);
        }
        prevRawRoll = item.rawRoll;
        prevRawPitch = item.rawPitch;
        prevRawYaw = item.rawYaw;

        // 2. Relatives genulltes Quaternion berechnen & ablegen (für 3D-Viewer)
        const qRel = computeRelativeQuat(item.qw, item.qx, item.qy, item.qz);
        item.relQw = qRel.w;
        item.relQx = qRel.x;
        item.relQy = qRel.y;
        item.relQz = qRel.z;

        // 3. Genullte Winkel für Oszilloskop berechnen & phasenglätten
        const eRel = quatToEulerRawDeg(qRel.w, qRel.x, qRel.y, qRel.z);
        if (prevRoll === null) {
            item.roll = eRel.roll;
            item.pitch = eRel.pitch;
            item.yaw = eRel.yaw;
        } else {
            item.roll = unwrapAngle(eRel.roll, prevRoll);
            item.pitch = unwrapAngle(eRel.pitch, prevPitch);
            item.yaw = unwrapAngle(eRel.yaw, prevYaw);
        }
        prevRoll = item.roll;
        prevPitch = item.pitch;
        prevYaw = item.yaw;
    }
}


// ============================================================================
// 3. EINBAULAGEN-MODAL & 3D-VORSCHAUFENSTER
// ============================================================================

function createMountingFallbackCube() {
    if (mountMesh && mountScene) mountScene.remove(mountMesh);
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

    mountMesh = group;
    attachImuAxes(mountMesh);
    mountScene.add(mountMesh);
    updateMountingPreview3D();
}

function setupMountingModelMesh(gltfScene) {
    if (!mountScene) return;
    if (mountMesh) mountScene.remove(mountMesh);

    gltfScene.traverse((child) => {
        if (child.isMesh && child.material) child.material.side = THREE.DoubleSide;
    });

    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    const group = new THREE.Group();
    group.name = 'imuCadGroup';
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        gltfScene.scale.set(s, s, s);
        gltfScene.position.set(-center.x * s, -center.y * s, -center.z * s);
    }
    group.add(gltfScene);

    mountMesh = group;
    attachImuAxes(mountMesh);
    mountScene.add(mountMesh);
    updateMountingPreview3D();
}

function loadMountingGLBModel() {
    if (rawGltfScene) {
        setupMountingModelMesh(rawGltfScene.clone(true));
        return;
    }

    if (typeof THREE.GLTFLoader === 'undefined') {
        createMountingFallbackCube();
        return;
    }

    const loader = new THREE.GLTFLoader();
    const candidatePaths = ['./IMU.glb', 'IMU.glb', './model.glb', 'model.glb', '/IMU.glb'];

    function tryLoad(index) {
        if (index >= candidatePaths.length) {
            createMountingFallbackCube();
            return;
        }
        loader.load(
            candidatePaths[index],
            (gltf) => {
                if (!rawGltfScene) rawGltfScene = gltf.scene.clone(true);
                setupMountingModelMesh(gltf.scene);
            },
            undefined,
            () => { tryLoad(index + 1); }
        );
    }
    tryLoad(0);
}

function resizeMounting3D() {
    const container = document.getElementById('mounting-canvas-container');
    if (!container || !mountRenderer || !mountCamera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
        mountCamera.aspect = w / h;
        mountCamera.updateProjectionMatrix();
        mountRenderer.setSize(w, h);
        if (mountScene) mountRenderer.render(mountScene, mountCamera);
    }
}

function initMounting3D() {
    const container = document.getElementById('mounting-canvas-container');
    if (!container) return;

    if (mountRenderer) {
        resizeMounting3D();
        return;
    }

    const w = container.clientWidth || 280;
    const h = container.clientHeight || 224;

    mountScene = new THREE.Scene();
    mountScene.background = new THREE.Color(0xdbe2ea);

    mountCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    mountCamera.position.set(2.0, 1.5, 2.4);
    mountCamera.lookAt(0, 0, 0);

    mountRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    mountRenderer.setSize(w, h);
    mountRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(mountRenderer.domElement);

    if (typeof THREE.OrbitControls !== 'undefined') {
        mountControls = new THREE.OrbitControls(mountCamera, mountRenderer.domElement);
        mountControls.enableDamping = true;
        mountControls.dampingFactor = 0.08;
        mountControls.target.set(0, 0, 0);
        mountControls.minDistance = 1.0;
        mountControls.maxDistance = 6.0;
    }

    const l1 = new THREE.DirectionalLight(0xffffff, 1.3);
    l1.position.set(5, 10, 7);
    mountScene.add(l1);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.7);
    l2.position.set(-5, -5, -3);
    mountScene.add(l2);
    mountScene.add(new THREE.AmbientLight(0xffffff, 0.85));

    const grid = new THREE.GridHelper(4, 10, 0x009B4C, 0xcbd5e1);
    grid.position.y = -0.22;
    mountScene.add(grid);

    loadMountingGLBModel();

    if (!mountContainerObserver && window.ResizeObserver) {
        mountContainerObserver = new ResizeObserver(() => { resizeMounting3D(); });
        mountContainerObserver.observe(container);
    }

    function anim() {
        mountAnimId = requestAnimationFrame(anim);
        const c = document.getElementById('mounting-canvas-container');
        if (!c || c.clientWidth === 0) return;
        if (mountControls) mountControls.update();
        if (mountRenderer && mountScene && mountCamera) {
            mountRenderer.render(mountScene, mountCamera);
        }
    }
    anim();
}

/*
 * Breadcrumb: 2026-10-06 23:55 - ESP Parity Mounting Preview & Quaternion Alignment
 * [CRITICAL BUGFIX & FEATURE PARITY - MODAL 3D COORDINATE SYSTEM]:
 * 1. Ersetzt mountMesh.quaternion.setFromEuler('ZYX') durch applyEspModelQuaternion().
 * 2. Bringt 3D-Vorschau im Einbaulagen-Modal auf exakt dasselbe Koordinatensystem wie repMesh.
 * [DISMISSED]: setFromEuler('ZYX') stand 90° verdreht zur Hauptansicht und litt unter Gimbal Lock.
 */
/*
 * Breadcrumb: 2026-10-06 23:30 - Mounting Quaternion Synthesis Parity
 * [CRITICAL BUGFIX FLAG - MOUNTING ROLL/PITCH SYNTHESIS]:
 * 1. Bildet Tait-Bryan Z-Y-X (Roll um X, Pitch um Y, Yaw um Z) exakt im Modellraum ab.
 * 2. Transformiert das Ergebnis in den Sensor-Frame des ESP32:
 *    - qw = w_model
 *    - qx = y_model (Pitch)
 *    - qy = -x_model (-Roll)
 *    - qz = z_model (Yaw)
 * 3. Garantiert, dass der Roll-Regler exakt die Roll-Achse dreht und Pitch die Kippachse.
 */
/*
 * Breadcrumb: 2026-10-06 23:45 - Direct Sensor-Frame Mounting Synthesis
 * [CRITICAL BUGFIX FLAG - DIRECT QUATERNION TARE SYNTHESIS]:
 * 1. Erzeugt qMount direkt im Sensorframe:
 *    - Pitch-Regler (pDeg = -90) erzeugt qy = -0.7071 (exakte Kompensation der Ruhelage).
 *    - Roll-Regler (rDeg) dreht um qx.
 *    - Yaw-Regler (yDeg) dreht um qz.
 * 2. Garantiert q_rel = q_mount^-1 * q_raw == (1,0,0,0) am Kipprahmen in Ruhelage.
 */
function getMountingQuaternionFromDeg(rDeg, pDeg, yDeg) {
    const r = ((rDeg || 0) * (Math.PI / 180)) / 2;
    const p = ((pDeg || 0) * (Math.PI / 180)) / 2;
    const y = ((yDeg || 0) * (Math.PI / 180)) / 2;

    const cr = Math.cos(r), sr = Math.sin(r);
    const cp = Math.cos(p), sp = Math.sin(p);
    const cy = Math.cos(y), sy = Math.sin(y);

    return {
        w: cr * cp * cy + sr * sp * sy,
        x: sr * cp * cy - cr * sp * sy, // Roll um Sensor-X
        y: cr * sp * cy + sr * cp * sy, // Pitch um Sensor-Y (Kippachse)
        z: cr * cp * sy - sr * sp * cy  // Yaw um Sensor-Z
    };
}

function updateMountingPreview3D() {
    if (!mountMesh) return;
    const rEl = document.getElementById('mount-roll-num');
    const pEl = document.getElementById('mount-pitch-num');
    const yEl = document.getElementById('mount-yaw-num');

    const r = (rEl && !isNaN(parseFloat(rEl.value))) ? parseFloat(rEl.value) : 0;
    const p = (pEl && !isNaN(parseFloat(pEl.value))) ? parseFloat(pEl.value) : 0;
    const y = (yEl && !isNaN(parseFloat(yEl.value))) ? parseFloat(yEl.value) : 0;

    const qMount = getMountingQuaternionFromDeg(r, p, y);
    applyEspModelQuaternion(mountMesh, qMount.w, qMount.x, qMount.y, qMount.z);

    if (mountRenderer && mountScene && mountCamera) {
        mountRenderer.render(mountScene, mountCamera);
    }
}

function syncMountingInput(axis, val) {
    const num = Math.max(-180, Math.min(180, parseFloat(val) || 0));
    const numEl = document.getElementById(`mount-${axis}-num`);
    const rngEl = document.getElementById(`mount-${axis}-range`);
    if (numEl && numEl.value != num) numEl.value = num;
    if (rngEl && rngEl.value != num) rngEl.value = num;
    updateMountingPreview3D();
}
window.syncMountingInput = syncMountingInput;

function setMountingPreset(r, p, y) {
    syncMountingInput('roll', r);
    syncMountingInput('pitch', p);
    syncMountingInput('yaw', y);
}
window.setMountingPreset = setMountingPreset;

function openMountingConfigModal() {
    const modal = document.getElementById('mounting-config-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    ['roll', 'pitch', 'yaw'].forEach(axis => {
        const val = replayMountConfig[axis] !== undefined ? replayMountConfig[axis] : 0;
        const numEl = document.getElementById(`mount-${axis}-num`);
        const rngEl = document.getElementById(`mount-${axis}-range`);
        if (numEl) numEl.value = val;
        if (rngEl) rngEl.value = val;
    });

    initMounting3D();
    if (!mountMesh || mountMesh.name !== 'imuCadGroup') {
        loadMountingGLBModel();
    }

    setTimeout(() => {
        resizeMounting3D();
        updateMountingPreview3D();
    }, 40);
}
window.openMountingConfigModal = openMountingConfigModal;

function closeMountingConfigModal() {
    const modal = document.getElementById('mounting-config-modal');
    if (modal) modal.classList.add('hidden');
    if (mountAnimId) {
        cancelAnimationFrame(mountAnimId);
        mountAnimId = null;
    }
}
window.closeMountingConfigModal = closeMountingConfigModal;

function adoptCurrentFrameMounting() {
    if (!replayFilteredData || replayFilteredData.length === 0) return;
    const sampleInterval = 0.1;
    const exactIndex = Math.min(Math.floor(replayCurrentTimeSec / sampleInterval), replayFilteredData.length - 1);
    const pt = replayFilteredData[exactIndex];

    const r = (pt.rawRoll !== undefined) ? Math.round(pt.rawRoll * 10) / 10 : 0;
    const p = (pt.rawPitch !== undefined) ? Math.round(pt.rawPitch * 10) / 10 : 0;
    const y = (pt.rawYaw !== undefined) ? Math.round(pt.rawYaw * 10) / 10 : 0;

    setMountingPreset(r, p, y);
}
window.adoptCurrentFrameMounting = adoptCurrentFrameMounting;

function saveMountingConfig() {
    const rEl = document.getElementById('mount-roll-num');
    const pEl = document.getElementById('mount-pitch-num');
    const yEl = document.getElementById('mount-yaw-num');

    const r = (rEl && !isNaN(parseFloat(rEl.value))) ? parseFloat(rEl.value) : 0;
    const p = (pEl && !isNaN(parseFloat(pEl.value))) ? parseFloat(pEl.value) : 0;
    const y = (yEl && !isNaN(parseFloat(yEl.value))) ? parseFloat(yEl.value) : 0;

    replayMountConfig = { roll: r, pitch: p, yaw: y };

    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    localStorage.setItem(`stag_mount_${devId}`, JSON.stringify(replayMountConfig));

    updateMountingQuaternion();
    updateMountingButtonUI();
    recalculateAllEuler();
    drawReplayGraph(replayCurrentTimeSec);
    renderInterpolatedFrame(replayCurrentTimeSec);

    closeMountingConfigModal();
}
window.saveMountingConfig = saveMountingConfig;

function updateMountingButtonUI() {
    const lbl = document.getElementById('btn-replay-mounting-label');
    if (!lbl) return;
    const parts = [];
    if (replayMountConfig.roll !== 0) parts.push(`R:${replayMountConfig.roll}°`);
    if (replayMountConfig.pitch !== 0) parts.push(`P:${replayMountConfig.pitch}°`);
    if (replayMountConfig.yaw !== 0) parts.push(`Y:${replayMountConfig.yaw}°`);
    lbl.innerText = parts.length > 0 ? parts.join(' ') : '0°';
}

/*
 * Breadcrumb: 2026-10-06 23:40 - Inverted Default Pitch Baseline (-90° / -47.9°)
 * [CRITICAL BUGFIX FLAG - KIPPSTATION BASELINE POLARITY]:
 * 1. Ändert Default-Pitch von +47.9° / +90° auf -90° (bzw. -47.9° Ruhelage).
 * 2. Startet den Kipprahmen-Graph am Nullpunkt und hebt in positiver Richtung ab.
 */
/*
 * Breadcrumb: 2026-10-06 23:45 - Default Mounting Preset (-90° Pitch)
 * [CRITICAL BUGFIX FLAG - KIPPSTATION DEFAULT ZERO BASELINE]:
 * 1. Default-Einbaulage für Kipprahmen auf Roll 0°, Pitch -90°, Yaw 0° gesetzt.
 * 2. Bringt den Oszilloskop-Startwert exakt auf 0.0° und Hubkurve stufenlos auf +42.5°.
 */
function checkAndApplySavedMounting() {
    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    const saved = localStorage.getItem(`stag_mount_${devId}`);
    if (saved) {
        try {
            replayMountConfig = JSON.parse(saved);
        } catch (e) {
            replayMountConfig = { roll: 0, pitch: -90, yaw: 0 };
        }
    } else {
        replayMountConfig = { roll: 0.0, pitch: -90.0, yaw: 0.0 };
    }
    updateMountingQuaternion();
    updateMountingButtonUI();
    recalculateAllEuler();
}

// ============================================================================
// 4. FRAME-INTERPOLATION & 3D RENDERING
// ============================================================================

/*
 * Breadcrumb: 2026-10-06 23:50 - ESP Direct Quaternion Orientation & SLERP Blending
 * [CRITICAL BUGFIX & FEATURE PARITY - HARDWARE 3D MODEL SYNCHRONIZATION]:
 * 1. Rotiert repMesh direkt über die Portal-Quaternions-Gleichung:
 *    q_three = (-qy, qx, qz, qw) gefolgt von premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107)).
 * 2. Eliminiert repMesh.quaternion.setFromEuler(), wodurch 3D-Kippsprünge unmöglich werden.
 * 3. Nutzt direkte sphärische/normalisierte Interpolation zwischen Frame A und B.
 */
// ============================================================================
// 4. FRAME-INTERPOLATION & 3D RENDERING
// ============================================================================

/*
 * Breadcrumb: 2026-10-06 23:59 - 3D CAD Mesh Sensor-Offset Parity & Absolute Frame Alignment
 * [CRITICAL BUGFIX FLAG - CAD MODEL Y-UP ORIENTATION RESTORED]:
 * 1. Stellt Sensor-Offset in die Y-Up-Welt wieder vollständig her:
 *    premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107))  // +90° Z
 *    premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)) // -90° X
 * 2. repMesh nutzt im Viewport die echten, absoluten Sensordaten (qw..qz) via SLERP
 *    für die korrekte physische 90°-Montagelage am Kipprahmen.
 * 3. applyEspModelQuaternion() synchronisiert Modal-Vorschau und Hauptansicht auf identische Basis.
 * [DISMISSED]: Weglassen des -90° X-Versatzes und Nutzen von relQw verdrehte das Gehäuse im Raum.
 */
/*
 * Breadcrumb: 2026-10-06 23:59 - Sensor-Offset & Y-Up Basis Alignment
 * [CRITICAL BUGFIX & FEATURE PARITY - 3D CAD MODEL ORIENTATION]:
 * 1. Überträgt das Hardware-Mapping (-qy, qx, qz, qw) und die Y-Up-Weltrotation.
 * 2. targetMesh übernimmt das transformierte Quaternion ohne Gimbal Lock.
 */
/*
 * Breadcrumb: 2026-10-06 23:25 - Canonical Sensor-to-Three Transformation (live-3d.js Parity)
 * [CRITICAL BUGFIX FLAG - SENSOR QUATERNION ROTATION PARITY]:
 * 1. Stellt (-qy, qx, qz, qw) mit +90° Z und -90° X Y-up Premultiplies wieder her.
 * 2. Hält mathematische Parität zwischen Haupt-Viewport, Modal-Vorschau und ESP-Firmware.
 */
function applyEspModelQuaternion(targetMesh, qw, qx, qy, qz) {
    const norm = Math.hypot(qx, qy, qz, qw) || 1.0;
    const qThree = new THREE.Quaternion(-qy / norm, qx / norm, qz / norm, qw / norm);

    // Sensor-Offset in die Y-Up-Welt
    qThree.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));  // 90° Z
    qThree.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)); // -90° X

    targetMesh.quaternion.copy(qThree);
}

/*
 * Breadcrumb: 2026-10-06 23:20 - Acceleration & Displacement Vector Parity (live-3d.js)
 * [CRITICAL BUGFIX FLAG - SENSOR TO MODEL VECTOR MAPPING [ay, -ax, az]]:
 * 1. Übernimmt das verifizierte Hardware-Mapping aus live-3d.js:
 *    - Model X = +Sensor Y  (ay / dy)
 *    - Model Y = -Sensor X  (-ax / -dx)
 *    - Model Z = +Sensor Z  (az / dz)
 * 2. Stellt sicher, dass Beschleunigungsimpulse und Schwingwege physisch exakt entlang
 *    der echten Gehäuseachsen ausgelenkt werden.
 * [DISMISSED]: THREE.Vector3(dx, dy, dz) ignorierte die 90°-Leiterplattendrehung des BNO085.
 */
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

    // Kontinuierliche Winkelanzeige im HUD (genullte Werte bezüglich Tare)
    const roll = ptA.roll + (ptB.roll - ptA.roll) * alpha;
    const pitch = ptA.pitch + (ptB.pitch - ptA.pitch) * alpha;
    const yaw = ptA.yaw + (ptB.yaw - ptA.yaw) * alpha;

    const axD = ptA.ax + (ptB.ax - ptA.ax) * alpha;
    const ayD = ptA.ay + (ptB.ay - ptA.ay) * alpha;
    const azD = ptA.az + (ptB.az - ptA.az) * alpha;

    const dxD = ((ptA.dx || 0) + ((ptB.dx || 0) - (ptA.dx || 0)) * alpha);
    const dyD = ((ptA.dy || 0) + ((ptB.dy || 0) - (ptA.dy || 0)) * alpha);
    const dzD = ((ptA.dz || 0) + ((ptB.dz || 0) - (ptA.dz || 0)) * alpha);

    /*
     * 3D-MODELL: Echte, absolute Ausrichtung im Raum (KEIN Tare)
     * Zeigt das Gehäuse exakt in der realen 90°-Montage am Kipprahmen.
     */
    if (repMesh && repScene && repCamera) {
        const normA = Math.hypot(ptA.qw, ptA.qx, ptA.qy, ptA.qz) || 1.0;
        const normB = Math.hypot(ptB.qw, ptB.qx, ptB.qy, ptB.qz) || 1.0;

        // Absolute Sensordaten ohne Nulllagen-Offset
        const qA = new THREE.Quaternion(-ptA.qy / normA, ptA.qx / normA, ptA.qz / normA, ptA.qw / normA);
        const qB = new THREE.Quaternion(-ptB.qy / normB, ptB.qx / normB, ptB.qz / normB, ptB.qw / normB);

        if (qA.dot(qB) < 0) qB.set(-qB.x, -qB.y, -qB.z, -qB.w);
        qA.slerp(qB, alpha);

        // Sensor-Offset in die Y-Up-Welt
        qA.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));  // 90° Z
        qA.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)); // -90° X
        repMesh.quaternion.copy(qA);

        // Achsen-Mapping exakt an live-3d.js angepasst: Vector3(ay, -ax, az)
        // Unterstützt sowohl Schwingweg (dx, dy, dz in mm) als auch direkte Beschleunigungsdynamik
        const mmToSceneScale = 0.025;
        const hasDisp = Math.abs(dxD) > 0.001 || Math.abs(dyD) > 0.001 || Math.abs(dzD) > 0.001;

        let localVec;
        if (hasDisp) {
            // Auslenkung via integriertem Schwingweg
            localVec = new THREE.Vector3(
                dyD * mmToSceneScale,
                -dxD * mmToSceneScale,
                dzD * mmToSceneScale
            );
        } else {
            // Fallback auf dynamische Beschleunigungsauslenkung (analog live-3d.js)
            const aLen = Math.hypot(axD, ayD, azD);
            const axF = (aLen > 0.20) ? axD : 0;
            const ayF = (aLen > 0.20) ? ayD : 0;
            const azF = (aLen > 0.20) ? azD : 0;
            localVec = new THREE.Vector3(ayF * 0.05, -axF * 0.05, azF * 0.05);
        }

        localVec.applyQuaternion(repMesh.quaternion);

        repMesh.position.set(
            Math.max(-0.85, Math.min(0.85, localVec.x)),
            Math.max(-0.85, Math.min(0.85, localVec.y)),
            Math.max(-0.85, Math.min(0.85, localVec.z))
        );

        repRenderer.render(repScene, repCamera);
    }

    const hud = document.getElementById('replay-overlay-hud');
    if (hud) {
        hud.innerHTML =
            `ANG: R:${roll >= 0 ? '+' : ''}${roll.toFixed(1)}° P:${pitch >= 0 ? '+' : ''}${pitch.toFixed(1)}° Y:${yaw >= 0 ? '+' : ''}${yaw.toFixed(1)}°<br>` +
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
// 5. BEREICHS-ZOOM, PAN & INTERAKTIVES OSZILLOSKOP
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
    const canvases = [
        document.getElementById('replayGraphCanvasAcc'),
        document.getElementById('replayGraphCanvasEuler'),
        document.getElementById('replayGraphCanvasDisp')
    ].filter(Boolean);

    if (canvases.length === 0 || canvasListenersAttached) return;
    canvasListenersAttached = true;

    const leftMargin = 44;

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

    let maxAcc = 0.1, maxAngle = 0.1, maxDisp = 0.05;
    for (let i = startIndex; i <= endIndex; i++) {
        const d = replayFilteredData[i];
        if (replayVisibleCurves.ax) maxAcc = Math.max(maxAcc, Math.abs(d.ax));
        if (replayVisibleCurves.ay) maxAcc = Math.max(maxAcc, Math.abs(d.ay));
        if (replayVisibleCurves.az) maxAcc = Math.max(maxAcc, Math.abs(d.az));

        if (replayVisibleCurves.roll) maxAngle = Math.max(maxAngle, Math.abs(d.roll));
        if (replayVisibleCurves.pitch) maxAngle = Math.max(maxAngle, Math.abs(d.pitch));
        if (replayVisibleCurves.yaw) maxAngle = Math.max(maxAngle, Math.abs(d.yaw));

        if (replayVisibleCurves.dx) maxDisp = Math.max(maxDisp, Math.abs(d.dx || 0));
        if (replayVisibleCurves.dy) maxDisp = Math.max(maxDisp, Math.abs(d.dy || 0));
        if (replayVisibleCurves.dz) maxDisp = Math.max(maxDisp, Math.abs(d.dz || 0));
    }

    if (replayAccThreshold > 0 && replayAccThreshold > maxAcc && (replayVisibleCurves.ax || replayVisibleCurves.ay || replayVisibleCurves.az)) {
        maxAcc = replayAccThreshold;
    }

    const scaleAcc = getNiceScale(maxAcc, 0.5, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0]);
    const scaleEuler = getNiceScale(maxAngle, 2.0, [2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180]);
    const scaleDisp = getNiceScale(maxDisp, 0.5, [0.2, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0, 100.0]);

    const leftMargin = 44;
    const curTime = (curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec);
    const curExactIdx = Math.min(Math.floor(curTime / 0.1), count - 1);
    const curPt = replayFilteredData[Math.max(0, curExactIdx)] || replayFilteredData[0];

    function renderTier(cv, maxScale, unitLabel, allCurves, badgeTitle, isBottomTier, isAccTier) {
        const w = cv.width = cv.clientWidth;
        const h = cv.height = cv.clientHeight;
        if (w === 0 || h === 0) return;

        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        const topMargin = 18;
        const bottomMargin = isBottomTier ? 16 : 8;
        const plotW = w - leftMargin;
        const plotH = h - topMargin - bottomMargin;
        const midY = topMargin + plotH / 2;
        const halfH = plotH / 2;

        const activeCurves = allCurves.filter(c => replayVisibleCurves[c.key]);

        if (isAccTier && replayAccThreshold > 0 && activeCurves.length > 0) {
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
            const isInt = Math.abs(val - Math.round(val)) < 1e-4;
            const str = (ratio > 0 ? '+' : '') + (isInt ? val.toFixed(0) : val.toFixed(1));

            ctx.textAlign = 'right';
            ctx.fillText(str, leftMargin - 6, y + 3);
            ctx.textAlign = 'left';
        });
        ctx.setLineDash([]);

        ctx.fillStyle = '#475569';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(unitLabel, 4, 12);

        if (isAccTier && replayAccThreshold > 0 && replayAccThreshold <= maxScale && activeCurves.length > 0) {
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

        activeCurves.forEach(({ key, color }) => {
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

        const curX = timeToX(curTime, w, leftMargin);
        if (curX >= leftMargin && curX <= w) {
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(curX, topMargin); ctx.lineTo(curX, h - bottomMargin); ctx.stroke();
            ctx.fillStyle = '#d97706';
            ctx.beginPath(); ctx.arc(curX, topMargin + 4, 3.5, 0, Math.PI * 2); ctx.fill();
        }

        if (activeCurves.length > 0) {
            ctx.font = 'bold 9px monospace';
            let valInfo = activeCurves.map(c => `${c.label}: ${(curPt[c.key] || 0).toFixed(c.dec || 2)}`).join('  ');
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

            activeCurves.forEach(c => {
                ctx.fillStyle = c.color;
                const textSeg = `${c.label}: ${(curPt[c.key] || 0).toFixed(c.dec || 2)}  `;
                ctx.fillText(textSeg, drawX, 14);
                drawX += ctx.measureText(textSeg).width;
            });
        }
    }

    renderTier(cvAcc, scaleAcc, 'm/s²', [
        { key: 'ax', color: '#dc2626', label: 'ACC X', dec: 2 },
        { key: 'ay', color: '#009B4C', label: 'ACC Y', dec: 2 },
        { key: 'az', color: '#2563eb', label: 'ACC Z', dec: 2 }
    ], 'BESCHLEUNIGUNG', false, true);

    renderTier(cvEuler, scaleEuler, '°', [
        { key: 'roll', color: '#dc2626', label: 'Roll', dec: 1 },
        { key: 'pitch', color: '#009B4C', label: 'Pitch', dec: 1 },
        { key: 'yaw', color: '#7c3aed', label: 'Yaw', dec: 1 }
    ], 'WINKEL', false, false);

    renderTier(cvDisp, scaleDisp, 'mm', [
        { key: 'dx', color: '#dc2626', label: 'X', dec: 2 },
        { key: 'dy', color: '#009B4C', label: 'Y', dec: 2 },
        { key: 'dz', color: '#2563eb', label: 'Z', dec: 2 }
    ], 'SCHWINGWEG', true, false);
}

// ============================================================================
// 6. PLAYBACK CONTROLS (PLAY, PAUSE, RESET, SCRUB)
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

function formatReplayTimestamp(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString('de-CH', { hour12: false });
        }
    } catch (e) { }
    return String(ts);
}

function onReplayCycleSelect(cycleVal) {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    if (cycleVal === 'ALL' || !cycleVal) {
        replayFilteredData = [...replayDataRaw];
    } else {
        const cId = parseInt(cycleVal, 10);
        replayFilteredData = replayDataRaw.filter(d => d.cycle === cId);
    }

    if (replayFilteredData.length === 0) {
        replayFilteredData = [...replayDataRaw];
    }

    resetReplayZoom();
    replayCurrentTimeSec = 0.0;

    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) {
        scrubber.min = 0;
        scrubber.max = Math.max(0, replayFilteredData.length - 1);
        scrubber.value = 0;
    }

    renderInterpolatedFrame(0.0);
    drawReplayGraph(0.0);
}
window.onReplayCycleSelect = onReplayCycleSelect;

function setReplayGraphMode(mode) {
    replayGraphMode = mode;
    drawReplayGraph(replayCurrentTimeSec);
}
window.setReplayGraphMode = setReplayGraphMode;

// ============================================================================
// 7. INGESTION & DATEI-INSPEKTION
// ============================================================================

/*
 * Breadcrumb: 2026-10-06 23:55 - Antipodal Stream Ingestion & ReferenceError Fix
 * [CRITICAL BUGFIX & FEATURE PARITY - CSV INGESTION PIPELINE]:
 * 1. Behebt ReferenceError: quatToEulerDeg is not defined durch zentrale Routine parseImuCsvRecord().
 * 2. Glättet antipodale Vorzeichenwechsel (q · q_prev < 0) direkt beim Einlesen der CSV-Zeilen.
 * 3. Initialisiert roll/pitch/yaw mit 0.0; die finale Berechnung erfolgt via recalculateAllEuler().
 */
let lastIngestQuat = { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };
let isIngestFirstSample = true;

/*
 * Breadcrumb: 2026-10-06 23:58 - Deduplicated Mounting Quaternion & Forced Cycle Override
 * [CRITICAL BUGFIX FLAG - MULTI-CHUNK EVENT SEPARATION]:
 * 1. updateMountingQuaternion() greift direkt auf getMountingQuaternionFromDeg() zu (DRY).
 * 2. parseImuCsvRecord priorisiert forcedCycle, falls übergeben (trennt Tages-Chunks sauber).
 * 3. Schützt calculateAllDisplacements() und Dropdown-Filter vor BootCycle-Kollisionen.
 */
function updateMountingQuaternion() {
    replayMountQuat = getMountingQuaternionFromDeg(
        replayMountConfig.roll,
        replayMountConfig.pitch,
        replayMountConfig.yaw
    );
}

/*
 * Breadcrumb: 2026-10-06 23:40 - Quaternion Norm Sanity Check & Zero-Order Hold
 * [CRITICAL BUGFIX FLAG - SENSOR GLITCH & ZERO-NORM REJECTION]:
 * 1. Filtert corrupt frames (qw, qx, qy, qz ~ 0) mit norm < 0.85 heraus.
 * 2. Hält das letzte physikalisch valide Quaternion (lastIngestQuat).
 * 3. Beseitigt die Nadel-Spikes bei Yaw, Pitch und Roll vollständig.
 * [DISMISSED]: Normalisierung von Nullvektoren blies Rauschen von 0.0001 auf 1.0 auf.
 */
function parseImuCsvRecord(line, fileIndex, forcedCycle) {
    const sep = line.includes(';') ? ';' : ',';
    const parts = line.split(sep);
    if (parts.length < 8) return null;

    let qw = parseFloat(parts[1]) || 1.0;
    let qx = parseFloat(parts[2]) || 0.0;
    let qy = parseFloat(parts[3]) || 0.0;
    let qz = parseFloat(parts[4]) || 0.0;

    // Plausibilitätsprüfung: Einheitsquaternion muss Norm nahe 1.0 besitzen
    const rawNorm = Math.hypot(qw, qx, qy, qz);
    if (rawNorm < 0.85 || rawNorm > 1.15) {
        // Bei korruptem Frame den vorherigen gültigen Zustand halten
        qw = lastIngestQuat.w;
        qx = lastIngestQuat.x;
        qy = lastIngestQuat.y;
        qz = lastIngestQuat.z;
    } else {
        // Normalisieren
        qw /= rawNorm;
        qx /= rawNorm;
        qy /= rawNorm;
        qz /= rawNorm;
    }

    // Antipodale Kontinuität identisch zum ESP ws.onmessage (q · q_prev >= 0)
    if (isIngestFirstSample) {
        lastIngestQuat = { w: qw, x: qx, y: qy, z: qz };
        isIngestFirstSample = false;
    } else {
        const dot = qw * lastIngestQuat.w + qx * lastIngestQuat.x + qy * lastIngestQuat.y + qz * lastIngestQuat.z;
        if (dot < 0.0) {
            qw = -qw; qx = -qx; qy = -qy; qz = -qz;
        }
        lastIngestQuat = { w: qw, x: qx, y: qy, z: qz };
    }

    let assignedCycle = 1;
    if (forcedCycle !== undefined && forcedCycle !== null) {
        assignedCycle = forcedCycle;
    } else if (parts[8]) {
        assignedCycle = parseInt(parts[8], 10) || 1;
    }

    return {
        ts: parts[0].trim(),
        qw, qx, qy, qz,
        ax: parseFloat(parts[5]) || 0.0,
        ay: parseFloat(parts[6]) || 0.0,
        az: parseFloat(parts[7]) || 0.0,
        roll: 0.0,
        pitch: 0.0,
        yaw: 0.0,
        cycle: assignedCycle,
        fileIndex: fileIndex
    };
}

async function inspectImuFile(file) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;

    isDayMergedMode = false;
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;

    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    const titleEl = document.getElementById('replay-file-title');
    if (titleEl) titleEl.innerText = `📄 ${file.file_name || 'IMU Log'}`;
    const metaEl = document.getElementById('replay-meta-info');
    if (metaEl) metaEl.innerText = 'Lade Messdaten...';

    initReplay3D();

    try {
        const cleanPath = file.file_path.startsWith('/') ? file.file_path.substring(1) : file.file_path;
        const url = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
        const text = await fetchCachedCsv(url);

        const lines = text.split('\n');
        replayDataRaw = [];
        isIngestFirstSample = true;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const item = parseImuCsvRecord(line, 0, 1);
            if (item) replayDataRaw.push(item);
        }

        if (replayDataRaw.length === 0) {
            if (metaEl) metaEl.innerText = 'Keine gültigen Messzeilen gefunden.';
            return;
        }

        calculateAllDisplacements();
        checkAndApplySavedMounting();

        const select = document.getElementById('replay-cycle-select');
        if (select) {
            select.innerHTML = `<option value="ALL">Datei (${replayDataRaw.length} Punkte)</option>`;
        }

        if (metaEl) {
            const dur = ((replayDataRaw.length - 1) * 0.1).toFixed(1);
            metaEl.innerText = `${replayDataRaw.length} Samples | Dauer: ${dur}s @ 10 Hz`;
        }

        onReplayCycleSelect('ALL');
    } catch (err) {
        console.error('[INSPECT ERROR]', err);
        if (metaEl) metaEl.innerText = 'Fehler beim Laden: ' + err.message;
    }
}
window.inspectImuFile = inspectImuFile;

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
        isIngestFirstSample = true;

        results.forEach(({ file, fileIdx, text }) => {
            if (!text) return;

            const lines = text.split('\n');
            let samplesInChunk = 0;
            const cycleId = fileIdx + 1;
            let firstTs = null;

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                if (!firstTs && line.split(/[;,]/)[0]) firstTs = line.split(/[;,]/)[0].trim();

                const item = parseImuCsvRecord(line, fileIdx, cycleId);
                if (item) {
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

        calculateAllDisplacements();
        checkAndApplySavedMounting();

        const select = document.getElementById('replay-cycle-select');
        select.innerHTML = `<option value="ALL">Gesamter Tag (${replayDataRaw.length} Punkte, ${chunkStats.length} Events)</option>`;

        chunkStats.forEach(cs => {
            select.innerHTML += `<option value="${cs.cycleId}">Event #${cs.cycleId} (${cs.timeStr} Uhr - ${cs.samplesInChunk} Samples)</option>`;
        });

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

// ============================================================================
// 8. WINDOW-EXPORTE & BOOTSTRAP
// ============================================================================

window.inspectImuFile = inspectImuFile;
window.inspectImuDayMerged = inspectImuDayMerged;
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

window.openMountingConfigModal = openMountingConfigModal;
window.closeMountingConfigModal = closeMountingConfigModal;
window.syncMountingInput = syncMountingInput;
window.setMountingPreset = setMountingPreset;
window.adoptCurrentFrameMounting = adoptCurrentFrameMounting;
window.saveMountingConfig = saveMountingConfig;

// Initialisierung der Einbaulage beim Skriptstart
checkAndApplySavedMounting();