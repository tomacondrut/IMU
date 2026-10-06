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



const imuMemoryCache = new Map();


/*
 * Breadcrumb: 2026-10-06 20:45 - Dynamic Curve Visibility State
 */
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



/*
 * Breadcrumb: 2026-10-06 20:45 - 3D Orientation Axes Helpers (Roll=X, Pitch=Y, Yaw=Z)
 * [CRITICAL 3D VISUALIZATION PARITY]:
 * 1. Zeichnet feste Richtungsvektoren mit ArrowHelpern direkt am Modellkörper.
 * 2. Farbkodierung: X (Rot) = Roll, Y (Grün) = Pitch, Z (Blau) = Yaw.
 * 3. Text-Sprites rotieren phasenstarr mit dem IMU-Gehäuse mit.
 */
/*
 * Breadcrumb: 2026-10-06 22:45 - 3D Orientation Axes Helpers Fix (Roll=X, Pitch=Y, Yaw=Z)
 * [CRITICAL BUGFIX FLAG - ELIMINATE SYNTAX ERROR & RESTORE AXIS PARITY]:
 * 1. Doppelte Deklarationen (const lblX/Y/Z) restlos entfernt -> Script parst fehlerfrei.
 * 2. X (Rot) = Roll, Y (Grün) = Pitch, Z (Blau) = Yaw.
 */
function attachImuAxes(targetGroup) {
    const old = targetGroup.getObjectByName('imuAxesGroup');
    if (old) targetGroup.remove(old);

    const axesGroup = new THREE.Group();
    axesGroup.name = 'imuAxesGroup';

    const len = 1.25;
    const headLen = 0.22;
    const headWidth = 0.12;

    // X-Achse: Längsachse = Roll (Rot #dc2626)
    const arrowX = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), len, 0xdc2626, headLen, headWidth);
    // Y-Achse: Quer-/Kippachse = Pitch (Grün #009B4C)
    const arrowY = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), len, 0x009B4C, headLen, headWidth);
    // Z-Achse: Hochachse = Yaw (Blau #2563eb)
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


    // Am Ende von createReplayFallbackCube():
    repMesh = group;
    attachImuAxes(repMesh);
    repScene.add(repMesh);

}

/*
 * Breadcrumb: 2026-10-06 21:55 - Shared GLB Scene Cache for Instant Popup 3D Model
 * [CRITICAL FEATURE PARITY - ZERO RELOAD LATENCY]:
 * 1. Speichert geladene GLTF-Szene global in cachedGltfScene.
 * 2. loadMountingGLBModel klont direkt die bereits geladene Szene (kein HTTP-Neuabruf).
 */
/*
 * Breadcrumb: 2026-10-06 22:15 - Raw GLB Scene Retention for Clean Popup Cloning
 * [CRITICAL FEATURE PARITY - ELIMINATE RE-SCALING DISTORTION]:
 * 1. rawGltfScene speichert das unskalierte Original-GLTF für sauberes Klonen im Popup.
 * 2. loadMountingGLBModel klont direkt die Rohszene und skaliert auf exakt 1.8 Einheiten.
 */
let rawGltfScene = null;

function setupReplayModelMesh(gltfScene) {
    if (repMesh && repScene) repScene.remove(repMesh);
    if (!rawGltfScene) rawGltfScene = gltfScene.clone(true);

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
    attachImuAxes(repMesh);
    repScene.add(repMesh);
    if (repRenderer && repScene && repCamera) repRenderer.render(repScene, repCamera);
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
                rawGltfScene = gltf.scene.clone(true);
                setupMountingModelMesh(gltf.scene);
            },
            undefined,
            () => { tryLoad(index + 1); }
        );
    }
    tryLoad(0);
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


/*
 * Breadcrumb: 2026-10-06 22:30 - Ground-Aligned GLB Preview & Axis Parity (Roll=Y, Pitch=X)
 * [CRITICAL BUGFIX & RUNTIME RESTORATION]:
 * 1. SyntaxError (doppelter setMountingPreset-Kopf) restlos behoben -> Graphen rendern sofort.
 * 2. Achsenzuordnung korrigiert: Roll steuert die Längs-/Kippachse, Pitch die Querachse.
 * 3. 0° = Gehäuse liegt plan mit Bodenplatte auf dem Gitter; Roll -90° = Kippstellung.
 * 4. Klonen von rawGltfScene garantiert formatfüllende GLB-Darstellung im Popup.
 * 5. renderInterpolatedFrame übersetzt reale Millimeter-Ausschläge (dx, dy, dz) phasenstarr.
 */

/*
 * Breadcrumb: 2026-10-06 22:45 - Standard 0° Baseplate Mounting & Euler Parity
 * [CRITICAL BUGFIX FLAG - AXIS CORRECTION]:
 * 1. Default-Einbaulage ist 0° (plan auf Bodenplatte liegend).
 * 2. Euler-Mapping: X = Roll, Y = Pitch, Z = Yaw (keine Achsenvertauschung mehr).
 * [DISMISSED]: { roll: -90, pitch: 0, yaw: 0 } als Hardcoded-Default führte zu gekippter Voransicht.
 */

// Globaler Status für Einbaulage (Standard: 0° = Gehäuse liegt plan mit Bodenplatte auf)
let replayMountConfig = { roll: 0, pitch: 0, yaw: 0 };
let replayMountQuat = null;

let mountScene, mountCamera, mountRenderer, mountMesh, mountControls;

// Three.js-basierte Euler-zu-Quaternion Konvertierung (Roll=X, Pitch=Y, Yaw=Z)
function eulerDegToQuat(rDeg, pDeg, yDeg) {
    const euler = new THREE.Euler(
        (rDeg * Math.PI) / 180,
        (pDeg * Math.PI) / 180,
        (yDeg * Math.PI) / 180,
        'ZYX'
    );
    const q = new THREE.Quaternion().setFromEuler(euler);
    return { w: q.w, x: q.x, y: q.y, z: q.z };
}

function updateMountingQuaternion() {
    replayMountQuat = eulerDegToQuat(
        replayMountConfig.roll,
        replayMountConfig.pitch,
        replayMountConfig.yaw
    );
}

// Sensor-Rohdaten (-qy, qx, qz, qw) in das Modell-Koordinatensystem überführen
function sensorToModelQuat(qw, qx, qy, qz) {
    const norm = Math.hypot(qw, qx, qy, qz) || 1.0;
    return {
        w: qw / norm,
        x: -qy / norm,
        y: qx / norm,
        z: qz / norm
    };
}

// Relative Drehung im Modell-System berechnen: q_rel = q_mount^-1 * q_model
function getRelativeModelQuat(qw, qx, qy, qz) {
    const qM = sensorToModelQuat(qw, qx, qy, qz);
    if (!replayMountQuat) return qM;

    const tw = replayMountQuat.w, tx = replayMountQuat.x, ty = replayMountQuat.y, tz = replayMountQuat.z;
    const w = tw * qM.w + tx * qM.x + ty * qM.y + tz * qM.z;
    const x = tw * qM.x - tx * qM.w - ty * qM.z + tz * qM.y;
    const y = tw * qM.y + tx * qM.z - ty * qM.w - tz * qM.x;
    const z = tw * qM.z - tx * qM.y + ty * qM.x - tz * qM.w;
    const norm = Math.hypot(w, x, y, z) || 1.0;
    return { w: w / norm, x: x / norm, y: y / norm, z: z / norm };
}

function quatToEulerDeg(qw, qx, qy, qz) {
    const qRel = getRelativeModelQuat(qw, qx, qy, qz);
    const q = new THREE.Quaternion(qRel.x, qRel.y, qRel.z, qRel.w);
    const euler = new THREE.Euler().setFromQuaternion(q, 'ZYX');

    // Modell-Achsenparität: X = Roll (Längsachse), Y = Pitch (Quer-/Kippachse), Z = Yaw
    const roll = euler.x * (180 / Math.PI);
    const pitch = euler.y * (180 / Math.PI);
    const yaw = euler.z * (180 / Math.PI);

    return { roll, pitch, yaw };
}

function recalculateAllEuler() {
    for (let i = 0; i < replayDataRaw.length; i++) {
        const item = replayDataRaw[i];
        const e = quatToEulerDeg(item.qw, item.qx, item.qy, item.qz);
        item.roll = e.roll;
        item.pitch = e.pitch;
        item.yaw = e.yaw;
    }
}

function updateMountingButtonUI() {
    const lbl = document.getElementById('btn-replay-mounting-label');
    if (!lbl) return;
    const parts = [];
    if (replayMountConfig.roll !== 0) parts.push(`R:${replayMountConfig.roll}°`);
    if (replayMountConfig.pitch !== 0) parts.push(`P:${replayMountConfig.pitch}°`);
    if (replayMountConfig.yaw !== 0) parts.push(`Y:${replayMountConfig.yaw}°`);
    lbl.innerText = parts.length > 0 ? parts.join(' ') : '0° (Plan / Bodenplatte)';
}

function checkAndApplySavedMounting() {
    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    const saved = localStorage.getItem(`stag_mount_${devId}`);
    if (saved) {
        try {
            replayMountConfig = JSON.parse(saved);
        } catch (e) {
            replayMountConfig = { roll: 0, pitch: 0, yaw: 0 };
        }
    } else {
        replayMountConfig = { roll: 0, pitch: 0, yaw: 0 };
    }
    updateMountingQuaternion();
    updateMountingButtonUI();
    recalculateAllEuler();
}

// ----------------------------------------------------------------------------
// MODAL-STEUERUNG & GLB-3D-VORSCHAU FÜR EINBAULAGE
// ----------------------------------------------------------------------------

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
    requestAnimationFrame(() => {
        resizeMounting3D();
        updateMountingPreview3D();
    });
}
window.openMountingConfigModal = openMountingConfigModal;

function closeMountingConfigModal() {
    const modal = document.getElementById('mounting-config-modal');
    if (modal) modal.classList.add('hidden');
}
window.closeMountingConfigModal = closeMountingConfigModal;

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

function adoptCurrentFrameMounting() {
    if (!replayFilteredData || replayFilteredData.length === 0) return;
    const sampleInterval = 0.1;
    const exactIndex = Math.min(Math.floor(replayCurrentTimeSec / sampleInterval), replayFilteredData.length - 1);
    const pt = replayFilteredData[exactIndex];

    const qM = sensorToModelQuat(pt.qw, pt.qx, pt.qy, pt.qz);
    const q = new THREE.Quaternion(qM.x, qM.y, qM.z, qM.w);
    const euler = new THREE.Euler().setFromQuaternion(q, 'ZYX');

    const rawRoll = Math.round(euler.x * (180 / Math.PI));
    const rawPitch = Math.round(euler.y * (180 / Math.PI));
    const rawYaw = Math.round(euler.z * (180 / Math.PI));

    setMountingPreset(rawRoll, rawPitch, rawYaw);
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
    if (mountMesh && mountScene) mountScene.remove(mountMesh);

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

    mountMesh = group;
    attachImuAxes(mountMesh);
    mountScene.add(mountMesh);
    updateMountingPreview3D();
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

    mountRenderer = new THREE.WebGLRenderer({ antialias: true });
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

    // Bodengitter direkt unter der Gehäusebasis positioniert
    const grid = new THREE.GridHelper(4, 10, 0x009B4C, 0xcbd5e1);
    grid.position.y = -0.22;
    mountScene.add(grid);

    createMountingFallbackCube();
    loadMountingGLBModel();

    function anim() {
        requestAnimationFrame(anim);
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
 * Breadcrumb: 2026-10-06 22:45 - Mounting Preview & Preset Alignment
 * [CRITICAL BUGFIX FLAG - SLIDER PARITY]:
 * 1. mountMesh rotiert Euler mit Roll an X, Pitch an Y und Yaw an Z.
 * 2. adoptCurrentFrameMounting liest rawRoll aus euler.x und rawPitch aus euler.y.
 */
function updateMountingPreview3D() {
    if (!mountMesh) return;
    const rEl = document.getElementById('mount-roll-num');
    const pEl = document.getElementById('mount-pitch-num');
    const yEl = document.getElementById('mount-yaw-num');

    const r = (rEl && !isNaN(parseFloat(rEl.value))) ? parseFloat(rEl.value) : 0;
    const p = (pEl && !isNaN(parseFloat(pEl.value))) ? parseFloat(pEl.value) : 0;
    const y = (yEl && !isNaN(parseFloat(yEl.value))) ? parseFloat(yEl.value) : 0;

    // r dreht Roll um X, p dreht Pitch um Y, y dreht Yaw um Z
    mountMesh.quaternion.setFromEuler(
        new THREE.Euler((r * Math.PI) / 180, (p * Math.PI) / 180, (y * Math.PI) / 180, 'ZYX')
    );

    if (mountRenderer && mountScene && mountCamera) {
        mountRenderer.render(mountScene, mountCamera);
    }
}

// ----------------------------------------------------------------------------
// 3. FRAME-INTERPOLATION & 3D RENDERING (MIT SCHWINGWEG-TRANSLATION)
// ----------------------------------------------------------------------------

/*
 * Breadcrumb: 2026-10-06 22:45 - 3D Replay Rotation Alignment
 * [CRITICAL BUGFIX FLAG - MOTION PARITY]:
 * repMesh.quaternion übernimmt roll auf X und pitch auf Y.
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

    const roll = ptA.roll + (ptB.roll - ptA.roll) * alpha;
    const pitch = ptA.pitch + (ptB.pitch - ptA.pitch) * alpha;
    const yaw = ptA.yaw + (ptB.yaw - ptA.yaw) * alpha;

    const axD = ptA.ax + (ptB.ax - ptA.ax) * alpha;
    const ayD = ptA.ay + (ptB.ay - ptA.ay) * alpha;
    const azD = ptA.az + (ptB.az - ptA.az) * alpha;

    const dxD = ((ptA.dx || 0) + ((ptB.dx || 0) - (ptA.dx || 0)) * alpha);
    const dyD = ((ptA.dy || 0) + ((ptB.dy || 0) - (ptA.dy || 0)) * alpha);
    const dzD = ((ptA.dz || 0) + ((ptB.dz || 0) - (ptA.dz || 0)) * alpha);

    if (repMesh && repScene && repCamera) {
        repMesh.quaternion.setFromEuler(
            new THREE.Euler((roll * Math.PI) / 180, (pitch * Math.PI) / 180, (yaw * Math.PI) / 180, 'ZYX')
        );

        const mmToSceneScale = 0.025;
        const localDisp = new THREE.Vector3(
            dxD * mmToSceneScale,
            dyD * mmToSceneScale,
            dzD * mmToSceneScale
        );
        localDisp.applyQuaternion(repMesh.quaternion);

        repMesh.position.set(
            Math.max(-0.85, Math.min(0.85, localDisp.x)),
            Math.max(-0.85, Math.min(0.85, localDisp.y)),
            Math.max(-0.85, Math.min(0.85, localDisp.z))
        );

        repRenderer.render(repScene, repCamera);
    }

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

/*
 * Breadcrumb: 2026-10-06 20:45 - Selective Y-Scaling & Rendering for Active Curves
 * [PER-CHANNEL ISOLATION]: Schaltet eine Kurve ab, skaliert sich die Y-Achse 
 * automatisch optimal auf die verbleibenden sichtbaren Signale.
 */
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

    // 1. Skalenermittlung NUR für aktuell aktivierte Kurven
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

        // Nur aktivierte Kurven rendern
        const activeCurves = allCurves.filter(c => replayVisibleCurves[c.key]);

        // Schwellenwert-Hintergrund bei Peaks
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

        // Horizontale Rasterlinien
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
            // KORREKTUR: Prüft den konkreten Taktwert val auf Ganzzahligkeit
            const isInt = Math.abs(val - Math.round(val)) < 1e-4;
            const str = (ratio > 0 ? '+' : '') + (isInt ? val.toFixed(0) : val.toFixed(1));

            ctx.textAlign = 'right';
            ctx.fillText(str, leftMargin - 6, y + 3);
            ctx.textAlign = 'left';
        });
        ctx.setLineDash([]);

        // Einheit
        ctx.fillStyle = '#475569';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(unitLabel, 4, 12);

        // Schwellenwert-Linien
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

        // Zeitraster (Beschriftung unten)
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

        // Kurven zeichnen
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

        // Zoom-Selektion
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

        // Zeiger-Cursor
        const curX = timeToX(curTime, w, leftMargin);
        if (curX >= leftMargin && curX <= w) {
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(curX, topMargin); ctx.lineTo(curX, h - bottomMargin); ctx.stroke();
            ctx.fillStyle = '#d97706';
            ctx.beginPath(); ctx.arc(curX, topMargin + 4, 3.5, 0, Math.PI * 2); ctx.fill();
        }

        // Live-Badge oben rechts
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


/*
 * Breadcrumb: 2026-10-06 22:45 - Data Ingestion & Graph Activation Engine
 * [CRITICAL BUGFIX FLAG - RESTORE REPLAY PIPELINE]:
 * 1. onReplayCycleSelect befüllt replayFilteredData und löst sofort den initialen Canvas-Render aus.
 * 2. formatReplayTimestamp und setReplayGraphMode deklariert.
 * 3. inspectImuFile für Einzelfilterung implementiert.
 */
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

                replayDataRaw.push({
                    ts: parts[0],
                    qw, qx, qy, qz,
                    ax: parseFloat(parts[5]) || 0.0,
                    ay: parseFloat(parts[6]) || 0.0,
                    az: parseFloat(parts[7]) || 0.0,
                    roll: euler.roll,
                    pitch: euler.pitch,
                    yaw: euler.yaw,
                    cycle: 1,
                    fileIndex: 0
                });
            }
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

        /*
  * Breadcrumb: 2026-10-06 21:15 - Mount Configuration Hook in inspectImuDayMerged
  * [CRITICAL BUGFIX FLAG - ELIMINATE TARE REFERENCE ERROR]:
  * Ersetzt den Aufruf der gelöschten Tare-Funktion durch checkAndApplySavedMounting().
  */
        // Ersetze checkAndApplySavedTare(); durch:
        checkAndApplySavedMounting();
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

/*
 * Breadcrumb: 2026-10-06 21:15 - Mounting Position Exports & Auto-Init
 * [CRITICAL BUGFIX FLAG - CLEAN EXPORTS]:
 * 1. Entfernt nicht mehr existierende Tare-Exporte (verhindert ReferenceError).
 * 2. Exportiert alle Einbaulagen-Modal-Funktionen für HTML-Trigger.
 * 3. Initialisiert checkAndApplySavedMounting() direkt beim Parsen des Skripts.
 */
// Window Exporte
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

// Einbaulagen-Steuerung Exporte
window.openMountingConfigModal = openMountingConfigModal;
window.closeMountingConfigModal = closeMountingConfigModal;
window.syncMountingInput = syncMountingInput;
window.setMountingPreset = setMountingPreset;
window.adoptCurrentFrameMounting = adoptCurrentFrameMounting;
window.saveMountingConfig = saveMountingConfig;

// Direkte Initialisierung der Standard-Einbaulage (Pitch -90°) beim Booten
checkAndApplySavedMounting();