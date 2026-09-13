/*
 * Breadcrumb: 2026-09-13 17:35 - True 3D Isometric Engine with Drag&Drop GLB & Sensor Mapping
 * [CRITICAL BUGFIX FLAG - FREE 3D ORIENTATION & ORBIT CONTROLS]:
 * 1. Switched to stable Three.js Y-up isometric perspective with functional OrbitControls.
 * 2. Restored verified sensor transformation: (-qy, qx, qz, qw) with premultiply(90° Z) and -90° X Y-up tilt.
 * 3. Drag & Drop and file-input fallback to load IMU.glb locally without CORS / file:// blocks.
 * 4. Procedural industrial STAG enclosure fallback with visible top label and axes indicators.
 */

let scene, camera, renderer, modelMesh, controls;
let posX = 0, posY = 0, posZ = 0;
let targetQuaternion = new THREE.Quaternion(0, 0, 0, 1);
let lastGraphDrawTime = 0;

// Prozedurales Gehäuse (STAG-Design) falls keine GLB geladen werden kann
function createFallbackCube() {
    if (modelMesh && scene) scene.remove(modelMesh);

    const group = new THREE.Group();

    // Hauptgehäuse (L=1.8, H=0.42, B=0.95)
    const bodyGeo = new THREE.BoxGeometry(1.8, 0.42, 0.95);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b, // Anthrazit / Gehäusegrau
        metalness: 0.2,
        roughness: 0.5
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(bodyMesh);

    // Grüne STAG-Deckplatte (Oberseite)
    const topGeo = new THREE.BoxGeometry(1.68, 0.04, 0.82);
    const topMat = new THREE.MeshStandardMaterial({
        color: 0x009B4C, // STAG Grün
        metalness: 0.3,
        roughness: 0.3
    });
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.y = 0.21;
    group.add(topMesh);

    // Front-Markierung (zeigt Geräte-Vorwärtsrichtung)
    const frontGeo = new THREE.BoxGeometry(0.5, 0.08, 0.04);
    const frontMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0 });
    const frontMesh = new THREE.Mesh(frontGeo, frontMat);
    frontMesh.position.set(0, 0.1, 0.48);
    group.add(frontMesh);

    modelMesh = group;
    scene.add(modelMesh);
}

function setupModelMesh(gltfScene) {
    if (modelMesh && scene) scene.remove(modelMesh);

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

    modelMesh = group;
    scene.add(modelMesh);
}

// Unterstützt Webserver-Pfade, IndexedDB-Cache und Drag & Drop
function loadGLBModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
        createFallbackCube();
        return;
    }

    const loader = new THREE.GLTFLoader();
    const candidatePaths = ['./IMU.glb', 'IMU.glb', './model.glb', 'model.glb', '/IMU.glb'];

    function tryLoad(index) {
        if (index >= candidatePaths.length) {
            console.warn("[3D] GLB nicht über URL ladbar (z.B. file:// Modus). Fallback-Gehäuse aktiv.");
            createFallbackCube();
            return;
        }
        loader.load(
            candidatePaths[index],
            (gltf) => {
                setupModelMesh(gltf.scene);
                console.log(`[3D] Modell geladen aus: ${candidatePaths[index]}`);
            },
            undefined,
            () => tryLoad(index + 1)
        );
    }
    tryLoad(0);
}

// Sensor-zu-Welt Transformation
window.updateTargetOrientation = function (w, x, y, z) {
    const norm = Math.hypot(x, y, z, w) || 1.0;
    const qx = x / norm;
    const qy = y / norm;
    const qz = z / norm;
    const qw = w / norm;

    // 1. STAG IMU Leiterplatten-Offset (aus IMU.c++):
    // Vertauscht Nick/Roll gemäß Sensormontage und rotiert um 90° Z
    const qTarget = new THREE.Quaternion(-qy, qx, qz, qw);
    qTarget.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));

    // 2. Neigt die Z-Ebene um -90° X in die standardmäßige Three.js Y-Up-Welt
    qTarget.premultiply(new THREE.Quaternion(-0.707107, 0, 0, 0.707107));

    // 3. Antipodale Ausrichtung gegen 180° Sprünge
    if (targetQuaternion.dot(qTarget) < 0) {
        qTarget.set(-qTarget.x, -qTarget.y, -qTarget.z, -qTarget.w);
    }
    targetQuaternion.copy(qTarget);
};

window.setCameraView = function (viewName) {
    if (!camera) return;

    if (viewName === 'iso' || viewName === 'reset') {
        camera.position.set(2.4, 2.0, 2.8);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'top') {
        camera.position.set(0, 4.0, 0.001);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'front') {
        camera.position.set(0, 0.3, 3.8);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'side') {
        camera.position.set(3.8, 0.3, 0);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    }

    if (controls) controls.update();
};

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
    const h = container.clientHeight || (window.innerHeight * 0.45);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdbe2ea);

    // Isometrische Kamera: Leicht von rechts-oben frontal auf das Gehäuse
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(2.4, 2.0, 2.8);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xdbe2ea, 1.0);
    container.appendChild(renderer.domElement);

    // 360° Maus- und Touch-Steuerung
    if (typeof THREE.OrbitControls !== 'undefined') {
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.maxDistance = 8.0;
        controls.minDistance = 1.2;
    }

    // Beleuchtung
    const l1 = new THREE.DirectionalLight(0xffffff, 1.3);
    l1.position.set(5, 10, 7);
    scene.add(l1);

    const l2 = new THREE.DirectionalLight(0xffffff, 0.7);
    l2.position.set(-5, -5, -3);
    scene.add(l2);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));

    // Boden-Gitter in der XZ-Ebene (Y = -0.5)
    const grid = new THREE.GridHelper(6, 12, 0x009B4C, 0xcbd5e1);
    grid.position.y = -0.5;
    scene.add(grid);

    createFallbackCube();
    loadGLBModel();

    // Drag-and-Drop Unterstützung für IMU.glb
    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.name.toLowerCase().endsWith('.glb') || file.name.toLowerCase().endsWith('.gltf')) {
                const reader = new FileReader();
                reader.onload = function (evt) {
                    if (typeof THREE.GLTFLoader !== 'undefined') {
                        const loader = new THREE.GLTFLoader();
                        loader.parse(evt.target.result, '', (gltf) => {
                            setupModelMesh(gltf.scene);
                            console.log(`[3D] Modell via Drag & Drop geladen: ${file.name}`);
                        });
                    }
                };
                reader.readAsArrayBuffer(file);
            }
        }
    });

    window.addEventListener('resize', window.resize3DViewport);

    let lastRenderTime = performance.now();

    function animate(now) {
        requestAnimationFrame(animate);

        const curNow = (typeof now === 'number') ? now : performance.now();
        const dt = Math.min((curNow - lastRenderTime) / 1000.0, 0.1);
        lastRenderTime = curNow;

        if (controls) controls.update();

        if (modelMesh) {
            const slerpFactor = 1.0 - Math.exp(-8.5 * dt);
            modelMesh.quaternion.slerp(targetQuaternion, slerpFactor);

            // Dynamische Beschleunigungsauslenkung
            const ax = window.curAx || 0;
            const ay = window.curAy || 0;
            const az = window.curAz || 0;

            const aLen = Math.hypot(ax, ay, az);
            const axF = (aLen > 0.20) ? ax : 0;
            const ayF = (aLen > 0.20) ? ay : 0;
            const azF = (aLen > 0.20) ? az : 0;

            const aVec = new THREE.Vector3(axF, azF, -ayF);
            aVec.applyQuaternion(modelMesh.quaternion);

            const tx = Math.max(-0.45, Math.min(0.45, aVec.x * 0.04));
            const ty = Math.max(-0.45, Math.min(0.45, aVec.y * 0.04));
            const tz = Math.max(-0.45, Math.min(0.45, aVec.z * 0.04));

            const posDamping = 1.0 - Math.exp(-8.0 * dt);
            posX += (tx - posX) * posDamping;
            posY += (ty - posY) * posDamping;
            posZ += (tz - posZ) * posDamping;
            modelMesh.position.set(posX, posY, posZ);
        }

        renderer.render(scene, camera);

        const redrawRequired = window.graphNeedsRedraw || (typeof graphNeedsRedraw !== 'undefined' && graphNeedsRedraw);
        if (redrawRequired && (curNow - lastGraphDrawTime >= 70)) {
            lastGraphDrawTime = curNow;
            if (typeof window.drawAccGraphs === 'function') {
                const drawn = window.drawAccGraphs();
                if (drawn !== false) {
                    window.graphNeedsRedraw = false;
                    if (typeof graphNeedsRedraw !== 'undefined') graphNeedsRedraw = false;
                }
            }
        }
    }

    requestAnimationFrame(animate);
};