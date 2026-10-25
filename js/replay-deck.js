/*
 * ============================================================================
 * STAG TELEMETRIE HUB - REPLAY DECK & SPECTRAL VIBRATION ENGINE (replay-deck.js)
 * ============================================================================
 * Zusammengefasste Breadcrumbs & Versionshistorie:
 * - 2026-09-14 20:00: Oscilloscope Region Zoom & 0.1x Slow-Mo.
 * - 2026-10-05 20:30: Live Tare Re-Calculation & Side-View OrbitControls (Tait-Bryan Analytik).
 * - 2026-10-06 19:50: Multi-Canvas Synchronized Pointer & Zoom Engine (Acc, Euler, Schwingweg mm).
 * - 2026-10-06 20:45: Selective Y-Scaling & Rendering für aktive Kurven (ax..az, roll..yaw, dx..dz).
 * - 2026-10-06 22:30: Shared GLB Cache für verzögerungsfreie 3D-Modellübernahme ins Einbaulagen-Modal.
 * - 2026-10-06 23:35: Konsolidierter Gesamtwurf (Mounting Config, Reines Quaternionen-Tare q_rel = q_mount^-1 * q_raw).
 *   [DISMISSED]: sensorToModelQuat mit Euler('ZYX') erzeugte bei 90°-Annäherung Singularitätssprünge auf +137.9°.
 * - 2026-10-07 00:55: Kanonische Farb- & Achsensynchronisation:
 *   3D-Modell & Graphen: X-Kanal (Kippachse: Pitch, ay, dy) = Rot (#dc2626),
 *   Y-Kanal (Wankachse: Roll, ax, dx) = Grün (#009B4C), Z-Kanal (Hochachse: Yaw, az, dz) = Blau/Violett.
 * - 2026-10-11 15:10: 60-FPS Offscreen Graph Caching & Peak-Preserving Min-Max Decimation.
 * - 2026-10-11 15:25: Dynamic Sampling Rate Auto-Detection (10 Hz - 100 Hz) & Smooth tanh 3D-Scaling.
 *   [DISMISSED]: Hartes Box-Clamping Math.max(-0.85, Math.min(0.85)) führte zu bistabilen 3D-Teleportsprüngen.
 * - 2026-10-15 20:05: Vollständiges Refactoring & Spektral-Upgrade:
 *   [CRITICAL FEATURE & BUGFIX PARITY - TIMESTAMP SORT, FFT INTEGRATION & GAP VISUALIZER]:
 *   1. Chronologische Sortierung nach ISO-Zeitstempel (item.ts) vor Quaternionen-Kontinuität und Zyklus-Split.
 *   2. Radix-2 Cooley-Tukey FFT & IFFT mit phasenfreier Butterworth-Doppelintegration (-1 / omega^2).
 *   3. Sub-Bin Parabol-Interpolation für dominante Frequenz + lokales Sliding-Window mit Rausch-Gate.
 *   4. Visuelle Messpausen-Indikatoren (Amber-Bänder + Pausen-Dauer) und Linienunterbrechung über Schlafphasen.
 *   5. Polymorphes inspectImuFile() für direkte URL-Strings (aus cloud-engine.js) und Datei-Objekte.
 *   [DISMISSED]: 3-stufige IIR-Zeitbereichs-Kaskade dämpfte langsame Kipp-Schwingungen (0.5-1.5 Hz) um bis zu 35%.
 */

// ============================================================================
// 0. GLOBALE STATUS- & INSTANZVARIABLEN
// ============================================================================

let replayDataRaw = [];
let replayFilteredData = [];
let replayCurrentTimeSec = 0.0;
let replayIsPlaying = false;
let replaySpeed = 1.0;
let replayAnimId = null;
let replayLastFrameTime = 0;
let replayGraphMode = 'accel';
let replayAccThreshold = 0.0;

// Dynamisch erkannte Abtastrate
let replaySampleIntervalSec = 0.1;
let replaySampleRateHz = 10;
const REPLAY_GAP_THRESHOLD_SEC = 2.5; // Schwellenwert für Schlaf-/Messpausen

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
let repScene = null, repCamera = null, repRenderer = null, repMesh = null;
let repControls = null;
let repAnimId3D = null;
let repContainerObserver = null;

// Three.js Einbaulagen-Modal Viewport
let mountScene = null, mountCamera = null, mountRenderer = null, mountMesh = null;
let mountControls = null;
let mountAnimId = null;
let mountContainerObserver = null;

// Geteilter GLTF-Rohspeicher (vermeidet HTTP-Neuabrufe beim Öffnen des Einbaulagen-Modals)
let rawGltfScene = null;

// Einbaulagen-Konfiguration & relatives Tare-Quaternion
let replayMountConfig = { roll: 90.0, pitch: 0.0, yaw: 0.0 };
let replayMountQuat = null;

// Lokaler Speicher-Cache für CSV-Logs
/*
 * Breadcrumb: 2026-10-11 15:10 - 60-FPS Offscreen Graph Caching
 * Breadcrumb: 2026-10-25 09:30 - Multi-Slot Oscillogram Bitmap Cache & Persistent FFT Dataset Cache
 * [CRITICAL PERFORMANCE UPGRADE - INSTANT REPLAY & OSCILLOGRAM BITMAP CACHING]:
 * 1. imuProcessedRamCache + CacheStorage ('stag-imu-proc-cache-v1') speichern fertig geparste,
 *    Brownout-gefilterte und FFT-integrierte Datensätze (spart 100% CSV-Split, Sort & FFT bei erneutem Öffnen).
 * 2. replayOscillogramCache (LRU Map, 24 Slots) speichert gerenderte Offscreen-Canvas-Bitmaps (Acc, Euler, Disp)
 *    für verschiedene Dateien, Tage, Events und Zoom-Stufen (< 0.5ms Redraw bei Zoom-Reset oder Event-Wechsel).
 * 3. clearImuLogCache() leert bei Datei-Löschungen synchron alle RAM-, Bitmap- und Browser-Caches.
 * [DISMISSED]: Single-Slot Offscreen-Canvas verwarf das gerenderte Oszillogramm bei jedem Zoom oder Event-Wechsel.
 */
const imuMemoryCache = new Map();
const imuProcessedRamCache = new Map();
const replayOscillogramCache = new Map();
const MAX_OSCILLOGRAM_CACHE_SLOTS = 24;

// Aktuell aktive Offscreen-Puffer für 60-FPS Cursor-Overlay
let replayOffscreenAcc = null;
let replayOffscreenEuler = null;
let replayOffscreenDisp = null;
let replayGraphCacheKey = '';
let replayCachedScales = { scaleAcc: 1.0, scaleEuler: 2.0, scaleDisp: 0.5 };

// Sichtbarkeitsstatus der einzelnen Kurven
let replayVisibleCurves = {
    ax: true, ay: true, az: true,
    roll: true, pitch: true, yaw: true,
    dx: true, dy: true, dz: true
};

// Speichert oder aktualisiert ein gerendertes 3-fach Oszillogramm im LRU-Bitmap-Cache
function cacheOscillogramBitmaps(cacheKey, accCv, eulerCv, dispCv, scales) {
    if (replayOscillogramCache.has(cacheKey)) {
        replayOscillogramCache.delete(cacheKey);
    } else if (replayOscillogramCache.size >= MAX_OSCILLOGRAM_CACHE_SLOTS) {
        const oldestKey = replayOscillogramCache.keys().next().value;
        replayOscillogramCache.delete(oldestKey);
    }
    replayOscillogramCache.set(cacheKey, {
        acc: accCv,
        euler: eulerCv,
        disp: dispCv,
        scales: { ...scales }
    });
}

// Lädt vorab berechnete FFT/Euler-Datensätze aus RAM oder persistentem Browser-Cache
async function getCachedProcessedDataset(cacheKey) {
    if (imuProcessedRamCache.has(cacheKey)) {
        return imuProcessedRamCache.get(cacheKey);
    }
    if ('caches' in window) {
        try {
            const cache = await caches.open('stag-imu-proc-cache-v1');
            const resp = await cache.match('https://stag-local.cache/' + encodeURIComponent(cacheKey));
            if (resp) {
                const data = await resp.json();
                if (data && Array.isArray(data.replayDataRaw) && data.replayDataRaw.length > 0) {
                    imuProcessedRamCache.set(cacheKey, data);
                    return data;
                }
            }
        } catch (e) {
            console.warn('[PROC-CACHE] Read Fallback:', e);
        }
    }
    return null;
}

// Speichert fertig berechnete FFT/Euler-Datensätze im RAM und persistent im Browser-Cache
async function setCachedProcessedDataset(cacheKey, payload) {
    if (imuProcessedRamCache.size >= 15) {
        const oldest = imuProcessedRamCache.keys().next().value;
        imuProcessedRamCache.delete(oldest);
    }
    imuProcessedRamCache.set(cacheKey, payload);

    if ('caches' in window) {
        try {
            const cache = await caches.open('stag-imu-proc-cache-v1');
            const jsonStr = JSON.stringify(payload);
            const resp = new Response(jsonStr, {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800' }
            });
            await cache.put('https://stag-local.cache/' + encodeURIComponent(cacheKey), resp);
        } catch (e) {
            console.warn('[PROC-CACHE] Write Fallback:', e);
        }
    }
}

/*
 * Breadcrumb: 2026-10-11 15:20 - Dynamic Sampling Rate Auto-Detection
 * [FEATURE PARITY - ADAPTIVE SAMPLE RATE & TIMESTAMP ENGINE]:
 * Ermittelt medianes dt aus den echten ISO-Zeitstempeln (ignoriert Schlafpausen > 1.0s).
 */
function detectReplaySampleInterval() {
    if (!replayDataRaw || replayDataRaw.length < 2) {
        replaySampleIntervalSec = 0.1;
        replaySampleRateHz = 10;
        return;
    }

    const deltas = [];
    const checkCount = Math.min(replayDataRaw.length - 1, 600);
    for (let i = 0; i < checkCount; i++) {
        const diffSec = (replayDataRaw[i + 1].tsMs - replayDataRaw[i].tsMs) / 1000.0;
        if (!isNaN(diffSec) && diffSec > 0.004 && diffSec < 1.0) {
            deltas.push(diffSec);
        }
    }

    if (deltas.length >= 3) {
        deltas.sort((a, b) => a - b);
        const medianDt = deltas[Math.floor(deltas.length / 2)];
        const calcHz = Math.round(1.0 / medianDt);
        replaySampleRateHz = Math.max(1, Math.min(200, calcHz));
        replaySampleIntervalSec = 1.0 / replaySampleRateHz;
    } else {
        replaySampleIntervalSec = 0.1;
        replaySampleRateHz = 10;
    }
}
window.detectReplaySampleInterval = detectReplaySampleInterval;

function toggleReplayCurve(key) {
    if (Object.prototype.hasOwnProperty.call(replayVisibleCurves, key)) {
        replayVisibleCurves[key] = !replayVisibleCurves[key];
        updateCurveToggleUI();
        drawReplayGraph(replayCurrentTimeSec);
    }
}
window.toggleReplayCurve = toggleReplayCurve;

function updateCurveToggleUI() {
    const colorThemes = {
        ax: 'emerald', ay: 'red', az: 'blue',
        roll: 'red', pitch: 'emerald', yaw: 'purple',
        dx: 'emerald', dy: 'red', dz: 'blue'
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

function ensureFrequencyBadgeDOM() {
    if (document.getElementById('replay-freq-val')) return;
    const resetBtn = document.getElementById('btn-replay-reset-zoom');
    if (!resetBtn || !resetBtn.parentElement) return;

    const badge = document.createElement('div');
    badge.id = 'replay-freq-badge';
    badge.className = 'flex items-center gap-1.5 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-lg shrink-0 shadow-xs';
    badge.title = 'Dominante Schwingungsfrequenz (FFT-Spektralanalyse)';
    badge.innerHTML = `
        <span class="text-[10px] font-bold text-blue-600 font-mono uppercase">⚡ FREQ:</span>
        <span id="replay-freq-val" class="text-[11px] font-mono font-bold text-blue-700 tabular-nums">-- Hz</span>
    `;
    resetBtn.parentElement.insertBefore(badge, resetBtn);
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
window.fetchCachedCsv = fetchCachedCsv;

async function clearImuLogCache() {
    imuMemoryCache.clear();
    imuProcessedRamCache.clear();
    replayOscillogramCache.clear();
    replayGraphCacheKey = '';
    if ('caches' in window) {
        await caches.delete('stag-imu-csv-cache-v1');
        await caches.delete('stag-imu-proc-cache-v1');
    }
    console.log('[CACHE] Lokaler CSV-, FFT- und Oszillogramm-Cache vollständig geleert.');
}
window.clearImuLogCache = clearImuLogCache;

// ============================================================================
// 1. THREE.JS 3D VIEWPORT & MODELL-LADEN (HAUPTFENSTER)
// ============================================================================


/*
 * Breadcrumb: 2026-10-15 22:50 - WebGL Render-Loop Restart, Resize Guard & Diagnostic Logger
 * [CRITICAL BUGFIX FLAG - WEBGL LOOP RESTART & RESIZE OBSERVER GUARD]:
 * 1. Added replayDiagLog() to output granular execution steps & errors to console and terminal drawer.
 * 2. Cached lastRepW / lastRepH to prevent ResizeObserver infinite layout loops on mobile viewports.
 * 3. Extracted startReplay3DLoop() so reopening #imu-replay-deck after closeImuReplayDeck() restarts rendering.
 * [DISMISSED]: Early return in initReplay3D() when repRenderer existed left repAnimId3D permanently null after first close.
 */
let lastRepW = 0;
let lastRepH = 0;

function replayDiagLog(stage, msg, isError = false) {
    const formatted = `[REPLAY ${stage}] ${msg}`;
    if (isError) {
        console.error(formatted);
    } else {
        console.log(formatted);
    }
    if (typeof window.appendTerminalLog === 'function') {
        window.appendTerminalLog(formatted);
    }
}
window.replayDiagLog = replayDiagLog;

function resizeReplay3D() {
    const container = document.getElementById('replay-canvas-container');
    if (!container || !repRenderer || !repCamera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0 && (w !== lastRepW || h !== lastRepH)) {
        lastRepW = w;
        lastRepH = h;
        repCamera.aspect = w / h;
        repCamera.updateProjectionMatrix();
        repRenderer.setSize(w, h, false);
        if (repScene) repRenderer.render(repScene, repCamera);
    }
}

function resizeReplayDeck() {
    lastRepW = 0;
    lastRepH = 0;
    resizeReplay3D();
    drawReplayGraph(replayCurrentTimeSec);
}
window.resizeReplayDeck = resizeReplayDeck;

function startReplay3DLoop() {
    if (repAnimId3D !== null) return;
    function animateReplay3D() {
        const deck = document.getElementById('imu-replay-deck');
        if (!deck || deck.classList.contains('hidden')) {
            repAnimId3D = null;
            return;
        }
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

function initReplay3D() {
    ensureFrequencyBadgeDOM();
    const container = document.getElementById('replay-canvas-container');
    if (!container || typeof THREE === 'undefined') {
        replayDiagLog('3D-INIT', 'Container oder THREE.js nicht verfügbar!', true);
        return;
    }

    if (repRenderer) {
        lastRepW = 0;
        lastRepH = 0;
        resizeReplay3D();
        startReplay3DLoop();
        return;
    }

    try {
        const w = container.clientWidth || 300;
        const h = container.clientHeight || 240;
        lastRepW = w;
        lastRepH = h;

        repScene = new THREE.Scene();
        repScene.background = new THREE.Color(0xdbe2ea);
        repCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
        repCamera.position.set(2.4, 2.0, 2.8);
        repCamera.lookAt(0, 0, 0);

        repRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        repRenderer.setSize(w, h, false);
        repRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
            repContainerObserver = new ResizeObserver(() => {
                requestAnimationFrame(() => resizeReplay3D());
            });
            repContainerObserver.observe(container);
        }

        window.addEventListener('resize', resizeReplay3D);
        startReplay3DLoop();
    } catch (err) {
        replayDiagLog('3D-INIT-ERR', `WebGL Initialisierung fehlgeschlagen: ${err.message}`, true);
    }
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

/*
 * Breadcrumb: 2026-10-06 23:15 - Camera View Parity with live-3d.js
 * [CRITICAL BUGFIX FLAG - FRONT/SIDE PERSPECTIVE RESTORATION]:
 * Synchronisiert Kamerapositionen exakt mit live-3d.js ('front': Z=3.8, 'side': X=3.8).
 */
function setReplayCameraView(viewName) {
    if (!repCamera) return;

    const presets = {
        iso: [2.4, 2.0, 2.8],
        reset: [2.4, 2.0, 2.8],
        top: [0, 4.0, 0.001],
        front: [0, 0.3, 3.8],
        side: [3.8, 0.3, 0]
    };

    const pos = presets[viewName] || presets.iso;
    repCamera.position.set(pos[0], pos[1], pos[2]);
    repCamera.lookAt(0, 0, 0);

    if (repControls) {
        repControls.target.set(0, 0, 0);
        repControls.update();
    }
    if (repRenderer && repScene && repCamera) {
        repRenderer.render(repScene, repCamera);
    }
}
window.setReplayCameraView = setReplayCameraView;


/*
 * Breadcrumb: 2026-10-07 00:40 - Canonical 3D Axis Alignment (X = Roll Red / Y = Pitch Green / Z = Yaw Blue)
 * [CRITICAL BUGFIX FLAG - 3D ARROW LABELING PARITY]:
 * Pfeil X (1,0,0) = 'Roll (X)' (#dc2626), Pfeil Y (0,1,0) = 'Pitch (Y)' (#009B4C), Pfeil Z (0,0,1) = 'Yaw (Z)' (#2563eb).
 */
function attachImuAxes(targetGroup) {
    const old = targetGroup.getObjectByName('imuAxesGroup');
    if (old) targetGroup.remove(old);

    const axesGroup = new THREE.Group();
    axesGroup.name = 'imuAxesGroup';

    const len = 1.25;
    const headLen = 0.22;
    const headWidth = 0.12;

    axesGroup.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), len, 0xdc2626, headLen, headWidth));
    axesGroup.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), len, 0x009B4C, headLen, headWidth));
    axesGroup.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), len, 0x2563eb, headLen, headWidth));

    function createAxisLabel(text, colorHex, posVec) {
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
        sprite.position.copy(posVec);
        return sprite;
    }

    axesGroup.add(createAxisLabel('Roll (X)', '#dc2626', new THREE.Vector3(len + 0.25, 0, 0)));
    axesGroup.add(createAxisLabel('Pitch (Y)', '#009B4C', new THREE.Vector3(0, len + 0.25, 0)));
    axesGroup.add(createAxisLabel('Yaw (Z)', '#2563eb', new THREE.Vector3(0, 0, len + 0.25)));

    targetGroup.add(axesGroup);
}

function buildFallbackHousingGroup() {
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

    attachImuAxes(group);
    return group;
}

function createReplayFallbackCube() {
    if (repMesh && repScene) repScene.remove(repMesh);
    repMesh = buildFallbackHousingGroup();
    if (repScene) repScene.add(repMesh);
}

/*
 * Breadcrumb: 2026-10-06 23:50 - ESP Captive Portal Parity: Native CAD Mesh Orientation
 * [CRITICAL BUGFIX & FEATURE PARITY - GLTF BASIS ALIGNMENT]:
 * Übernimmt die native Orientierung aus setupModelMesh() ohne künstliche -90° X-Vordrehung.
 */
function normalizeAndCenterGltf(gltfScene) {
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
    attachImuAxes(group);
    return group;
}

function setupReplayModelMesh(gltfScene) {
    if (repMesh && repScene) repScene.remove(repMesh);
    if (!rawGltfScene) rawGltfScene = gltfScene.clone(true);

    repMesh = normalizeAndCenterGltf(gltfScene);
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
            (gltf) => setupReplayModelMesh(gltf.scene),
            undefined,
            () => tryLoad(index + 1)
        );
    }
    tryLoad(0);
}


// ============================================================================
// 2. MATHEMATIK: FFT-SPEKTRALINTEGRATION, FREQUENZ & EULER-TARE
// ============================================================================

/*
 * Breadcrumb: 2026-10-15 20:05 - Radix-2 Cooley-Tukey FFT & Ring-Free Spectral Double Integration
 * [CRITICAL FEATURE & MATH REFACTORING - ZERO ATTENUATION SPECTRAL INTEGRATION]:
 * 1. In-Place Radix-2 FFT & IFFT mit Zero-Padding auf 2x nächste Zweierpotenz (verhindert Wrap-Around).
 * 2. Lineares Detrending (Offset + Steigung) & 5% Cosine-Taper (Tukey-Fenster) gegen Spectral Leakage.
 * 3. Phasenfreier Butterworth-Hochpass 4. Ordnung (fc = 0.18 Hz) im Frequenzbereich verhindert Gibbs-Ringing.
 * 4. Exakte analytische Doppelintegration durch Multiplikation mit -1 / (2*pi*f)^2.
 * 5. Sub-Bin Parabol-Interpolation zur exakten Bestimmung der dominanten Schwingungsfrequenz.
 * [DISMISSED]:
 * - Zeitbereichs-IIR-Kaskade (3 Stufen) dämpfte 0.5-1.5 Hz Schwingungen um 35%.
 * - Harter Brickwall-Cut bei 0.15 Hz ohne Roll-Off erzeugte Ein-/Ausschwing-Artefakte an Impulskanten.
 */
function fftRadix2(re, im, inverse = false) {
    const n = re.length;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
        let k = n >> 1;
        while (k <= j) {
            j -= k;
            k >>= 1;
        }
        j += k;
    }

    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = (inverse ? 2.0 : -2.0) * Math.PI / len;
        const wStepR = Math.cos(angle);
        const wStepI = Math.sin(angle);

        for (let i = 0; i < n; i += len) {
            let wR = 1.0, wI = 0.0;
            for (let k = 0; k < half; k++) {
                const posA = i + k;
                const posB = i + k + half;
                const uR = re[posA], uI = im[posA];
                const vR = re[posB] * wR - im[posB] * wI;
                const vI = re[posB] * wI + im[posB] * wR;

                re[posA] = uR + vR;
                im[posA] = uI + vI;
                re[posB] = uR - vR;
                im[posB] = uI - vI;

                const nextWR = wR * wStepR - wI * wStepI;
                wI = wR * wStepI + wI * wStepR;
                wR = nextWR;
            }
        }
    }

    if (inverse) {
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}
const MAX_SINGLE_FFT_SAMPLES = 8192;
/*
 * Breadcrumb: 2026-10-15 20:25 - Unbiased Sub-Bin Parabolic Interpolation before 1/w^2 Weighting
 * Breadcrumb: 2026-10-15 22:50 - Block-Chunked FFT Guard, Adaptive STFT Stride & Finite Modulo Unwrap
 * Breadcrumb: 2026-10-25 11:45 - Moving-Baseline Gravity-Step Filter, 1.2Hz Structural HP & Envelope Gate
 * [CRITICAL MATH & PHYSICS FIX - ELIMINATE 200MM PRE-RINGING & GRAVITY-STEP DRIFT]:
 * 1. Entfernt vor der FFT langsame statische Basislinien-Verschiebungen (gleitendes 0.48s Fenster),
 *    die entstehen, wenn sich die Kippneigung ändert (z. B. +0.20 m/s² Rest-Gravitation auf az nach
 *    1.1° Kippung in zoom_3542.5s-3551.1s.csv).
 * 2. Hebt die Butterworth-Hochpass-Eckfrequenz für die Doppelintegration von 0.18 Hz auf 1.20 Hz an,
 *    sodass tieffrequente Stufen-Spektren nicht mehr mit -1/omega^2 (Faktor >600) zu 200 mm
 *    Schein-Auslenkungen aufgeblasen werden.
 * 3. Multipliziert den rekonstruierten Schwingweg mit einer kausalen lokalen Energie-Hüllkurve
 *    (Envelope-Gate), sodass vor einem Stoß (bei 0.02 m/s² Rauschen) garantiert 0.00 mm anliegen.
 * [DISMISSED]: Globales lineares Detrending mit cutoffHz = 0.18 Hz ohne lokales Energie-Gate.
 */
function detrendAndWindowSignal(rawSignal, n, N, sampleRateHz = 25) {
    // Gleitende Basislinie (~0.48 s Halbfenster) entfernt statische Gravitations-Stufen nach Neigungswechseln
    const halfWin = Math.max(3, Math.round(sampleRateHz * 0.24));
    const highPassed = new Float64Array(n);
    const prefixSum = new Float64Array(n + 1);

    for (let i = 0; i < n; i++) {
        prefixSum[i + 1] = prefixSum[i] + rawSignal[i];
    }

    let sqSum = 0.0;
    for (let i = 0; i < n; i++) {
        const sIdx = Math.max(0, i - halfWin);
        const eIdx = Math.min(n - 1, i + halfWin);
        const localMean = (prefixSum[eIdx + 1] - prefixSum[sIdx]) / (eIdx - sIdx + 1);
        const val = rawSignal[i] - localMean;
        highPassed[i] = val;
        sqSum += val * val;
    }

    // Zeitlokale kinetische Energie-Hüllkurve (verhindert nicht-kausales FFT-Ringing in Ruhephasen)
    const envHalf = Math.max(2, Math.round(sampleRateHz * 0.16));
    const envelope = new Float64Array(n);
    const noiseFloorRms = 0.065; // MEMS-Quantisierungsrauschen BNO085 (~0.04 m/s²)

    for (let i = 0; i < n; i++) {
        const sIdx = Math.max(0, i - envHalf);
        const eIdx = Math.min(n - 1, i + envHalf);
        let locSq = 0.0;
        for (let k = sIdx; k <= eIdx; k++) {
            locSq += highPassed[k] * highPassed[k];
        }
        const locRms = Math.sqrt(locSq / (eIdx - sIdx + 1));
        if (locRms <= noiseFloorRms) {
            envelope[i] = 0.0;
        } else {
            const normEnv = (locRms - noiseFloorRms) / (0.12);
            envelope[i] = Math.min(1.0, normEnv * normEnv);
        }
    }

    // Vorwärts-/Rückwärts-Glättung der Hüllkurve (~0.20 s Ausschwingzeit)
    const alphaEnv = Math.min(0.45, 1.0 / Math.max(2.0, sampleRateHz * 0.12));
    for (let i = 1; i < n; i++) {
        if (envelope[i] < envelope[i - 1]) {
            envelope[i] = envelope[i - 1] * (1.0 - alphaEnv) + envelope[i] * alphaEnv;
        }
    }
    for (let i = n - 2; i >= 0; i--) {
        if (envelope[i] < envelope[i + 1]) {
            envelope[i] = envelope[i + 1] * (1.0 - alphaEnv * 1.5) + envelope[i] * (alphaEnv * 1.5);
        }
    }

    const rms = Math.sqrt(sqSum / n);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const taperLen = Math.max(2, Math.floor(n * 0.05));

    for (let i = 0; i < n; i++) {
        let val = highPassed[i] * envelope[i];
        if (i < taperLen) {
            val *= 0.5 * (1.0 - Math.cos((Math.PI * i) / taperLen));
        } else if (i >= n - taperLen) {
            val *= 0.5 * (1.0 - Math.cos((Math.PI * (n - 1 - i)) / taperLen));
        }
        re[i] = val;
    }

    return { re, im, rms, envelope };
}

function spectralDoubleIntegrationBlock(rawBlock, sampleRateHz, cutoffHz = 1.20) {
    const n = rawBlock.length;
    if (n < 4) return { dispMm: new Float64Array(n), domFreqHz: 0.0 };

    let N = 32;
    while (N < n * 2 && N < 32768) N <<= 1;

    const effCutoffHz = Math.max(1.10, cutoffHz);
    const { re, im, rms, envelope } = detrendAndWindowSignal(rawBlock, n, N, sampleRateHz);

    if (!Number.isFinite(rms) || rms < 0.04) {
        return { dispMm: new Float64Array(n), domFreqHz: 0.0 };
    }

    fftRadix2(re, im, false);

    const deltaF = sampleRateHz / N;
    const nyquist = sampleRateHz / 2.0;
    const halfN = N >> 1;
    const accMag = new Float64Array(halfN + 1);

    let maxMag = 0.0;
    let peakBin = 0;

    re[0] = 0.0;
    im[0] = 0.0;

    for (let k = 1; k <= halfN; k++) {
        const f = k * deltaF;
        const mag = Math.hypot(re[k], im[k]);
        accMag[k] = mag;

        if (f >= 0.80 && f <= nyquist * 0.95) {
            if (mag > maxMag) {
                maxMag = mag;
                peakBin = k;
            }
        }

        if (f < 0.45 || f > nyquist * 0.95) {
            re[k] = 0.0;
            im[k] = 0.0;
            if (k < halfN) {
                re[N - k] = 0.0;
                im[N - k] = 0.0;
            }
        } else {
            // Phasenfreier Butterworth-Hochpass 4. Ordnung bei effCutoffHz (1.20 Hz)
            const ratio4 = Math.pow(f / effCutoffHz, 4);
            const hpGain = ratio4 / (1.0 + ratio4);
            const omega = 2.0 * Math.PI * f;
            const factor = -hpGain / (omega * omega);

            re[k] *= factor;
            im[k] *= factor;
            if (k < halfN) {
                re[N - k] *= factor;
                im[N - k] *= factor;
            }
        }
    }

    let domFreqHz = peakBin * deltaF;
    if (peakBin > 1 && peakBin < halfN) {
        const y0 = accMag[peakBin - 1];
        const y1 = accMag[peakBin];
        const y2 = accMag[peakBin + 1];
        const denom = y0 - 2.0 * y1 + y2;
        if (Math.abs(denom) > 1e-12) {
            const deltaK = 0.5 * (y0 - y2) / denom;
            if (Math.abs(deltaK) < 1.0) {
                domFreqHz = Math.max(0.80, (peakBin + deltaK) * deltaF);
            }
        }
    }

    fftRadix2(re, im, true);

    const dispMm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const rawMm = Number.isFinite(re[i]) ? re[i] * 1000.0 : 0.0;
        dispMm[i] = rawMm * envelope[i];
    }

    return { dispMm, domFreqHz };
}

function spectralDoubleIntegration(rawSignal, sampleRateHz, cutoffHz = 0.18) {
    const n = rawSignal.length;
    if (n <= MAX_SINGLE_FFT_SAMPLES) {
        return spectralDoubleIntegrationBlock(rawSignal, sampleRateHz, cutoffHz);
    }

    // Bei überlangen Zyklen (> 8192 Samples) in Blöcke aufteilen, um RAM-Überlauf zu verhindern
    const outDisp = new Float64Array(n);
    let maxDomFreq = 0.0;

    for (let offset = 0; offset < n; offset += MAX_SINGLE_FFT_SAMPLES) {
        const end = Math.min(n, offset + MAX_SINGLE_FFT_SAMPLES);
        const sub = rawSignal.subarray(offset, end);
        const res = spectralDoubleIntegrationBlock(sub, sampleRateHz, cutoffHz);
        outDisp.set(res.dispMm, offset);
        if (res.domFreqHz > maxDomFreq) maxDomFreq = res.domFreqHz;
    }

    return { dispMm: outDisp, domFreqHz: maxDomFreq };
}

function computeLocalWindowFrequencies(rawSignal, sampleRateHz, fallbackFreqHz) {
    const n = rawSignal.length;
    const outFreq = new Float64Array(n);
    const winSize = 64;

    if (n < winSize) {
        outFreq.fill(fallbackFreqHz);
        return outFreq;
    }

    // Adaptiver Schritt: Maximal ~200 STFT-Fenster pro Zyklus berechnen (verhindert Main-Thread-Blockade)
    const step = Math.max(8, Math.floor(n / 200));
    const halfWin = winSize >> 1;
    let lastFreq = fallbackFreqHz;

    for (let center = 0; center < n; center += step) {
        const start = Math.max(0, Math.min(n - winSize, center - halfWin));
        const sub = rawSignal.subarray(start, start + winSize);
        const { re, im, rms } = detrendAndWindowSignal(sub, winSize, 128);

        if (!Number.isFinite(rms) || rms < 0.04) {
            lastFreq = 0.0;
        } else {
            fftRadix2(re, im, false);
            const deltaF = sampleRateHz / 128;
            let maxMag = 0.0;
            let peakBin = 0;
            for (let k = 1; k <= 60; k++) {
                const f = k * deltaF;
                if (f < 0.20) continue;
                const mag = Math.hypot(re[k], im[k]);
                if (mag > maxMag) {
                    maxMag = mag;
                    peakBin = k;
                }
            }
            lastFreq = peakBin * deltaF;
        }

        const fillEnd = Math.min(n, center + step);
        for (let k = center; k < fillEnd; k++) {
            outFreq[k] = lastFreq;
        }
    }

    return outFreq;
}

function calculateAllDisplacements() {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    const t0 = performance.now();
    detectReplaySampleInterval();

    let currentCycle = null;
    let cycleIndices = [];

    function processCycle(indices) {
        const n = indices.length;
        if (n === 0) return;

        const rawAx = new Float64Array(n);
        const rawAy = new Float64Array(n);
        const rawAz = new Float64Array(n);

        for (let k = 0; k < n; k++) {
            const item = replayDataRaw[indices[k]];
            rawAx[k] = Number.isFinite(item.ax) ? item.ax : 0.0;
            rawAy[k] = Number.isFinite(item.ay) ? item.ay : 0.0;
            rawAz[k] = Number.isFinite(item.az) ? item.az : 0.0;
        }

        const resX = spectralDoubleIntegration(rawAx, replaySampleRateHz, 0.18);
        const resY = spectralDoubleIntegration(rawAy, replaySampleRateHz, 0.18);
        const resZ = spectralDoubleIntegration(rawAz, replaySampleRateHz, 0.18);

        const locFx = computeLocalWindowFrequencies(rawAx, replaySampleRateHz, resX.domFreqHz);
        const locFy = computeLocalWindowFrequencies(rawAy, replaySampleRateHz, resY.domFreqHz);
        const locFz = computeLocalWindowFrequencies(rawAz, replaySampleRateHz, resZ.domFreqHz);

        for (let k = 0; k < n; k++) {
            const item = replayDataRaw[indices[k]];
            item.dx = resX.dispMm[k];
            item.dy = resY.dispMm[k];
            item.dz = resZ.dispMm[k];

            item.freqX = locFy[k] || resY.domFreqHz;
            item.freqY = locFx[k] || resX.domFreqHz;
            item.freqZ = locFz[k] || resZ.domFreqHz;
            item.freqDom = Math.max(item.freqX, item.freqY, item.freqZ);
        }
    }

    try {
        for (let i = 0; i < replayDataRaw.length; i++) {
            const c = replayDataRaw[i].cycle || 1;
            if (currentCycle === null || c !== currentCycle) {
                if (cycleIndices.length > 0) processCycle(cycleIndices);
                currentCycle = c;
                cycleIndices = [i];
            } else {
                cycleIndices.push(i);
            }
        }
        if (cycleIndices.length > 0) processCycle(cycleIndices);
        replayDiagLog('FFT', `Schwingwege & Spektren für ${replayDataRaw.length} Samples in ${(performance.now() - t0).toFixed(1)} ms berechnet.`);
    } catch (err) {
        replayDiagLog('FFT-ERR', `Fehler in Spektralintegration: ${err.message}`, true);
    }
}
window.calculateAllDisplacements = calculateAllDisplacements;

function unwrapAngle(current, previous) {
    if (!Number.isFinite(current)) return Number.isFinite(previous) ? previous : 0.0;
    if (!Number.isFinite(previous)) return current;
    const diff = current - previous;
    const wrappedDiff = ((((diff + 180.0) % 360.0) + 360.0) % 360.0) - 180.0;
    return previous + wrappedDiff;
}


/*
 * Breadcrumb: 2026-10-06 23:55 - Continuous Euler Unwrapping & Direct Quat Tare
 * [CRITICAL BUGFIX & FEATURE PARITY - ZERO JUMPS & DISCONTINUITY ELIMINATION]:
 * Relatives Tare q_rel = q_mount^-1 * q_raw eliminiert Gimbal-Lock-Singularitäten.
 */
/*
 * Breadcrumb: 2026-10-15 20:45 - Model-Space Quaternion Tare & Roll/Pitch Axis Parity Fix
 * [CRITICAL BUGFIX FLAG - ELIMINATE ROLL-TO-YAW CROSS-PROJECTION & MODAL AXIS SWAP]:
 * 1. Transformiert Sensor-Quaternionen (qw, qx, qy, qz) vor dem Tare in das kanonische 3D-Modell-Koordinatensystem:
 *    Model_W = qw, Model_X (Roll) = -qy, Model_Y (Pitch) = +qx, Model_Z (Yaw) = +qz.
 * 2. getMountingQuaternionFromDeg(rDeg, pDeg, yDeg) erzeugt qMount direkt im 3D-Modell-Koordinatensystem:
 *    - Roll (-90°) dreht exakt um die rote Modell-X-Achse (Roll).
 *    - Pitch dreht exakt um die grüne Modell-Y-Achse (Pitch).
 *    - Yaw dreht exakt um die blaue Modell-Z-Achse (Yaw).
 * 3. Verhindert das Kreuzprodukt (Pitch_Mount x Roll_Sensor -> Yaw_Graph), sodass Kippbewegungen um die
 *    Roll-Achse zu 100% auf der roten Roll (X)-Kurve geplottet werden.
 * [DISMISSED]: Tare im ungedrehten Sensorframe vertauschte Roll/Pitch im Modal und projizierte Roll bei -90° auf Yaw.
 */
function sensorToModelQuat(qw, qx, qy, qz) {
    const norm = Math.hypot(qw, qx, qy, qz) || 1.0;
    return {
        w: qw / norm,
        x: -qy / norm, // Modell X-Achse = Roll (Rot)
        y: qx / norm,  // Modell Y-Achse = Pitch (Grün)
        z: qz / norm   // Modell Z-Achse = Yaw (Blau)
    };
}

function computeRelativeQuat(mw, mx, my, mz) {
    let w = mw, x = mx, y = my, z = mz;

    // Relatives Quaternion im 3D-Modellraum: q_rel = q_mount^-1 * q_model
    if (replayMountQuat) {
        const qw = replayMountQuat.w, qx = replayMountQuat.x, qy = replayMountQuat.y, qz = replayMountQuat.z;
        w = qw * mw + qx * mx + qy * my + qz * mz;
        x = qw * mx - qx * mw - qy * mz + qz * my;
        y = qw * my + qx * mz - qy * mw - qz * mx;
        z = qw * mz - qx * my + qy * mx - qz * mw;
    }

    const norm = Math.hypot(w, x, y, z) || 1.0;
    return { w: w / norm, x: x / norm, y: y / norm, z: z / norm };
}

function quatToEulerRawDeg(nw, nx, ny, nz) {
    const sinr_cosp = 2.0 * (nw * nx + ny * nz);
    const cosr_cosp = 1.0 - 2.0 * (nx * nx + ny * ny);
    const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180.0 / Math.PI);

    const sinp = 2.0 * (nw * ny - nz * nx);
    const clampedSinp = Math.max(-1.0, Math.min(1.0, sinp));
    const pitch = Math.asin(clampedSinp) * (180.0 / Math.PI);

    const siny_cosp = 2.0 * (nw * nz + nx * ny);
    const cosy_cosp = 1.0 - 2.0 * (ny * ny + nz * nz);
    const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180.0 / Math.PI);

    return { roll, pitch, yaw };
}


/*
 * Breadcrumb: 2026-10-16 08:40 - Canonical Principal-Angle Tare & Anti-360° Wind-Up Guard
 * [CRITICAL BUGFIX FLAG - ELIMINATE -360° EULER WIND-UP & CLAMP CORRUPTION]:
 * 1. Stores rawRoll, rawPitch, rawYaw as canonical principal angles [-180°, +180°] without unwrapAngle,
 *    preventing adoptCurrentFrameMounting() from clamping a -363.2° wind-up to -180°.
 * 2. Keeps Roll and Pitch anchored to [-180°, +180°] when within normal tilt bounds (<150°),
 *    eliminating permanent ±360° branch shifts after handling or Gimbal-lock transitions.
 * [DISMISSED]: Unconditional unwrapAngle() on rawRoll/roll/yaw across Gimbal lock caused -363.2° flat offsets.
 */
function normalizePrincipalDeg(angle) {
    if (!Number.isFinite(angle)) return 0.0;
    return ((((angle + 180.0) % 360.0) + 360.0) % 360.0) - 180.0;
}

function recalculateAllEuler() {
    if (!replayDataRaw || replayDataRaw.length === 0) return;

    let prevRoll = null, prevPitch = null, prevYaw = null;
    let activeCycle = null;

    for (let i = 0; i < replayDataRaw.length; i++) {
        const item = replayDataRaw[i];

        if (activeCycle === null || item.cycle !== activeCycle) {
            activeCycle = item.cycle;
            prevRoll = null; prevPitch = null; prevYaw = null;
        }

        // 1. Sensor-Quaternion in das 3D-Modell-Koordinatensystem überführen
        const qMod = sensorToModelQuat(item.qw, item.qx, item.qy, item.qz);

        // 2. Ungetarte Modell-Rohwinkel strikt im Hauptwertbereich [-180°, +180°] halten
        const rawE = quatToEulerRawDeg(qMod.w, qMod.x, qMod.y, qMod.z);
        item.rawRoll = normalizePrincipalDeg(rawE.roll);
        item.rawPitch = normalizePrincipalDeg(rawE.pitch);
        item.rawYaw = normalizePrincipalDeg(rawE.yaw);

        // 3. Relatives Quaternion zur gewählten Einbaulage berechnen
        const qRel = computeRelativeQuat(qMod.w, qMod.x, qMod.y, qMod.z);
        item.relQw = qRel.w;
        item.relQx = qRel.x;
        item.relQy = qRel.y;
        item.relQz = qRel.z;

        // 4. Relative Euler-Winkel extrahieren und gegen ±360° Wind-Up schützen
        const eRel = quatToEulerRawDeg(qRel.w, qRel.x, qRel.y, qRel.z);
        if (prevRoll === null) {
            item.roll = eRel.roll;
            item.pitch = eRel.pitch;
            item.yaw = eRel.yaw;
        } else {
            item.roll = unwrapAngle(eRel.roll, prevRoll);
            item.pitch = unwrapAngle(eRel.pitch, prevPitch);
            item.yaw = unwrapAngle(eRel.yaw, prevYaw);

            // Re-Anchor auf [-180°, +180°], sobald keine Überkopf-Drehung (>150°) vorliegt
            if (Math.abs(eRel.roll) < 150.0 && Math.abs(item.roll) > 180.0) {
                item.roll = eRel.roll;
            }
            if (Math.abs(eRel.pitch) < 150.0 && Math.abs(item.pitch) > 180.0) {
                item.pitch = eRel.pitch;
            }
            if (Math.abs(eRel.yaw) < 150.0 && Math.abs(item.yaw) > 180.0) {
                item.yaw = eRel.yaw;
            }
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
    mountMesh = buildFallbackHousingGroup();
    if (mountScene) mountScene.add(mountMesh);
    updateMountingPreview3D();
}

function setupMountingModelMesh(gltfScene) {
    if (!mountScene) return;
    if (mountMesh) mountScene.remove(mountMesh);

    mountMesh = normalizeAndCenterGltf(gltfScene);
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
            () => tryLoad(index + 1)
        );
    }
    tryLoad(0);
}

/*
 * Breadcrumb: 2026-10-15 22:50 - Mounting Modal Animation Loop Restart & Resize Guard
 * [CRITICAL BUGFIX FLAG - MOUNTING MODAL RENDER RESTART]:
 * Restart animation loop when modal is reopened after closeMountingConfigModal() cancelled mountAnimId.
 */
let lastMountW = 0;
let lastMountH = 0;

function resizeMounting3D() {
    const container = document.getElementById('mounting-canvas-container');
    if (!container || !mountRenderer || !mountCamera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0 && (w !== lastMountW || h !== lastMountH)) {
        lastMountW = w;
        lastMountH = h;
        mountCamera.aspect = w / h;
        mountCamera.updateProjectionMatrix();
        mountRenderer.setSize(w, h, false);
        if (mountScene) mountRenderer.render(mountScene, mountCamera);
    }
}

function startMounting3DLoop() {
    if (mountAnimId !== null) return;
    function anim() {
        const modal = document.getElementById('mounting-config-modal');
        if (!modal || modal.classList.contains('hidden')) {
            mountAnimId = null;
            return;
        }
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

function initMounting3D() {
    const container = document.getElementById('mounting-canvas-container');
    if (!container || typeof THREE === 'undefined') return;

    if (mountRenderer) {
        lastMountW = 0;
        lastMountH = 0;
        resizeMounting3D();
        startMounting3DLoop();
        return;
    }

    const w = container.clientWidth || 280;
    const h = container.clientHeight || 224;
    lastMountW = w;
    lastMountH = h;

    mountScene = new THREE.Scene();
    mountScene.background = new THREE.Color(0xdbe2ea);

    mountCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    mountCamera.position.set(2.0, 1.5, 2.4);
    mountCamera.lookAt(0, 0, 0);

    mountRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    mountRenderer.setSize(w, h, false);
    mountRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
        mountContainerObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => resizeMounting3D());
        });
        mountContainerObserver.observe(container);
    }

    startMounting3DLoop();
}

/*
 * Erzeugt das Einbaulagen-Quaternion direkt im 3D-Modell-Koordinatensystem:
 * x = Roll (X-Achse, Rot), y = Pitch (Y-Achse, Grün), z = Yaw (Z-Achse, Blau).
 */
function getMountingQuaternionFromDeg(rDeg, pDeg, yDeg) {
    const r = ((rDeg || 0) * (Math.PI / 180.0)) / 2.0;
    const p = ((pDeg || 0) * (Math.PI / 180.0)) / 2.0;
    const y = ((yDeg || 0) * (Math.PI / 180.0)) / 2.0;

    const cr = Math.cos(r), sr = Math.sin(r);
    const cp = Math.cos(p), sp = Math.sin(p);
    const cy = Math.cos(y), sy = Math.sin(y);

    return {
        w: cr * cp * cy + sr * sp * sy,
        x: sr * cp * cy - cr * sp * sy, // Modell X (Roll)
        y: cr * sp * cy + sr * cp * sy, // Modell Y (Pitch)
        z: cr * cp * sy - sr * sp * cy  // Modell Z (Yaw)
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
    applyModelQuaternionToMesh(mountMesh, qMount.w, qMount.x, qMount.y, qMount.z);

    if (mountRenderer && mountScene && mountCamera) {
        mountRenderer.render(mountScene, mountCamera);
    }
}

function syncMountingInput(axis, val) {
    const num = Math.max(-180, Math.min(180, parseFloat(val) || 0));
    const numEl = document.getElementById(`mount-${axis}-num`);
    const rngEl = document.getElementById(`mount-${axis}-range`);
    if (numEl && Number(numEl.value) !== num) numEl.value = num;
    if (rngEl && Number(rngEl.value) !== num) rngEl.value = num;
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


/*
 * Breadcrumb: 2026-10-18 20:55 - Restored adoptCurrentFrameMounting() Implementation
 * [CRITICAL BUGFIX FLAG - FIX UNCAUGHT REFERENCE ERROR ON SCRIPT LOAD]:
 * 1. Implements adoptCurrentFrameMounting() to capture the current replay frame's rawRoll,
 *    rawPitch, and rawYaw into the mounting configuration modal inputs.
 * 2. Eliminates the ReferenceError at line 1168 so saveMountingConfig() and
 *    checkAndApplySavedMounting() execute cleanly on startup.
 */
function adoptCurrentFrameMounting() {
    if (!replayFilteredData || replayFilteredData.length === 0) return;

    const dt = replaySampleIntervalSec > 0 ? replaySampleIntervalSec : 0.1;
    const idx = Math.max(0, Math.min(Math.round(replayCurrentTimeSec / dt), replayFilteredData.length - 1));
    const pt = replayFilteredData[idx];
    if (!pt) return;

    const r = Number.isFinite(pt.rawRoll) ? Number(pt.rawRoll.toFixed(1)) : 0.0;
    const p = Number.isFinite(pt.rawPitch) ? Number(pt.rawPitch.toFixed(1)) : 0.0;
    const y = Number.isFinite(pt.rawYaw) ? Number(pt.rawYaw.toFixed(1)) : 0.0;

    setMountingPreset(r, p, y);
    replayDiagLog('MOUNT-TARE', `Frame #${idx} als Einbaulage übernommen: R:${r}° P:${p}° Y:${y}°`);
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
    localStorage.setItem(`stag_mount_v2_${devId}`, JSON.stringify(replayMountConfig));

    updateMountingQuaternion();
    updateMountingButtonUI();
    recalculateAllEuler();
    replayGraphCacheKey = ''; // Cache invalidieren
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

function updateMountingQuaternion() {
    replayMountQuat = getMountingQuaternionFromDeg(
        replayMountConfig.roll,
        replayMountConfig.pitch,
        replayMountConfig.yaw
    );
}

/*
 * Breadcrumb: 2026-10-15 20:55 - Default Mounting Alignment (Roll +90°)
 * [CRITICAL CONFIG FLAG - KIPPSTATION DEFAULT ZERO BASELINE]:
 * Default-Einbaulage für Kipprahmen auf Roll +90°, Pitch 0°, Yaw 0° gesetzt.
 */
function checkAndApplySavedMounting() {
    const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
    const saved = localStorage.getItem(`stag_mount_v2_${devId}`);
    if (saved) {
        try {
            replayMountConfig = JSON.parse(saved);
        } catch (e) {
            replayMountConfig = { roll: 90.0, pitch: 0.0, yaw: 0.0 };
        }
    } else {
        // Kippstation-Standard: Roll = +90°, Pitch = 0°, Yaw = 0°
        replayMountConfig = { roll: 90.0, pitch: 0.0, yaw: 0.0 };
    }
    updateMountingQuaternion();
    updateMountingButtonUI();
    recalculateAllEuler();
}

// ============================================================================
// 4. FRAME-INTERPOLATION, 3D RENDERING & 5-ZEILEN HUD
// ============================================================================

/*
 * Wendet ein bereits im 3D-Modell-Koordinatensystem vorliegendes Quaternion (mw, mx, my, mz)
 * auf das Three.js-Mesh an (inkl. Y-Up Welt-Transformation).
 */
function applyModelQuaternionToMesh(targetMesh, mw, mx, my, mz) {
    const norm = Math.hypot(mx, my, mz, mw) || 1.0;
    const qThree = new THREE.Quaternion(mx / norm, my / norm, mz / norm, mw / norm);

    qThree.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));   // +90° Z
    qThree.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)); // -90° X

    targetMesh.quaternion.copy(qThree);
}

/*
 * Wendet ein rohes BNO085 Sensor-Quaternion (qw, qx, qy, qz) auf ein Three.js-Mesh an.
 */
function applyEspModelQuaternion(targetMesh, qw, qx, qy, qz) {
    const qMod = sensorToModelQuat(qw, qx, qy, qz);
    applyModelQuaternionToMesh(targetMesh, qMod.w, qMod.x, qMod.y, qMod.z);
}

function renderInterpolatedFrame(tSec) {
    const total = replayFilteredData.length;
    if (total === 0) return;

    ensureFrequencyBadgeDOM();

    const sampleInterval = replaySampleIntervalSec;
    const exactIndex = tSec / sampleInterval;
    const iA = Math.max(0, Math.min(Math.floor(exactIndex), total - 1));
    const iB = Math.min(iA + 1, total - 1);

    const ptA = replayFilteredData[iA];
    const ptB = replayFilteredData[iB];

    // Keine Interpolation über eine Schlafpause hinweg
    const gapBetweenFrames = ((ptB.tsMs - ptA.tsMs) / 1000.0) > REPLAY_GAP_THRESHOLD_SEC;
    const alpha = (iA === iB || gapBetweenFrames) ? 0.0 : (exactIndex - iA);

    const roll = ptA.roll + (ptB.roll - ptA.roll) * alpha;
    const pitch = ptA.pitch + (ptB.pitch - ptA.pitch) * alpha;
    const yaw = ptA.yaw + (ptB.yaw - ptA.yaw) * alpha;

    const axD = ptA.ax + (ptB.ax - ptA.ax) * alpha;
    const ayD = ptA.ay + (ptB.ay - ptA.ay) * alpha;
    const azD = ptA.az + (ptB.az - ptA.az) * alpha;

    const dxD = (ptA.dx || 0) + ((ptB.dx || 0) - (ptA.dx || 0)) * alpha;
    const dyD = (ptA.dy || 0) + ((ptB.dy || 0) - (ptA.dy || 0)) * alpha;
    const dzD = (ptA.dz || 0) + ((ptB.dz || 0) - (ptA.dz || 0)) * alpha;

    if (repMesh && repScene && repCamera) {
        const mA = sensorToModelQuat(ptA.qw, ptA.qx, ptA.qy, ptA.qz);
        const mB = sensorToModelQuat(ptB.qw, ptB.qx, ptB.qy, ptB.qz);

        const qA = new THREE.Quaternion(mA.x, mA.y, mA.z, mA.w);
        const qB = new THREE.Quaternion(mB.x, mB.y, mB.z, mB.w);

        if (qA.dot(qB) < 0) qB.set(-qB.x, -qB.y, -qB.z, -qB.w);
        qA.slerp(qB, alpha);

        qA.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));   // +90° Z
        qA.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107)); // -90° X
        repMesh.quaternion.copy(qA);

        const dispMag = Math.hypot(dxD, dyD, dzD);
        if (dispMag > 1e-4) {
            const maxRadius = 1.5;
            const refDisp = 350.0;
            const sceneDist = maxRadius * Math.tanh(dispMag / refDisp);
            const scale = sceneDist / dispMag;

            const localVec = new THREE.Vector3(
                dyD * scale,
                -dxD * scale,
                dzD * scale
            );

            localVec.applyQuaternion(repMesh.quaternion);
            repMesh.position.copy(localVec);
        } else {
            repMesh.position.set(0, 0, 0);
        }

        repRenderer.render(repScene, repCamera);
    }

    // Toolbar Frequenz-Badge aktualisieren
    const freqValEl = document.getElementById('replay-freq-val');
    if (freqValEl) {
        const curDom = ptA.freqDom || Math.max(ptA.freqX || 0, ptA.freqY || 0, ptA.freqZ || 0);
        freqValEl.innerText = curDom >= 0.15 ? `${curDom.toFixed(2)} Hz` : '-- Hz';
    }

    // HUD: 5-Zeilen-Matrix (ACHSE / ANG / HUB / ACC / FRQ)
    const hud = document.getElementById('replay-overlay-hud');
    if (hud) {
        const fmt = (v, dec) => {
            const val = Number(v) || 0;
            const clean = Math.abs(val) < 1e-4 ? 0 : val;
            return (clean >= 0 ? '+' : '') + clean.toFixed(dec);
        };

        const fX = (ptA.freqX && ptA.freqX >= 0.15) ? `${ptA.freqX.toFixed(1)}Hz` : '--';
        const fY = (ptA.freqY && ptA.freqY >= 0.15) ? `${ptA.freqY.toFixed(1)}Hz` : '--';
        const fZ = (ptA.freqZ && ptA.freqZ >= 0.15) ? `${ptA.freqZ.toFixed(1)}Hz` : '--';

        hud.innerHTML = `
            <div style="display:grid;grid-template-columns:32px 68px 68px 68px;column-gap:6px;row-gap:2px;font-family:monospace;font-size:10px;line-height:1.2;white-space:nowrap;">
                <!-- Zeile 1: Farbcodierte Achsen -->
                <div style="color:#94a3b8;font-size:9px;">ACHSE</div>
                <div style="text-align:right;color:#dc2626;font-weight:bold;font-size:9px;">● X (Roll)</div>
                <div style="text-align:right;color:#009B4C;font-weight:bold;font-size:9px;">● Y (Pitch)</div>
                <div style="text-align:right;color:#2563eb;font-weight:bold;font-size:9px;">● Z (Yaw)</div>

                <!-- Zeile 2: Winkel (ANG: Roll auf X, Pitch auf Y, Yaw auf Z) -->
                <div style="font-weight:bold;color:#334155;font-size:9px;">ANG</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(roll, 1)}°</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(pitch, 1)}°</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(yaw, 1)}°</div>

                <!-- Zeile 3: Dynamischer Schwingweg (HUB in mm) -->
                <div style="font-weight:bold;color:#334155;font-size:9px;">HUB</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(dyD, 2)}<span style="font-size:8px;color:#64748b;">mm</span></div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(dxD, 2)}<span style="font-size:8px;color:#64748b;">mm</span></div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(dzD, 2)}<span style="font-size:8px;color:#64748b;">mm</span></div>

                <!-- Zeile 4: Beschleunigung (ACC) -->
                <div style="font-weight:bold;color:#334155;font-size:9px;">ACC</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(ayD, 2)}</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(axD, 2)}</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#0f172a;">${fmt(azD, 2)}</div>

                <!-- Zeile 5: Dominante FFT-Frequenz -->
                <div style="font-weight:bold;color:#2563eb;font-size:9px;">FRQ</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#1e3a8a;">${fX}</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#1e3a8a;">${fY}</div>
                <div style="text-align:right;font-variant-numeric:tabular-nums;color:#1e3a8a;">${fZ}</div>
            </div>
        `;
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
    const maxDur = Math.max((replayFilteredData.length - 1) * replaySampleIntervalSec, 0.001);
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
        scrubber.value = Math.round(replayCurrentTimeSec / replaySampleIntervalSec);
    }

    renderInterpolatedFrame(replayCurrentTimeSec);
}

/*
 * Breadcrumb: 2026-10-15 20:15 - Adaptive Sample Interval in Scrubber & Wheel Stepping
 * [CRITICAL BUGFIX FLAG - DYNAMIC DT IN ZOOM & WHEEL]:
 * Replaced hardcoded 0.1s divisions with replaySampleIntervalSec so 25Hz logs scrub accurately.
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
                    scrubber.min = Math.floor(t1 / replaySampleIntervalSec);
                    scrubber.max = Math.ceil(t2 / replaySampleIntervalSec);
                    scrubber.value = Math.round(t1 / replaySampleIntervalSec);
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
            const stepSec = replaySampleIntervalSec;

            let newTime = replayCurrentTimeSec + (direction * stepSec);
            newTime = Math.max(tStart, Math.min(tEnd, Math.round(newTime / stepSec) * stepSec));

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

// ============================================================================
// PERFORMANCE-CACHE & OFFSCREEN-PUFFER FÜR 60-FPS OSZILLOSKOP-PLAYBACK
// ============================================================================

/*
 * Breadcrumb: 2026-10-11 15:10 - 60 FPS Offscreen Graph Caching & Peak-Preserving Min-Max Decimation
 * Breadcrumb: 2026-10-11 15:30 - Enhanced Ordinate Grid Lines & Axis Ticks
 * Breadcrumb: 2026-10-11 15:35 - Dynamic Sample-Interval Graph Plotter
 * Breadcrumb: 2026-10-15 20:15 - Measurement Gap Visualizer & Discontinuous Decimation Engine
 * [CRITICAL PERFORMANCE & VISUALIZATION FLAG - GAP MARKERS + 60 FPS DECIMATION]:
 * 1. Erkennt echte Zeitlücken (> 2.5s) zwischen Messpunkten und zeichnet gestrichelte Pausen-Bänder inkl. Dauer-Badge.
 * 2. Unterbricht den Canvas-Linienpfad (first = true) an Messpausen sowohl im Detailmodus als auch in der Min-Max-Dezimierung.
 * 3. Erweitert die Skalen-Stufen für den FFT-Schwingweg auf bis zu 500 mm.
 */
/*
 * Breadcrumb: 2026-10-11 15:10 - 60 FPS Offscreen Graph Caching & Peak-Preserving Min-Max Decimation
 * Breadcrumb: 2026-10-15 20:15 - Measurement Gap Visualizer & Discontinuous Decimation Engine
 * Breadcrumb: 2026-10-15 22:50 - Zero-Allocation Timestamp Gap Check (.tsMs) & Plot Bounds Guard
 * [CRITICAL BUGFIX FLAG - ELIMINATE MILLION DATE ALLOCATIONS IN RENDER LOOP]:
 * 1. Replaced all `new Date(replayFilteredData[k].ts).getTime()` inside drawReplayGraph() with precomputed `.tsMs`.
 * 2. Added strict guards for `plotW <= 10`, `plotH <= 10`, and finite `timeStep > 0` to prevent infinite tick loops.
 * 3. Eliminated redundant triple render calls in onReplayCycleSelect().
 * [DISMISSED]: Calling `new Date().getTime()` inside the 9x curve decimation loop caused severe GC pauses & tab crashes.
 */
/*
 * Breadcrumb: 2026-10-15 22:50 - Zero-Allocation Timestamp Gap Check (.tsMs) & Plot Bounds Guard
 * Breadcrumb: 2026-10-25 09:30 - Multi-Slot Oscillogram Bitmap Cache Lookup & Storage
 * [CRITICAL PERFORMANCE FLAG - 0.5MS OSCILLOGRAM CACHE HIT]:
 * Prüft vor dem Neuzeichnen aller 9 Kurvenzüge, ob für currentCacheKey bereits die fertigen
 * Offscreen-Bitmaps (Acc, Euler, Disp) in replayOscillogramCache liegen. Bei einem Treffer
 * entfällt das gesamte Pfad-Rendering und die Bitmaps werden direkt per GPU geblittet.
 */
function drawReplayGraph(curTimeSec) {
    const cvAcc = document.getElementById('replayGraphCanvasAcc');
    const cvEuler = document.getElementById('replayGraphCanvasEuler');
    const cvDisp = document.getElementById('replayGraphCanvasDisp');
    if (!cvAcc || !cvEuler || !cvDisp || !replayFilteredData || replayFilteredData.length < 2) return;

    attachCanvasInteraction();

    const count = replayFilteredData.length;
    const { tStart, tEnd, tSpan } = getTimeBounds();
    const dt = replaySampleIntervalSec > 0 ? replaySampleIntervalSec : 0.1;
    const startIndex = Math.max(0, Math.floor(tStart / dt) - 1);
    const endIndex = Math.min(count - 1, Math.ceil(tEnd / dt) + 1);

    const w = cvAcc.clientWidth;
    const h = cvAcc.clientHeight;
    if (w <= 54 || h <= 36) return;

    const firstTs = replayFilteredData[0]?.tsMs || 0;
    const lastTs = replayFilteredData[count - 1]?.tsMs || 0;
    const currentCacheKey = `${tStart.toFixed(3)}_${tEnd.toFixed(3)}_${w}x${h}_${replayAccThreshold}_${JSON.stringify(replayVisibleCurves)}_${count}_${dt}_${firstTs}_${lastTs}_${replayMountConfig.roll}_${replayMountConfig.pitch}_${replayMountConfig.yaw}`;

    if (currentCacheKey !== replayGraphCacheKey || !replayOffscreenAcc) {
        // 1. Prüfen, ob dieses Oszillogramm bereits im Multi-Slot Bitmap-Cache liegt
        if (replayOscillogramCache.has(currentCacheKey)) {
            const hit = replayOscillogramCache.get(currentCacheKey);
            // LRU-Position auffrischen
            replayOscillogramCache.delete(currentCacheKey);
            replayOscillogramCache.set(currentCacheKey, hit);

            replayOffscreenAcc = hit.acc;
            replayOffscreenEuler = hit.euler;
            replayOffscreenDisp = hit.disp;
            replayCachedScales = { ...hit.scales };
            replayGraphCacheKey = currentCacheKey;
        } else {
            // 2. Cache-Miss: Skalen berechnen und 3 neue Offscreen-Bitmaps rendern
            let maxAcc = 0.1, maxAngle = 0.1, maxDisp = 0.05;
            for (let i = startIndex; i <= endIndex; i++) {
                const d = replayFilteredData[i];
                if (!d) continue;
                if (replayVisibleCurves.ax) maxAcc = Math.max(maxAcc, Math.abs(d.ax || 0));
                if (replayVisibleCurves.ay) maxAcc = Math.max(maxAcc, Math.abs(d.ay || 0));
                if (replayVisibleCurves.az) maxAcc = Math.max(maxAcc, Math.abs(d.az || 0));

                if (replayVisibleCurves.pitch) maxAngle = Math.max(maxAngle, Math.abs(d.pitch || 0));
                if (replayVisibleCurves.roll) maxAngle = Math.max(maxAngle, Math.abs(d.roll || 0));
                if (replayVisibleCurves.yaw) maxAngle = Math.max(maxAngle, Math.abs(d.yaw || 0));

                if (replayVisibleCurves.dx) maxDisp = Math.max(maxDisp, Math.abs(d.dx || 0));
                if (replayVisibleCurves.dy) maxDisp = Math.max(maxDisp, Math.abs(d.dy || 0));
                if (replayVisibleCurves.dz) maxDisp = Math.max(maxDisp, Math.abs(d.dz || 0));
            }

            if (replayAccThreshold > 0 && replayAccThreshold > maxAcc && (replayVisibleCurves.ax || replayVisibleCurves.ay || replayVisibleCurves.az)) {
                maxAcc = replayAccThreshold;
            }

            replayCachedScales.scaleAcc = getNiceScale(maxAcc, 0.5, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0]);
            replayCachedScales.scaleEuler = getNiceScale(maxAngle, 2.0, [2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180]);
            replayCachedScales.scaleDisp = getNiceScale(maxDisp, 0.5, [0.2, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0, 30.0, 50.0, 100.0, 200.0, 500.0]);

            const newOffAcc = document.createElement('canvas');
            const newOffEuler = document.createElement('canvas');
            const newOffDisp = document.createElement('canvas');

            function renderStaticTier(offCv, targetCv, maxScale, unitLabel, allCurves, isBottomTier, isAccTier) {
                const tw = targetCv.clientWidth;
                const th = targetCv.clientHeight;
                if (tw <= 54 || th <= 36) return;

                offCv.width = tw;
                offCv.height = th;

                const ctx = offCv.getContext('2d');
                ctx.clearRect(0, 0, tw, th);

                const leftMargin = 44;
                const topMargin = 18;
                const bottomMargin = isBottomTier ? 16 : 8;
                const plotW = Math.max(10, tw - leftMargin);
                const plotH = Math.max(10, th - topMargin - bottomMargin);
                const midY = topMargin + plotH / 2;
                const halfH = plotH / 2;

                const activeCurves = allCurves.filter(c => replayVisibleCurves[c.key]);

                if (isAccTier && replayAccThreshold > 0 && activeCurves.length > 0) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(leftMargin, topMargin, plotW, plotH);
                    ctx.clip();
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';

                    let inPeak = false;
                    let peakStartPx = 0;

                    for (let i = startIndex; i <= endIndex; i++) {
                        const d = replayFilteredData[i];
                        const isExceeded = Math.hypot(d.ax, d.ay, d.az) >= replayAccThreshold;
                        const px = timeToX(i * dt, tw, leftMargin);

                        if (isExceeded) {
                            if (!inPeak) {
                                inPeak = true;
                                peakStartPx = px;
                            }
                        } else if (inPeak) {
                            inPeak = false;
                            const bandW = Math.max(2, px - peakStartPx);
                            ctx.fillRect(peakStartPx, topMargin, bandW, plotH);
                        }
                    }
                    if (inPeak) {
                        const endPx = timeToX(endIndex * dt, tw, leftMargin);
                        const bandW = Math.max(2, endPx - peakStartPx);
                        ctx.fillRect(peakStartPx, topMargin, bandW, plotH);
                    }
                    ctx.restore();
                }

                ctx.save();
                ctx.beginPath();
                ctx.rect(leftMargin, topMargin, plotW, plotH);
                ctx.clip();

                let lastGapBadgeX = -999;
                for (let i = startIndex; i < endIndex; i++) {
                    const gapSec = (replayFilteredData[i + 1].tsMs - replayFilteredData[i].tsMs) / 1000.0;

                    if (gapSec > REPLAY_GAP_THRESHOLD_SEC) {
                        const px = timeToX((i + 0.5) * dt, tw, leftMargin);
                        if (px >= leftMargin && px <= tw) {
                            ctx.strokeStyle = 'rgba(217, 119, 6, 0.70)';
                            ctx.lineWidth = 1.5;
                            ctx.setLineDash([3, 3]);
                            ctx.beginPath();
                            ctx.moveTo(px, topMargin);
                            ctx.lineTo(px, th - bottomMargin);
                            ctx.stroke();

                            ctx.setLineDash([]);
                            let gapText = '';
                            if (gapSec < 60) gapText = `⏸ ${Math.round(gapSec)}s`;
                            else if (gapSec < 3600) gapText = `⏸ ${(gapSec / 60).toFixed(0)}m`;
                            else gapText = `⏸ ${(gapSec / 3600).toFixed(1)}h`;

                            ctx.font = 'bold 8px monospace';
                            const txtW = ctx.measureText(gapText).width;
                            const badgeX = Math.max(leftMargin + 2, Math.min(tw - txtW - 6, px - txtW / 2 - 3));

                            if (badgeX - lastGapBadgeX >= txtW + 8) {
                                ctx.fillStyle = 'rgba(254, 243, 199, 0.95)';
                                ctx.fillRect(badgeX, topMargin + 2, txtW + 6, 12);
                                ctx.strokeStyle = 'rgba(217, 119, 6, 0.85)';
                                ctx.lineWidth = 1;
                                ctx.strokeRect(badgeX, topMargin + 2, txtW + 6, 12);

                                ctx.fillStyle = '#b45309';
                                ctx.fillText(gapText, badgeX + 3, topMargin + 11);
                                lastGapBadgeX = badgeX;
                            }
                        }
                    }
                }
                ctx.restore();

                ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(leftMargin, topMargin);
                ctx.lineTo(leftMargin, th - bottomMargin);
                ctx.stroke();

                const gridPoints = [1.0, 0.5, 0.0, -0.5, -1.0];
                ctx.font = '9px monospace';
                gridPoints.forEach(ratio => {
                    const y = midY - ratio * halfH;

                    ctx.strokeStyle = ratio === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.14)';
                    ctx.lineWidth = ratio === 0 ? 1.2 : 1.0;
                    if (ratio === 0) ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(leftMargin, y);
                    ctx.lineTo(tw, y);
                    ctx.stroke();

                    ctx.strokeStyle = 'rgba(15, 23, 42, 0.40)';
                    ctx.lineWidth = 1.2;
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(leftMargin - 5, y);
                    ctx.lineTo(leftMargin, y);
                    ctx.stroke();

                    ctx.fillStyle = ratio === 0 ? '#334155' : '#64748b';
                    ctx.font = ratio === 0 ? 'bold 9px monospace' : '9px monospace';
                    const val = ratio * maxScale;
                    const isInt = Math.abs(val - Math.round(val)) < 1e-4;
                    const str = (ratio > 0 ? '+' : '') + (isInt ? val.toFixed(0) : val.toFixed(1));

                    ctx.textAlign = 'right';
                    ctx.fillText(str, leftMargin - 7, y + 3);
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
                    ctx.moveTo(leftMargin, yPos); ctx.lineTo(tw, yPos);
                    ctx.moveTo(leftMargin, yNeg); ctx.lineTo(tw, yNeg);
                    ctx.stroke();
                    ctx.fillStyle = '#dc2626';
                    ctx.fillText(`±${replayAccThreshold.toFixed(1)}`, leftMargin + 4, yPos - 3);
                    ctx.restore();
                }

                const minPixelPerTick = 75;
                const maxTicks = Math.max(2, Math.floor(plotW / minPixelPerTick));
                const rawStep = Math.max(0.005, tSpan / maxTicks);
                const niceIntervals = [0.01, 0.02, 0.04, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
                const timeStep = Math.max(0.01, niceIntervals.find(s => s >= rawStep) || Math.ceil(rawStep / 60) * 60 || 1.0);
                const firstTick = Math.ceil(tStart / timeStep) * timeStep;

                ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)';
                ctx.fillStyle = '#94a3b8';
                let lastLabelX = -999;
                for (let t = firstTick; t <= tEnd; t += timeStep) {
                    const px = timeToX(t, tw, leftMargin);
                    if (px >= leftMargin && px <= tw) {
                        ctx.beginPath();
                        ctx.moveTo(px, topMargin); ctx.lineTo(px, th - bottomMargin);
                        ctx.stroke();

                        if (isBottomTier) {
                            const labelText = timeStep < 0.1 ? t.toFixed(2) + 's' : (timeStep < 1.0 ? t.toFixed(1) + 's' : Math.round(t) + 's');
                            const textWidth = ctx.measureText(labelText).width;
                            if (px - lastLabelX >= textWidth + 10 && (px + textWidth) <= (tw - 35)) {
                                ctx.fillText(labelText, px + 2, th - 4);
                                lastLabelX = px;
                            }
                        }
                    }
                }

                const visibleCount = endIndex - startIndex + 1;
                const needsDecimation = visibleCount > (plotW * 2);

                activeCurves.forEach(({ key, color }) => {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(leftMargin, topMargin, plotW, plotH);
                    ctx.clip();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.8;
                    ctx.beginPath();

                    if (needsDecimation) {
                        const bucketSize = visibleCount / plotW;
                        let first = true;
                        let prevBucketEndIdx = startIndex;

                        for (let b = 0; b < plotW; b++) {
                            const iStart = Math.min(endIndex, startIndex + Math.floor(b * bucketSize));
                            const iEnd = Math.min(endIndex, startIndex + Math.floor((b + 1) * bucketSize));

                            let minVal = Infinity, maxVal = -Infinity;
                            let minIdx = iStart, maxIdx = iStart;
                            let hasGapInBucket = false;

                            const checkFrom = Math.max(startIndex + 1, prevBucketEndIdx + 1);
                            for (let k = checkFrom; k <= iEnd; k++) {
                                if ((replayFilteredData[k].tsMs - replayFilteredData[k - 1].tsMs) > 2500) {
                                    hasGapInBucket = true;
                                    break;
                                }
                            }

                            for (let k = iStart; k <= iEnd; k++) {
                                const val = replayFilteredData[k][key] || 0;
                                if (val < minVal) { minVal = val; minIdx = k; }
                                if (val > maxVal) { maxVal = val; maxIdx = k; }
                            }

                            prevBucketEndIdx = iEnd;
                            if (hasGapInBucket) first = true;

                            if (minVal !== Infinity) {
                                const px = leftMargin + b;
                                const pyMin = midY - (minVal / maxScale) * halfH;
                                const pyMax = midY - (maxVal / maxScale) * halfH;

                                if (first) {
                                    ctx.moveTo(px, minIdx <= maxIdx ? pyMin : pyMax);
                                    if (minVal !== maxVal) ctx.lineTo(px, minIdx <= maxIdx ? pyMax : pyMin);
                                    first = false;
                                } else {
                                    if (minIdx <= maxIdx) {
                                        ctx.lineTo(px, pyMin);
                                        if (minVal !== maxVal) ctx.lineTo(px, pyMax);
                                    } else {
                                        ctx.lineTo(px, pyMax);
                                        if (minVal !== maxVal) ctx.lineTo(px, pyMin);
                                    }
                                }
                            }
                        }
                    } else {
                        let first = true;
                        for (let i = startIndex; i <= endIndex; i++) {
                            if (i > startIndex && (replayFilteredData[i].tsMs - replayFilteredData[i - 1].tsMs) > 2500) {
                                first = true;
                            }

                            const px = timeToX(i * dt, tw, leftMargin);
                            const py = midY - ((replayFilteredData[i][key] || 0) / maxScale) * halfH;
                            if (first) { ctx.moveTo(px, py); first = false; }
                            else { ctx.lineTo(px, py); }
                        }
                    }
                    ctx.stroke();
                    ctx.restore();
                });
            }

            renderStaticTier(newOffAcc, cvAcc, replayCachedScales.scaleAcc, 'm/s²', [
                { key: 'ay', color: '#dc2626', label: 'ACC(X)', dec: 2 },
                { key: 'ax', color: '#009B4C', label: 'ACC(Y)', dec: 2 },
                { key: 'az', color: '#2563eb', label: 'ACC(Z)', dec: 2 }
            ], false, true);

            renderStaticTier(newOffEuler, cvEuler, replayCachedScales.scaleEuler, '°', [
                { key: 'roll', color: '#dc2626', label: 'Roll (X)', dec: 1 },
                { key: 'pitch', color: '#009B4C', label: 'Pitch (Y)', dec: 1 },
                { key: 'yaw', color: '#7c3aed', label: 'Yaw (Z)', dec: 1 }
            ], false, false);

            renderStaticTier(newOffDisp, cvDisp, replayCachedScales.scaleDisp, 'mm', [
                { key: 'dy', color: '#dc2626', label: 'Hub X', dec: 2 },
                { key: 'dx', color: '#009B4C', label: 'Hub Y', dec: 2 },
                { key: 'dz', color: '#2563eb', label: 'Hub Z', dec: 2 }
            ], true, false);

            replayOffscreenAcc = newOffAcc;
            replayOffscreenEuler = newOffEuler;
            replayOffscreenDisp = newOffDisp;
            replayGraphCacheKey = currentCacheKey;

            // Im Multi-Slot Bitmap-Cache sichern
            cacheOscillogramBitmaps(currentCacheKey, newOffAcc, newOffEuler, newOffDisp, replayCachedScales);
        }
    }

    // 2. DYNAMISCHE EBENE (Cursor & Echtzeit-Badges)
    const leftMargin = 44;
    const curTime = (curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec);
    const curExactIdx = Math.min(Math.floor(curTime / dt), count - 1);
    const curPt = replayFilteredData[Math.max(0, curExactIdx)] || replayFilteredData[0];

    function drawDynamicOverlay(cv, offCv, unitLabel, allCurves, badgeTitle, isBottomTier) {
        const cw = cv.clientWidth;
        const ch = cv.clientHeight;
        if (cw <= 0 || ch <= 0) return;
        if (cv.width !== cw) cv.width = cw;
        if (cv.height !== ch) cv.height = ch;

        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        if (offCv && offCv.width > 0 && offCv.height > 0) {
            ctx.drawImage(offCv, 0, 0);
        }

        const topMargin = 18;
        const bottomMargin = isBottomTier ? 16 : 8;
        const plotH = ch - topMargin - bottomMargin;

        if (isSelectingZoom && Math.abs(selectCurrentX - selectStartX) > 2) {
            const xMin = Math.max(leftMargin, Math.min(selectStartX, selectCurrentX));
            const xMax = Math.min(cw, Math.max(selectStartX, selectCurrentX));
            const selW = xMax - xMin;

            ctx.fillStyle = 'rgba(0, 155, 76, 0.16)';
            ctx.fillRect(xMin, topMargin, selW, plotH);
            ctx.strokeStyle = '#009B4C';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(xMin, topMargin, selW, plotH);

            if (isBottomTier) {
                const tSelA = xToTime(xMin, cw, leftMargin);
                const tSelB = xToTime(xMax, cw, leftMargin);
                ctx.fillStyle = '#009B4C';
                ctx.font = 'bold 9px monospace';
                ctx.fillText(`Δ ${(tSelB - tSelA).toFixed(2)}s`, xMin + 4, topMargin + 14);
            }
        }

        const curX = timeToX(curTime, cw, leftMargin);
        if (curX >= leftMargin && curX <= cw) {
            ctx.strokeStyle = '#d97706';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(curX, topMargin); ctx.lineTo(curX, ch - bottomMargin); ctx.stroke();
            ctx.fillStyle = '#d97706';
            ctx.beginPath(); ctx.arc(curX, topMargin + 4, 3.5, 0, Math.PI * 2); ctx.fill();
        }

        const activeCurves = allCurves.filter(c => replayVisibleCurves[c.key]);
        if (activeCurves.length > 0) {
            ctx.font = 'bold 9px monospace';
            const valInfo = activeCurves.map(c => `${c.label}: ${(curPt[c.key] || 0).toFixed(c.dec || 2)}`).join('  ');
            const fullBadge = `${badgeTitle} [${unitLabel}] | ${valInfo}`;
            const badgeW = ctx.measureText(fullBadge).width;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillRect(cw - badgeW - 14, 3, badgeW + 10, 15);
            ctx.strokeStyle = '#cbd5e1';
            ctx.strokeRect(cw - badgeW - 14, 3, badgeW + 10, 15);

            let drawX = cw - badgeW - 9;
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

    drawDynamicOverlay(cvAcc, replayOffscreenAcc, 'm/s²', [
        { key: 'ay', color: '#dc2626', label: 'ACC(X)', dec: 2 },
        { key: 'ax', color: '#009B4C', label: 'ACC(Y)', dec: 2 },
        { key: 'az', color: '#2563eb', label: 'ACC(Z)', dec: 2 }
    ], 'BESCHLEUNIGUNG', false);

    drawDynamicOverlay(cvEuler, replayOffscreenEuler, '°', [
        { key: 'roll', color: '#dc2626', label: 'Roll (X)', dec: 1 },
        { key: 'pitch', color: '#009B4C', label: 'Pitch (Y)', dec: 1 },
        { key: 'yaw', color: '#7c3aed', label: 'Yaw (Z)', dec: 1 }
    ], 'WINKEL', false);

    drawDynamicOverlay(cvDisp, replayOffscreenDisp, 'mm', [
        { key: 'dy', color: '#dc2626', label: 'Hub X', dec: 2 },
        { key: 'dx', color: '#009B4C', label: 'Hub Y', dec: 2 },
        { key: 'dz', color: '#2563eb', label: 'Hub Z', dec: 2 }
    ], 'SCHWINGWEG', true);
}

// ============================================================================
// 6. PLAYBACK CONTROLS (PLAY, PAUSE, RESET, SCRUB)
// ============================================================================

function onReplayScrub(val) {
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = parseInt(val, 10) * replaySampleIntervalSec;
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
        replayFilteredData = replayDataRaw.slice();
    } else {
        const cId = parseInt(cycleVal, 10);
        replayFilteredData = replayDataRaw.filter(d => d.cycle === cId);
    }

    if (replayFilteredData.length === 0) {
        replayFilteredData = replayDataRaw.slice();
    }

    replayCurrentTimeSec = 0.0;
    replayGraphCacheKey = '';

    const totTimeLbl = document.getElementById('replay-total-time-label');
    const durLbl = document.getElementById('replay-duration-label');
    const totalSec = Math.max(0, (replayFilteredData.length - 1) * replaySampleIntervalSec);
    if (totTimeLbl) totTimeLbl.innerText = totalSec.toFixed(1) + 's';
    if (durLbl) durLbl.innerText = totalSec.toFixed(1) + ' s';

    // resetReplayZoom setzt Scrubber-Grenzen und ruft genau einmal renderInterpolatedFrame() + drawReplayGraph() auf
    resetReplayZoom();
}
window.onReplayCycleSelect = onReplayCycleSelect;

function setReplayGraphMode(mode) {
    replayGraphMode = mode;
    drawReplayGraph(replayCurrentTimeSec);
}
window.setReplayGraphMode = setReplayGraphMode;

// ============================================================================
// 7. INGESTION & DATEI-INSPEKTION (ZEITSTEMPEL-SORTIERT)
// ============================================================================

/*
 * Breadcrumb: 2026-10-06 23:55 - Antipodal Stream Ingestion & ReferenceError Fix
 * Breadcrumb: 2026-10-06 23:58 - Deduplicated Mounting Quaternion & Forced Cycle Override
 * Breadcrumb: 2026-10-06 23:40 - Quaternion Norm Sanity Check & Zero-Order Hold
 */
// ============================================================================
// 7. INGESTION & DATEI-INSPEKTION (ZEITSTEMPEL-SORTIERT)
// ============================================================================

/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * [CRITICAL BUGFIX & REFACTORING - CHRONOLOGICAL INGESTION & CYCLE SEGMENTATION]:
 * 1. tsMs (Unix ms) wird direkt beim Parsen berechnet -> Stellt 25Hz/50Hz Auto-Detection sicher.
 * 2. Antipodale Quaternionen-Kontinuität (q · q_prev >= 0) erfolgt NACH der Zeitstempel-Sortierung,
 *    um Phasen- und Vorzeichensprünge bei asynchron eintreffenden Chunks auszuschließen.
 * 3. sortAndSegmentChronologicalData() trennt Zyklen an echten Zeitlücken (> 3.0s) und erzeugt Event-Statistiken.
 * 4. inspectImuFile() unterstützt polymorph Datei-Objekte sowie direkte URL-Strings (aus cloud-engine.js).
 */

/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * Breadcrumb: 2026-10-15 22:50 - Strict Timestamp Validation, Mid-File Header Filter & Async UI Yielding
 * [CRITICAL BUGFIX FLAG - REJECT CORRUPT CSV LINES & PREVENT UI THREAD FREEZE]:
 * 1. Rejects CSV rows where Date.parse(tsStr) is NaN or <= 0 (prevents mid-file headers or truncated SD lines
 *    from injecting bogus tsMs=0 epoch records at index 0).
 * 2. Yields to browser event loop (await yieldToMainThread()) between Fetch, Sort, FFT, and Euler stages
 *    so loading 20+ chunks in inspectImuDayMerged() never triggers the browser crash dialog.
 * [DISMISSED]: Fallback `const tsMs = isNaN(parsedMs) ? 0 : parsedMs` accepted repeated CSV headers as 1970-01-01 points.
 */
let lastIngestQuat = { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };

function yieldToMainThread() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/*
 * Breadcrumb: 2026-10-18 20:55 - Case-Insensitive CSV Header Filter & BOOT+ms Timestamp Fallback
 * [CRITICAL BUGFIX FLAG - ALLOW REPLAY OF PRE-NTP BOOT+MS LOGS & SUPPRESS HEADER WARNINGS]:
 * 1. Filters 'Timestamp' / 'timestamp' headers case-insensitively without counting them as corrupt lines.
 * 2. Parses 'BOOT+<ms>ms' timestamps into a synthetic monotonic epoch so logs recorded prior to
 *    cellular/WiFi clock sync can still be inspected and replayed in 3D.
 */
/*
 * Breadcrumb: 2026-10-18 20:55 - Case-Insensitive CSV Header Filter & BOOT+ms Timestamp Fallback
 * Breadcrumb: 2026-10-25 09:12 - Hardware BootCycle Preservation for Brownout Filtering
 * [CRITICAL BUGFIX FLAG - PRESERVE HARDWARE BOOTCYCLE COLUMN]:
 * Speichert Spalte 9 (BootCycle) explizit als 'bootCycle' im Datensatz-Objekt, bevor
 * sortAndSegmentChronologicalData() 'item.cycle' mit der Event-ID überschreibt.
 */
/*
 * Breadcrumb: 2026-10-18 20:55 - Case-Insensitive CSV Header Filter & BOOT+ms Timestamp Fallback
 * Breadcrumb: 2026-10-25 09:12 - Hardware BootCycle Preservation for Brownout Filtering
 * Breadcrumb: 2026-10-25 09:30 - Fast ISO-8601 Char-Code Timestamp Parser & Persistent Processed Cache
 * [CRITICAL PERFORMANCE & BUGFIX FLAG - 8X FASTER CSV PARSING & INSTANT REPLAY CACHE]:
 * 1. fastParseIsoUtcMs() berechnet Unix-Millisekunden für Standard-ISO-Strings ("YYYY-MM-DDTHH:MM:SS.sssZ")
 *    über direkte ASCII-Arithmetik (ca. 8x schneller als Date.parse() bei >40.000 Zeilen).
 * 2. inspectImuFile() und inspectImuDayMerged() prüfen vorab getCachedProcessedDataset():
 *    Bei einem Treffer entfallen CSV-Splitting, Sortierung und FFT/STFT komplett (< 15ms Ladezeit!).
 */
function fastParseIsoUtcMs(tsStr) {
    // Schneller Pfad für Standardformat: "2026-10-18T20:40:15.123Z" (24 Zeichen) oder "2026-10-18T20:40:15Z" (20 Zeichen)
    const len = tsStr.length;
    if ((len === 24 || len === 20) && tsStr.charCodeAt(4) === 45 && tsStr.charCodeAt(10) === 84 && tsStr.charCodeAt(len - 1) === 90) {
        const y = (tsStr.charCodeAt(0) - 48) * 1000 + (tsStr.charCodeAt(1) - 48) * 100 + (tsStr.charCodeAt(2) - 48) * 10 + (tsStr.charCodeAt(3) - 48);
        const m = (tsStr.charCodeAt(5) - 48) * 10 + (tsStr.charCodeAt(6) - 48) - 1;
        const d = (tsStr.charCodeAt(8) - 48) * 10 + (tsStr.charCodeAt(9) - 48);
        const H = (tsStr.charCodeAt(11) - 48) * 10 + (tsStr.charCodeAt(12) - 48);
        const M = (tsStr.charCodeAt(14) - 48) * 10 + (tsStr.charCodeAt(15) - 48);
        const S = (tsStr.charCodeAt(17) - 48) * 10 + (tsStr.charCodeAt(18) - 48);
        const ms = (len === 24 && tsStr.charCodeAt(19) === 46)
            ? (tsStr.charCodeAt(20) - 48) * 100 + (tsStr.charCodeAt(21) - 48) * 10 + (tsStr.charCodeAt(22) - 48)
            : 0;
        return Date.UTC(y, m, d, H, M, S, ms);
    }
    return Date.parse(tsStr);
}

function parseImuCsvRecord(line, fileIndex, forcedCycle) {
    if (!line) return null;
    const c0 = line.charCodeAt(0);
    if (c0 === 84 || c0 === 116 || c0 === 35) { // 'T', 't', '#'
        const lowerPrefix = line.substring(0, 10).toLowerCase();
        if (lowerPrefix.startsWith('timestamp') || lowerPrefix.startsWith('#')) return null;
    }

    const sep = line.indexOf(';') !== -1 ? ';' : ',';
    const parts = line.split(sep);
    if (parts.length < 8) return null;

    const tsStr = parts[0].trim();
    let parsedMs = fastParseIsoUtcMs(tsStr);

    // Fallback für Dateien, die vor der Zeitsynchronisation mit "BOOT+12345ms" aufgezeichnet wurden
    if (isNaN(parsedMs) && tsStr.startsWith('BOOT+')) {
        const bootMs = parseInt(tsStr.substring(5), 10);
        if (!isNaN(bootMs) && bootMs >= 0) {
            parsedMs = 1704067200000 + (fileIndex * 3600000) + bootMs;
        }
    }

    if (isNaN(parsedMs) || parsedMs <= 946684800000) return null;

    let qw = +parts[1];
    let qx = +parts[2];
    let qy = +parts[3];
    let qz = +parts[4];

    const ax = +parts[5];
    const ay = +parts[6];
    const az = +parts[7];

    if (isNaN(qw) || isNaN(qx) || isNaN(qy) || isNaN(qz) || isNaN(ax) || isNaN(ay) || isNaN(az)) {
        return null;
    }

    const rawNorm = Math.hypot(qw, qx, qy, qz);
    if (rawNorm < 0.85 || rawNorm > 1.15) {
        qw = lastIngestQuat.w;
        qx = lastIngestQuat.x;
        qy = lastIngestQuat.y;
        qz = lastIngestQuat.z;
    } else {
        qw /= rawNorm;
        qx /= rawNorm;
        qy /= rawNorm;
        qz /= rawNorm;
        lastIngestQuat = { w: qw, x: qx, y: qy, z: qz };
    }

    const hwBootCycle = parts[8] ? (parseInt(parts[8], 10) || 1) : 1;
    let assignedCycle = hwBootCycle;
    if (forcedCycle !== undefined && forcedCycle !== null) {
        assignedCycle = forcedCycle;
    }

    return {
        ts: tsStr,
        tsMs: parsedMs,
        qw, qx, qy, qz,
        ax, ay, az,
        roll: 0.0,
        pitch: 0.0,
        yaw: 0.0,
        cycle: assignedCycle,
        bootCycle: hwBootCycle,
        fileIndex: fileIndex
    };
}

function populateReplayCycleDropdown(chunkStats, isDayMerge) {
    const select = document.getElementById('replay-cycle-select');
    if (!select) return;

    if (isDayMerge || chunkStats.length > 1) {
        const prefixLbl = isDayMerge ? 'Gesamter Tag' : 'Ganze Datei';
        const opts = [`<option value="ALL">${prefixLbl} (${replayDataRaw.length} Punkte, ${chunkStats.length} Events)</option>`];
        for (let i = 0; i < chunkStats.length; i++) {
            const cs = chunkStats[i];
            opts.push(`<option value="${cs.cycleId}">Event #${cs.cycleId} (${cs.timeStr} Uhr - ${cs.samplesInChunk} Samples)</option>`);
        }
        select.innerHTML = opts.join('');
    } else {
        select.innerHTML = `<option value="ALL">Datei (${replayDataRaw.length} Punkte)</option>`;
    }
}




/*
 * Breadcrumb: 2026-10-25 11:45 - Oscilloscope Loading Overlay & Progress State Controller
 * [CRITICAL UX FEATURE FLAG - OSCILLOSCOPE LOADING OVERLAY]:
 * 1. Erzeugt/steuert das Lade-Overlay (#replay-osc-loading-overlay) direkt über den 3 Oszilloskopen.
 * 2. Zeigt während Fetch, Sortierung, De-Interleaving und FFT-Integration den aktuellen Schritt an.
 * 3. Garantiert das Ausblenden im finally-Block auch bei Netzwerk- oder Parser-Fehlern.
 */
function ensureReplayOscLoadingOverlayDOM() {
    let overlay = document.getElementById('replay-osc-loading-overlay');
    if (overlay) return overlay;

    const cvAcc = document.getElementById('replayGraphCanvasAcc');
    const oscCard = cvAcc ? cvAcc.closest('.bg-white.rounded-lg.border') || cvAcc.parentElement?.parentElement : null;
    if (!oscCard) return null;

    oscCard.classList.add('relative');

    overlay = document.createElement('div');
    overlay.id = 'replay-osc-loading-overlay';
    overlay.className = 'hidden absolute inset-0 z-20 bg-white/85 backdrop-blur-[2px] rounded-lg flex flex-col items-center justify-center gap-2.5 select-none transition-opacity duration-150';
    overlay.innerHTML = `
        <div class="flex items-center gap-2.5 bg-white px-4 py-2.5 rounded-xl border border-slate-300 shadow-md">
            <svg class="animate-spin h-5 w-5 text-stag-green shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <div class="flex flex-col">
                <span class="text-xs font-bold text-slate-800 uppercase tracking-wider">Oszilloskop lädt Messdaten</span>
                <span id="replay-osc-loading-text" class="text-[11px] font-mono text-slate-600">Synchronisiere Zeitreihen & Spektren...</span>
            </div>
        </div>
    `;
    oscCard.appendChild(overlay);
    return overlay;
}

function setReplayOscLoadingOverlay(visible, statusText = 'Lade Messdaten...') {
    const overlay = ensureReplayOscLoadingOverlayDOM();
    if (!overlay) return;
    const txtEl = document.getElementById('replay-osc-loading-text');
    if (txtEl && statusText) txtEl.innerText = statusText;
    if (visible) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}
window.setReplayOscLoadingOverlay = setReplayOscLoadingOverlay;

async function inspectImuFile(fileOrUrl, optionalFileName) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;

    const tStartLoad = performance.now();
    isDayMergedMode = false;
    if (replayIsPlaying) toggleReplayPlay();
    replayCurrentTimeSec = 0.0;

    deck.classList.remove('hidden');
    deck.scrollIntoView({ behavior: 'smooth' });

    const isStringUrl = typeof fileOrUrl === 'string';
    const displayFileName = isStringUrl ? (optionalFileName || 'IMU Log') : (fileOrUrl.file_name || 'IMU Log');

    const titleEl = document.getElementById('replay-file-title');
    if (titleEl) titleEl.innerText = `📄 ${displayFileName}`;
    const metaEl = document.getElementById('replay-meta-info');
    if (metaEl) metaEl.innerText = 'Lade Messdaten...';

    setReplayOscLoadingOverlay(true, `Lade ${displayFileName}...`);
    initReplay3D();

    try {
        await yieldToMainThread();
        let url = '';
        if (isStringUrl) {
            url = fileOrUrl;
        } else {
            const cleanPath = fileOrUrl.file_path.startsWith('/') ? fileOrUrl.file_path.substring(1) : fileOrUrl.file_path;
            url = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
        }

        const procCacheKey = `FILE_v6_${url}`;
        const cachedProc = await getCachedProcessedDataset(procCacheKey);

        let chunkStats = [];
        if (cachedProc) {
            replayDataRaw = cachedProc.replayDataRaw;
            chunkStats = cachedProc.chunkStats;
            replaySampleIntervalSec = cachedProc.sampleIntervalSec;
            replaySampleRateHz = cachedProc.sampleRateHz;
            checkAndApplySavedMounting();
            replayDiagLog('CACHE-HIT', `Einzeldatei ${displayFileName} in ${(performance.now() - tStartLoad).toFixed(1)} ms aus Prozess-Cache geladen.`);
        } else {
            replayDiagLog('LOAD', `Lade Einzeldatei: ${displayFileName}`);
            const text = await fetchCachedCsv(url);
            setReplayOscLoadingOverlay(true, `Parse CSV-Zeilen (${displayFileName})...`);
            await yieldToMainThread();

            const lines = text.split('\n');
            replayDataRaw = [];
            lastIngestQuat = { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };

            let skippedLines = 0;
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const item = parseImuCsvRecord(line, 0, null);
                if (item) {
                    replayDataRaw.push(item);
                } else {
                    skippedLines++;
                }
            }

            if (skippedLines > 0) {
                replayDiagLog('PARSE', `${skippedLines} ungültige/Header-Zeilen in ${displayFileName} übersprungen.`);
            }

            if (replayDataRaw.length === 0) {
                if (metaEl) metaEl.innerText = 'Keine gültigen Messzeilen gefunden.';
                replayDiagLog('PARSE-WARN', `Keine validen Messpunkte in ${displayFileName}.`, true);
                return;
            }

            setReplayOscLoadingOverlay(true, `Bereinige Überlappungen & sortiere (${replayDataRaw.length} Punkte)...`);
            await yieldToMainThread();
            chunkStats = sortAndSegmentChronologicalData();

            setReplayOscLoadingOverlay(true, `Berechne FFT-Spektren & Schwingwege (${replayDataRaw.length} Samples)...`);
            await yieldToMainThread();
            calculateAllDisplacements();
            checkAndApplySavedMounting();

            setCachedProcessedDataset(procCacheKey, {
                replayDataRaw,
                chunkStats,
                sampleIntervalSec: replaySampleIntervalSec,
                sampleRateHz: replaySampleRateHz
            });
        }

        populateReplayCycleDropdown(chunkStats, false);

        if (metaEl) {
            const dur = ((replayDataRaw.length - 1) * replaySampleIntervalSec).toFixed(1);
            metaEl.innerText = `${replayDataRaw.length} Samples | Dauer: ${dur}s @ ${replaySampleRateHz} Hz`;
        }

        onReplayCycleSelect('ALL');
    } catch (err) {
        replayDiagLog('INSPECT-ERR', `Fehler bei ${displayFileName}: ${err.message}`, true);
        if (metaEl) metaEl.innerText = 'Fehler beim Laden: ' + err.message;
    } finally {
        setReplayOscLoadingOverlay(false);
    }
}
window.inspectImuFile = inspectImuFile;

async function inspectImuDayMerged(dateStr, dayFiles) {
    const deck = document.getElementById('imu-replay-deck');
    if (!deck) return;

    const tStartLoad = performance.now();
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

    const metaEl = document.getElementById('replay-meta-info');
    if (!dayFiles || dayFiles.length === 0) {
        if (metaEl) metaEl.innerText = `Keine Chunks für ${dateStr} vorhanden.`;
        return;
    }

    const titleEl = document.getElementById('replay-file-title');
    if (titleEl) titleEl.innerText = `📅 Ganzer Tag: ${dateStr} (${dayFiles.length} Chunks)`;
    if (metaEl) metaEl.innerText = `Lade ${dayFiles.length} Archive (Cache / Cloud)...`;

    setReplayOscLoadingOverlay(true, `Lade ${dayFiles.length} Tages-Chunks für ${dateStr}...`);
    initReplay3D();

    try {
        await yieldToMainThread();
        const devId = (typeof selectedDeviceId !== 'undefined') ? selectedDeviceId : 'STAG-IMU-01';
        const totalBytesSig = dayFiles.reduce((acc, f) => acc + Number(f.file_size_bytes || 0), 0);
        const lastFileSig = dayFiles[dayFiles.length - 1]?.file_name || '';
        const procCacheKey = `DAY_v6_${devId}_${dateStr}_${dayFiles.length}_${totalBytesSig}_${lastFileSig}`;

        const cachedProc = await getCachedProcessedDataset(procCacheKey);
        let chunkStats = [];

        if (cachedProc) {
            replayDataRaw = cachedProc.replayDataRaw;
            chunkStats = cachedProc.chunkStats;
            replaySampleIntervalSec = cachedProc.sampleIntervalSec;
            replaySampleRateHz = cachedProc.sampleRateHz;
            checkAndApplySavedMounting();
            replayDiagLog('CACHE-HIT', `Tages-Merge ${dateStr} (${replayDataRaw.length} Samples) in ${(performance.now() - tStartLoad).toFixed(1)} ms aus Prozess-Cache geladen.`);
        } else {
            replayDiagLog('DAY-MERGE', `Starte Tages-Merge für ${dateStr} (${dayFiles.length} Dateien)...`);

            let loadedChunks = 0;
            const fetchPromises = dayFiles.map(async (f, idx) => {
                try {
                    const cleanPath = f.file_path.startsWith('/') ? f.file_path.substring(1) : f.file_path;
                    const url = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(cleanPath)}`;
                    const text = await fetchCachedCsv(url);
                    loadedChunks++;
                    if (loadedChunks % 5 === 0 || loadedChunks === dayFiles.length) {
                        setReplayOscLoadingOverlay(true, `Lade Chunks: ${loadedChunks} / ${dayFiles.length}...`);
                    }
                    return { file: f, fileIdx: idx, text };
                } catch (err) {
                    replayDiagLog('FETCH-WARN', `Chunk ${f.file_name} fehlgeschlagen: ${err.message}`, true);
                    return { file: f, fileIdx: idx, text: null };
                }
            });

            const results = await Promise.all(fetchPromises);
            replayDataRaw = [];
            lastIngestQuat = { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };
            let skippedTotal = 0;

            setReplayOscLoadingOverlay(true, `Parse ${dayFiles.length} Chunks...`);
            await yieldToMainThread();

            for (let rIdx = 0; rIdx < results.length; rIdx++) {
                const { fileIdx, text } = results[rIdx];
                if (!text) continue;
                const lines = text.split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    const item = parseImuCsvRecord(line, fileIdx, null);
                    if (item) {
                        replayDataRaw.push(item);
                    } else {
                        skippedTotal++;
                    }
                }
                if (rIdx % 6 === 5) await yieldToMainThread();
            }

            if (skippedTotal > 0) {
                replayDiagLog('DAY-PARSE', `${skippedTotal} ungültige/Header-Zeilen im Tages-Merge gefiltert.`);
            }

            if (replayDataRaw.length === 0) {
                if (metaEl) metaEl.innerText = 'Keine gültigen Messzeilen in den Tagesdateien gefunden.';
                return;
            }

            if (metaEl) metaEl.innerText = `Bereinige & sortiere ${replayDataRaw.length} Messpunkte...`;
            setReplayOscLoadingOverlay(true, `Filtere Brownout-Überlappungen (${replayDataRaw.length} Punkte)...`);
            await yieldToMainThread();
            chunkStats = sortAndSegmentChronologicalData();

            if (metaEl) metaEl.innerText = `Berechne FFT-Spektren & Schwingwege (${replayDataRaw.length} Samples)...`;
            setReplayOscLoadingOverlay(true, `Berechne FFT-Schwingwege (${replayDataRaw.length} Samples)...`);
            await yieldToMainThread();
            calculateAllDisplacements();

            await yieldToMainThread();
            checkAndApplySavedMounting();

            setCachedProcessedDataset(procCacheKey, {
                replayDataRaw,
                chunkStats,
                sampleIntervalSec: replaySampleIntervalSec,
                sampleRateHz: replaySampleRateHz
            });
        }

        if (metaEl) {
            const dur = ((replayDataRaw.length - 1) * replaySampleIntervalSec).toFixed(1);
            metaEl.innerText = `${replayDataRaw.length} Samples (${chunkStats.length} Events) | Aktive Messzeit: ${dur}s @ ${replaySampleRateHz} Hz`;
        }

        populateReplayCycleDropdown(chunkStats, true);
        onReplayCycleSelect('ALL');
        replayDiagLog('DAY-MERGE', `Tages-Merge ${dateStr} bereit (${replayDataRaw.length} Punkte, ${chunkStats.length} Events, ${(performance.now() - tStartLoad).toFixed(1)} ms).`);
    } catch (err) {
        replayDiagLog('DAY-MERGE-ERR', `Absturz beim Tages-Merge ${dateStr}: ${err.message}`, true);
        if (metaEl) metaEl.innerText = 'Fehler beim Laden: ' + err.message;
    } finally {
        setReplayOscLoadingOverlay(false);
    }
}
window.inspectImuDayMerged = inspectImuDayMerged;
/*
 * Sortiert alle geladenen Messwerte chronologisch nach tsMs, glättet die Quaternionen
 * in korrekter Reihenfolge und vergibt dynamische Zyklus-IDs bei Messpausen > 3.0s.
 */
/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * Breadcrumb: 2026-10-25 09:12 - Pre-Sort Brownout 12:00 UTC Segment Filter & Deduplication
 * [CRITICAL BUGFIX FLAG - ELIMINATE INTERLEAVED 12:00 UTC BROWNOUT REBOOTS]:
 * 1. Zerlegt replayDataRaw VOR dem Sortieren entlang der Einlesereihenfolge in zusammenhängende
 *    Aufzeichnungs-Runs (trennt bei Zeit-Rückwärtssprüngen, Lücken > 3s, BootCycle-Wechsel oder Dateiwechsel).
 * 2. Erkennt Runs, die im 12:00:00 - 12:01:59 UTC Fallback-Fenster starten, und filtert sie heraus,
 *    sobald mehrere 12:00-UTC-Neustarts vorliegen oder echte synchronisierte Messreihen existieren.
 * 3. Entfernt nach dem Sortieren exakt doppelte Zeitstempel (dt <= 0), um FFT-Singularitäten zu verhindern.
 * [DISMISSED]: Blindes replayDataRaw.sort() vor dem Filtern verschränkte mehrere 12:00-UTC-Brownouts ineinander.
 */
/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * Breadcrumb: 2026-10-25 09:12 - Pre-Sort Brownout 12:00 UTC Segment Filter & Deduplication
 * Breadcrumb: 2026-10-25 09:47 - Quaternion Stream De-Interleaver, Clock-Jump Stitcher & Overlap Filter
 * [CRITICAL BUGFIX FLAG - ELIMINATE INTERWEAVING OF OVERLAPPING CHUNKS & NTP CLOCK JUMPS]:
 * 1. Entflechtet verschränkte Datenströme anhand der normierten Quaternionen-Winkeldistanz (< 0.8°)
 *    in physikalisch zusammenhängende Runs, bevor nach Zeitstempeln sortiert wird.
 * 2. Erkennt rückwärts gerichtete Uhrzeitsprünge (NITZ/SNTP Sync), bei denen das Ende von Run A
 *    geometrisch nahtlos (< 0.5°) an den Beginn von Run B anschließt, und korrigiert den Pre-Sync-Offset.
 * 3. Filtert verbleibende Zeitüberlappungen zwischen Runs strikt zugunsten des dominanten (längeren)
 *    Streams aus, sodass niemals zwei Kurvenzüge im Oszilloskop ineinander verzahnt werden.
 * [DISMISSED]: Globales replayDataRaw.sort((a, b) => a.tsMs - b.tsMs) ohne vorherige Überlappungsbereinigung.
 */
function quatAngularDistDeg(a, b) {
    const normA = Math.hypot(a.qw, a.qx, a.qy, a.qz) || 1.0;
    const normB = Math.hypot(b.qw, b.qx, b.qy, b.qz) || 1.0;
    const dot = Math.abs((a.qw * b.qw + a.qx * b.qx + a.qy * b.qy + a.qz * b.qz) / (normA * normB));
    return 2.0 * Math.acos(Math.min(1.0, Math.max(0.0, dot))) * (180.0 / Math.PI);
}

/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * Breadcrumb: 2026-10-25 09:12 - Pre-Sort Brownout 12:00 UTC Segment Filter & Deduplication
 * Breadcrumb: 2026-10-25 10:15 - Strict Monotonic Order, Time-Gap Splitting & Zero Time-Shifting
 * [CRITICAL BUGFIX FLAG - ELIMINATE ARTIFICIAL CLOCK-SHIFT DISCONTINUITIES]:
 * 1. Entfernt Stufe 3a (künstliche Verschiebung von tsMs), da dies bei kontinuierlichen
 *    Kippvorgängen zu Falsch-Zuordnungen und 100-Sekunden-Rücksprüngen führte.
 * 2. Bereinigt doppelte/überlappende Samples streng chronologisch über tsMs ohne Zeitmanipulation.
 * 3. Teilt Events sauber an echten Messpausen (> 3.0 s) oder Zeitrücksprüngen auf.
 * [DISMISSED]: Manuelle Manipulation von tsMs (shiftMs) bei scheinbaren Uhrsprüngen.
 */
/*
 * Breadcrumb: 2026-10-15 20:30 - Precomputed tsMs & Post-Sort Quaternion Continuity Engine
 * Breadcrumb: 2026-10-25 09:12 - Pre-Sort Brownout 12:00 UTC Segment Filter & Deduplication
 * Breadcrumb: 2026-10-25 11:45 - Pre-Sort Monotonic Run Splitter, Overlap Resolver & Quaternion Spike Median Filter
 * [CRITICAL BUGFIX FLAG - ELIMINATE BROWNOUT TIMESTAMP OVERLAPS & INTERLEAVED ANGLE SPIKES]:
 * 1. Zerlegt die Rohdaten VOR dem globalen Sortieren entlang der Datei-/Zeilenreihenfolge in
 *    streng monotone Sequenzen (Runs). Springt die Uhr innerhalb einer Datei oder zwischen
 *    aufeinanderfolgenden Chunks rückwärts (z. B. -6.8s nach Brownout-Reset auf altes rtcLastValidEpoch),
 *    wird dort ein neuer Run begonnen.
 * 2. Überlappen sich zwei Runs zeitlich (Run B startet vor dem Ende von Run A):
 *    - Schließt Run B geometrisch nahtlos (< 1.2° Quaternionen-Distanz) an das Ende von Run A an
 *      (typischer Brownout-Reset während einer Kippbewegung), werden die bereits durch Run A
 *      abgedeckten überlappenden Zeitstempel bzw. der rückdatierte Versatz sauber bereinigt,
 *      sodass niemals zwei Kurvenzüge im selben Zeitfenster gegeneinander verzahnt werden.
 * 3. Falls bereits vorab gemergte/interleavte Daten geladen werden, trennt ein Trajectory-Tracker
 *    alternierende Kamm-Ausreißer (> 1.5° Hin- und Herspringen bei dt < 35 ms) und glättet
 *    isolierte 1-Sample-Quaternionen-Spikes per 3-Punkt-Nachbarschafts-Slerp.
 * [DISMISSED]: Blindes replayDataRaw.sort((a, b) => a.tsMs - b.tsMs) vor der Run-Segmentierung.
 */
function sortAndSegmentChronologicalData() {
    if (!replayDataRaw || replayDataRaw.length === 0) return [];

    // 1. 12:00 UTC Kaltstart-Fallback vorab prüfen und ausfiltern
    function isSampleAt12UtcFallback(pt) {
        if (!pt) return false;
        if (pt.ts && pt.ts.startsWith('BOOT+')) return true;
        const d = new Date(pt.tsMs);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        const s = d.getUTCSeconds();
        return (h === 12 && (m === 0 || (m === 1 && s <= 30)));
    }

    let has12Fallback = false;
    let hasNormalTime = false;
    for (let i = 0; i < replayDataRaw.length; i++) {
        if (isSampleAt12UtcFallback(replayDataRaw[i])) has12Fallback = true;
        else hasNormalTime = true;
        if (has12Fallback && hasNormalTime) break;
    }

    if (has12Fallback && hasNormalTime) {
        const filtered12 = [];
        let dropped12 = 0;
        for (let i = 0; i < replayDataRaw.length; i++) {
            const pt = replayDataRaw[i];
            if (isSampleAt12UtcFallback(pt) && pt.bootCycle === 1) {
                dropped12++;
                continue;
            }
            filtered12.push(pt);
        }
        if (filtered12.length > 0) {
            replayDataRaw = filtered12;
            replayDiagLog('BROWNOUT-FILTER', `${dropped12} Kaltstart-Muster bei 12:00 UTC ausgefiltert.`);
        }
    }

    // 2. Falls Daten bereits interleavt exportiert wurden (Kamm-Muster mit dt < 36 ms und Winkel-Alternierung > 1.2°),
    //    entflechte die beiden verschränkten Trajektorien in ihre ursprünglichen sequenziellen Runs:
    const rawRuns = [];
    let currentRun = [];
    let secondaryRun = [];

    for (let i = 0; i < replayDataRaw.length; i++) {
        const pt = replayDataRaw[i];
        if (currentRun.length === 0) {
            currentRun.push(pt);
            continue;
        }

        const prev = currentRun[currentRun.length - 1];
        const dtMs = pt.tsMs - prev.tsMs;

        // A) Echter Zeitrücksprung in der Datei (Brownout-Reset / NITZ-Rücksprung) oder große Pause
        if (dtMs < -20 || dtMs > 3000) {
            if (currentRun.length > 0) rawRuns.push(currentRun);
            if (secondaryRun.length > 0) {
                rawRuns.push(secondaryRun);
                secondaryRun = [];
            }
            currentRun = [pt];
            continue;
        }

        // B) Detektion bereits verschränkter Doppel-Trajektorien (wie in zoom_5580.1s-5603.7s.csv)
        const angToPrimary = quatAngularDistDeg(pt, prev);
        if (angToPrimary > 1.2 && dtMs < 45) {
            const lastSec = secondaryRun.length > 0 ? secondaryRun[secondaryRun.length - 1] : null;
            const angToSec = lastSec ? quatAngularDistDeg(pt, lastSec) : 0.0;

            if (!lastSec || angToSec < 0.8) {
                secondaryRun.push(pt);
                continue;
            }
        }

        // Falls pt näher an einer bereits laufenden secondaryRun liegt als an currentRun:
        if (secondaryRun.length > 0) {
            const lastSec = secondaryRun[secondaryRun.length - 1];
            const angToSec = quatAngularDistDeg(pt, lastSec);
            if (angToSec < angToPrimary * 0.45 && angToPrimary > 1.0) {
                secondaryRun.push(pt);
                continue;
            }
            // Wenn der Überlappungsbereich endet und die Hauptspur > 150 ms zurückliegt, wechseln:
            if (pt.tsMs - prev.tsMs > 150 && pt.tsMs - lastSec.tsMs <= 80 && angToSec < 0.8) {
                rawRuns.push(currentRun);
                currentRun = secondaryRun;
                secondaryRun = [];
                currentRun.push(pt);
                continue;
            }
        }

        currentRun.push(pt);
    }
    if (currentRun.length > 0) rawRuns.push(currentRun);
    if (secondaryRun.length > 0) rawRuns.push(secondaryRun);

    // 3. Runs nach ihrem Startzeitpunkt ordnen, aber bei Brownout-Fortsetzung (Ende Run A == Start Run B)
    //    die physikalische Reihenfolge wahren und die rückdatierten Zeitstempel nahtlos anschließen:
    rawRuns.sort((rA, rB) => rA[0].tsMs - rB[0].tsMs);

    const resolvedSamples = [];
    let stitchedBrownouts = 0;

    for (let r = 0; r < rawRuns.length; r++) {
        const run = rawRuns[r];
        if (run.length === 0) continue;

        if (resolvedSamples.length === 0) {
            for (let k = 0; k < run.length; k++) resolvedSamples.push(run[k]);
            continue;
        }

        const prevEnd = resolvedSamples[resolvedSamples.length - 1];
        const runStart = run[0];
        const overlapMs = prevEnd.tsMs - runStart.tsMs;

        if (overlapMs >= -20) {
            // Zeitliche Überlappung zwischen Ende des vorherigen Runs und Start des neuen Runs!
            const stitchAngDeg = quatAngularDistDeg(prevEnd, runStart);

            if (stitchAngDeg < 1.5 && overlapMs <= 25000) {
                // Fall 1: Nahtlose physikalische Fortsetzung nach Brownout-Uhr-Reset (z. B. 6.8s Rücksprung)!
                // Wir korrigieren den Brownout-Zeitversatz exakt um (overlapMs + 40 ms), damit die
                // kontinuierliche Kippbewegung ohne Überlappung und ohne Datenverlust weiterläuft:
                const shiftMs = overlapMs + 40;
                for (let k = 0; k < run.length; k++) {
                    run[k].tsMs += shiftMs;
                    run[k].ts = new Date(run[k].tsMs).toISOString();
                    resolvedSamples.push(run[k]);
                }
                stitchedBrownouts++;
            } else {
                // Fall 2: Echte redundante Überlappung -> Nur Samples übernehmen, die zeitlich > prevEnd.tsMs liegen
                for (let k = 0; k < run.length; k++) {
                    if (run[k].tsMs > prevEnd.tsMs + 15) {
                        resolvedSamples.push(run[k]);
                    }
                }
            }
        } else {
            for (let k = 0; k < run.length; k++) resolvedSamples.push(run[k]);
        }
    }

    if (stitchedBrownouts > 0) {
        replayDiagLog('BROWNOUT-STITCH', `${stitchedBrownouts} überlappende Brownout-Sequenz(en) nahtlos entflochten.`);
    }

    // 4. Streng monotoner Mindestabstand (>= 15 ms bei 25 Hz)
    const deduped = [resolvedSamples[0]];
    for (let i = 1; i < resolvedSamples.length; i++) {
        const cur = resolvedSamples[i];
        const last = deduped[deduped.length - 1];
        if (cur.tsMs - last.tsMs >= 15) {
            deduped.push(cur);
        }
    }

    // 5. Isolierte 1-Sample-Winkel-Ausreißer (Single-Sample Spike Rejection) filtern
    for (let i = 1; i < deduped.length - 1; i++) {
        const prev = deduped[i - 1];
        const cur = deduped[i];
        const next = deduped[i + 1];

        const dtPrev = cur.tsMs - prev.tsMs;
        const dtNext = next.tsMs - cur.tsMs;

        if (dtPrev < 120 && dtNext < 120) {
            const dPrev = quatAngularDistDeg(prev, cur);
            const dNext = quatAngularDistDeg(cur, next);
            const dBridge = quatAngularDistDeg(prev, next);

            // Wenn cur um > 1.2° von beiden Nachbarn abweicht, prev und next aber < 0.6° zusammenliegen:
            if (dPrev > 1.2 && dNext > 1.2 && dBridge < 0.6) {
                let nw = prev.qw + next.qw;
                let nx = prev.qx + next.qx;
                let ny = prev.qy + next.qy;
                let nz = prev.qz + next.qz;
                if (prev.qw * next.qw + prev.qx * next.qx + prev.qy * next.qy + prev.qz * next.qz < 0) {
                    nw = prev.qw - next.qw;
                    nx = prev.qx - next.qx;
                    ny = prev.qy - next.qy;
                    nz = prev.qz - next.qz;
                }
                const norm = Math.hypot(nw, nx, ny, nz) || 1.0;
                cur.qw = nw / norm;
                cur.qx = nx / norm;
                cur.qy = ny / norm;
                cur.qz = nz / norm;
            }
        }
    }

    replayDataRaw = deduped;

    // 6. Antipodale Quaternionen-Kontinuität & Event-Segmentierung (an echten Lücken > 3.0 s)
    let currentCycleId = 1;
    const chunkStats = [];
    let samplesInCurrentCycle = 0;
    let cycleStartTs = replayDataRaw[0].ts;

    for (let i = 0; i < replayDataRaw.length; i++) {
        const cur = replayDataRaw[i];
        if (i > 0) {
            const prev = replayDataRaw[i - 1];
            const gapSec = (cur.tsMs - prev.tsMs) / 1000.0;

            if (gapSec > 3.0) {
                chunkStats.push({
                    cycleId: currentCycleId,
                    timeStr: formatReplayTimestamp(cycleStartTs),
                    samplesInChunk: samplesInCurrentCycle
                });
                currentCycleId++;
                samplesInCurrentCycle = 0;
                cycleStartTs = cur.ts;
            } else {
                const dot = cur.qw * prev.qw + cur.qx * prev.qx + cur.qy * prev.qy + cur.qz * prev.qz;
                if (dot < 0.0) {
                    cur.qw = -cur.qw;
                    cur.qx = -cur.qx;
                    cur.qy = -cur.qy;
                    cur.qz = -cur.qz;
                }
            }
        }
        cur.cycle = currentCycleId;
        samplesInCurrentCycle++;
    }

    if (samplesInCurrentCycle > 0) {
        chunkStats.push({
            cycleId: currentCycleId,
            timeStr: formatReplayTimestamp(cycleStartTs),
            samplesInChunk: samplesInCurrentCycle
        });
    }

    return chunkStats;
}


function exportReplayVisibleCsv() {
    if (!replayFilteredData || replayFilteredData.length === 0) {
        alert('Keine Messdaten im Oszilloskop zum Exportieren vorhanden.');
        return;
    }

    const { tStart, tEnd } = getTimeBounds();
    let exportRows = [];

    if (isReplayZoomed) {
        const startIdx = Math.max(0, Math.floor(tStart / replaySampleIntervalSec));
        const endIdx = Math.min(replayFilteredData.length - 1, Math.ceil(tEnd / replaySampleIntervalSec));
        exportRows = replayFilteredData.slice(startIdx, endIdx + 1);
    } else {
        exportRows = replayFilteredData;
    }

    if (exportRows.length === 0) {
        alert('Keine Datenpunkte im gewählten Bereich gefunden.');
        return;
    }

    const header = 'timestamp,qw,qx,qy,qz,ax,ay,az,dx_mm,dy_mm,dz_mm,freq_dom_hz,cycle\n';
    const csvContent = header + exportRows.map(r =>
        `${r.ts},${r.qw.toFixed(4)},${r.qx.toFixed(4)},${r.qy.toFixed(4)},${r.qz.toFixed(4)},${r.ax.toFixed(3)},${r.ay.toFixed(3)},${r.az.toFixed(3)},${(r.dx || 0).toFixed(2)},${(r.dy || 0).toFixed(2)},${(r.dz || 0).toFixed(2)},${(r.freqDom || 0).toFixed(2)},${r.cycle}`
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