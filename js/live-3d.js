/*
 * Breadcrumb: 2026-09-13 12:15 - Smooth WAN SLERP Engine & Render Decoupling
 * [CRITICAL BUGFIX FLAG - JITTER & HEMISPHERE FLIP RESOLUTION]:
 * 1. Antipodal sign alignment prevents 180° SLERP flip hesitation on quaternion sign inversion.
 * 2. Tuned damping factor (lambda = 8.5) eliminates bursty WAN packet stop-and-go stuttering.
 * 3. Throttled 2D acceleration graph redraws to 70 ms (~14 FPS) to keep WebGL pinned at 60 FPS.
 * 4. Added defensive fallbacks for global acceleration and redraw flags against NaN propagation.
 */

let scene, camera, renderer, modelMesh;
let posX = 0, posY = 0, posZ = 0;
let targetQuaternion = new THREE.Quaternion(0, 0, 0, 1);
let lastGraphDrawTime = 0;

function createFallbackCube() {
    if (modelMesh && scene) scene.remove(modelMesh);
    const geo = new THREE.BoxGeometry(1.8, 0.35, 0.9);
    const mat = new THREE.MeshStandardMaterial({ color: 0x009B4C, metalness: 0.3, roughness: 0.4 });
    modelMesh = new THREE.Mesh(geo, mat);
    scene.add(modelMesh);
}

/*
 * Breadcrumb: 2026-09-13 16:50 - Multi-Path GLB Loader, CAD Centering Group & Syntax Fix
 * [CRITICAL BUGFIX FLAG - GLB LOADING & ANIMATE SCOPE]:
 * 1. Fixed missing closing brace in animate() that caused fatal JavaScript parse error.
 * 2. Wraps gltfScene into THREE.Group to center CAD bounding box regardless of Inventor export origin.
 * 3. Sets DoubleSide on materials to prevent transparent back-faces on thin-walled enclosures.
 * 4. Multi-path loader fallback (./IMU.glb, ./model.glb, IMU.glb, /model.glb) with verbose error logging.
 */

function setupModelMesh(gltfScene) {
    if (modelMesh && scene) scene.remove(modelMesh);

    // Bounding-Box berechnen & geometrisches Zentrum ermitteln
    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // CAD-Materialien absichern (beidseitig sichtbar gegen invertierte Flächen)
    gltfScene.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.side = THREE.DoubleSide;
        }
    });

    // In eine übergeordnete Gruppe einbetten:
    // gltfScene wird relativ zum geometrischen Mittelpunkt verschoben.
    // Die Gruppe selbst rotiert und verschiebt sich exakt um (0,0,0).
    const group = new THREE.Group();
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        gltfScene.scale.set(s, s, s);
        gltfScene.position.set(-center.x * s, -center.y * s, -center.z * s);
    }
    group.add(gltfScene);

    modelMesh = group;
    scene.add(modelMesh);
}

function loadGLBModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
        console.warn("[3D] THREE.GLTFLoader nicht geladen. Fallback-Würfel aktiv.");
        createFallbackCube();
        return;
    }

    if (window.location.protocol === 'file:') {
        console.warn("[3D HINWEIS] Seite läuft über file:// - Browser blockieren das Laden lokaler GLB-Dateien via XHR. Bitte über lokalen Webserver (z.B. VS Code Live Server) ausführen.");
    }

    const loader = new THREE.GLTFLoader();
    const candidatePaths = ['./IMU.glb', './model.glb', 'IMU.glb', 'model.glb', '/IMU.glb', '/model.glb'];

    function tryLoad(index) {
        if (index >= candidatePaths.length) {
            console.error("[3D FEHLER] GLB-Datei unter keinem der Standardpfade gefunden. Fallback-Box aktiv.");
            createFallbackCube();
            return;
        }

        const path = candidatePaths[index];
        loader.load(
            path,
            (gltf) => {
                setupModelMesh(gltf.scene);
                console.log(`[3D] Modell erfolgreich geladen aus: ${path}`);
            },
            undefined,
            (err) => {
                console.warn(`[3D] Pfad "${path}" nicht erreichbar (${err.message || '404/CORS'}). Probiere nächsten...`);
                tryLoad(index + 1);
            }
        );
    }

    tryLoad(0);
}

window.resize3DViewport = function () {
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
    if (window.drawAccGraphs) window.drawAccGraphs();
};

window.init3D = function () {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    const w = container.clientWidth || (window.innerWidth - 30);
    const h = container.clientHeight || (window.innerHeight * 0.40);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdbe2ea);

    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(0, 0, 3.8);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xdbe2ea, 1.0);
    container.appendChild(renderer.domElement);

    const l1 = new THREE.DirectionalLight(0xffffff, 1.3);
    l1.position.set(5, 10, 7);
    scene.add(l1);

    const l2 = new THREE.DirectionalLight(0xffffff, 0.9);
    l2.position.set(-5, -10, -7);
    scene.add(l2);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));

    createFallbackCube();
    loadGLBModel();

    window.addEventListener('resize', window.resize3DViewport);

    let lastRenderTime = performance.now();

    function animate(now) {
        requestAnimationFrame(animate);

        const dt = Math.min((now - lastRenderTime) / 1000.0, 0.1);
        lastRenderTime = now;

        if (modelMesh) {
            // Glättung optimiert für WAN-Latenzschwankungen (80–120ms Paketabstand)
            // lambda = 8.5 überbrückt TCP-Jitter kontinuierlich ohne Stillstand
            const slerpFactor = 1.0 - Math.exp(-8.5 * dt);
            modelMesh.quaternion.slerp(targetQuaternion, slerpFactor);

            // Defensive Werteübernahme gegen NaN
            const ax = window.curAx || 0;
            const ay = window.curAy || 0;
            const az = window.curAz || 0;

            const aLen = Math.hypot(ax, ay, az);
            const axF = (aLen > 0.20) ? ax : 0;
            const ayF = (aLen > 0.20) ? ay : 0;
            const azF = (aLen > 0.20) ? az : 0;

            const aVec = new THREE.Vector3(ayF, -axF, azF);
            aVec.applyQuaternion(modelMesh.quaternion);

            const tx = Math.max(-0.45, Math.min(0.45, aVec.x * 0.05));
            const ty = Math.max(-0.45, Math.min(0.45, aVec.y * 0.05));
            const tz = Math.max(-0.45, Math.min(0.45, aVec.z * 0.05));

            const posDamping = 1.0 - Math.exp(-8.0 * dt);
            posX += (tx - posX) * posDamping;
            posY += (ty - posY) * posDamping;
            posZ += (tz - posZ) * posDamping;
            modelMesh.position.set(posX, posY, posZ);
        }

        renderer.render(scene, camera);

        // 2D-Graphen auf ~14 FPS gedrosselt (70 ms), entlastet den Haupt-Thread
        /*
         * Breadcrumb: 2026-09-13 16:40 - Resilient 14 FPS Canvas Redraw Engine
         * [CRITICAL BUGFIX FLAG - DUAL FLAG CHECK & LAYOUT RETRY]:
         * Checks both window.graphNeedsRedraw and lexical fallback.
         * Only clears flag if drawAccGraphs succeeded (w > 0 and h > 0).
         */
        // 2D-Graphen auf ~14 FPS gedrosselt (70 ms), entlastet den Haupt-Thread
        const redrawRequired = window.graphNeedsRedraw || (typeof graphNeedsRedraw !== 'undefined' && graphNeedsRedraw);
        if (redrawRequired && (now - lastGraphDrawTime >= 70)) {
            lastGraphDrawTime = now;
            if (typeof window.drawAccGraphs === 'function') {
                const drawn = window.drawAccGraphs();
                if (drawn !== false) {
                    window.graphNeedsRedraw = false;
                    if (typeof graphNeedsRedraw !== 'undefined') graphNeedsRedraw = false;
                }
            }
        }
    } // <-- [WICHTIGER BUGFIX]: Schließt function animate(now)
    requestAnimationFrame(animate);
};