/*
 * Breadcrumb: 2026-09-13 17:10 - Z-Up Isometric 3D Space & OrbitControls Engine
 * [CRITICAL BUGFIX FLAG - FREE 3D ORIENTATION & ORBIT CONTROLS]:
 * 1. Switched camera to Z-Up CAD perspective: camera.up.set(0, 0, 1), position (2.4, -2.8, 1.8).
 * 2. Integrated OrbitControls for full 360° mouse drag, touch rotate, and smooth damping.
 * 3. Aligned BNO085 sensor frame directly to Z-up 3D world space (correct pitch/roll/yaw response).
 * 4. Sub-pixel ground reference grid provides visual depth and spatial orientation anchors.
 * 5. Added preset switchers: ISO, TOP (Draufsicht), FRONT, SIDE, and view RESET.
 */

let scene, camera, renderer, modelMesh, controls;
let posX = 0, posY = 0, posZ = 0;
let targetQuaternion = new THREE.Quaternion(0, 0, 0, 1);
let lastGraphDrawTime = 0;

function createFallbackCube() {
    if (modelMesh && scene) scene.remove(modelMesh);
    // Z-Up Maße: X=1.8 (Länge), Y=0.9 (Breite), Z=0.35 (Dicke / Gehäusehöhe)
    const geo = new THREE.BoxGeometry(1.8, 0.9, 0.35);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x009B4C,
        metalness: 0.3,
        roughness: 0.4
    });
    modelMesh = new THREE.Mesh(geo, mat);
    scene.add(modelMesh);
}

function setupModelMesh(gltfScene) {
    if (modelMesh && scene) scene.remove(modelMesh);

    // Bounding-Box berechnen & geometrisches Zentrum ermitteln
    const box = new THREE.Box3().setFromObject(gltfScene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // CAD-Materialien absichern (beidseitig sichtbar gegen invertierte Normalen)
    gltfScene.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.side = THREE.DoubleSide;
        }
    });

    const group = new THREE.Group();
    if (maxDim > 0) {
        const s = 1.8 / maxDim;
        gltfScene.scale.set(s, s, s);

        // Falls GLTF aus Inventor Y-Up exportiert hat (Dicke liegt auf Y):
        // Um 90° um X kippen, damit die Dicke entlang der Z-Achse (oben) liegt.
        if (size.y < size.z) {
            gltfScene.rotation.x = Math.PI / 2;
        }
        gltfScene.position.set(-center.x * s, -center.y * s, -center.z * s);
    }
    group.add(gltfScene);

    modelMesh = group;
    scene.add(modelMesh);
}

function loadGLBModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
        createFallbackCube();
        return;
    }
    const loader = new THREE.GLTFLoader();
    const candidatePaths = ['./IMU.glb', './model.glb', 'IMU.glb', 'model.glb', '/IMU.glb', '/model.glb'];

    function tryLoad(index) {
        if (index >= candidatePaths.length) {
            createFallbackCube();
            return;
        }
        loader.load(
            candidatePaths[index],
            (gltf) => {
                setupModelMesh(gltf.scene);
                console.log(`[3D] Modell erfolgreich geladen aus: ${candidatePaths[index]}`);
            },
            undefined,
            () => tryLoad(index + 1)
        );
    }
    tryLoad(0);
}

window.updateTargetOrientation = function (w, x, y, z) {
    const norm = Math.hypot(x, y, z, w) || 1.0;

    // BNO085 Rohdaten im Z-Up Koordinatensystem:
    // x = Rechts (Roll), y = Vorwärts (Pitch), z = Oben (Yaw)
    const qTarget = new THREE.Quaternion(x / norm, y / norm, z / norm, w / norm);

    // Sensor-zu-Gehäuse Offset: 90° Drehung um die Z-Achse (Sensor-Montage auf Leiterplatte)
    qTarget.multiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));

    // Antipodale Ausrichtung: Verhindert 180°-Rücksetzer bei Vorzeichenwechsel
    if (targetQuaternion.dot(qTarget) < 0) {
        qTarget.set(-qTarget.x, -qTarget.y, -qTarget.z, -qTarget.w);
    }
    targetQuaternion.copy(qTarget);
};

window.setCameraView = function (viewName) {
    if (!camera) return;

    if (viewName === 'iso' || viewName === 'reset') {
        camera.up.set(0, 0, 1);
        camera.position.set(2.4, -2.8, 1.8);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'top') {
        camera.up.set(0, 1, 0);
        camera.position.set(0, 0, 3.8);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'front') {
        camera.up.set(0, 0, 1);
        camera.position.set(0, -3.8, 0);
        camera.lookAt(0, 0, 0);
        if (controls) controls.target.set(0, 0, 0);
    } else if (viewName === 'side') {
        camera.up.set(0, 0, 1);
        camera.position.set(3.8, 0, 0);
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

    // Z-Up Kamera mit isometrischem Blickwinkel (schräg von vorne-rechts oben)
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(2.4, -2.8, 1.8);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xdbe2ea, 1.0);
    container.appendChild(renderer.domElement);

    // OrbitControls für interaktive 3D-Navigation
    if (typeof THREE.OrbitControls !== 'undefined') {
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.maxDistance = 8.0;
        controls.minDistance = 1.2;
    }

    // Beleuchtung für plastische Körperdarstellung
    const l1 = new THREE.DirectionalLight(0xffffff, 1.3);
    l1.position.set(5, -5, 7);
    scene.add(l1);

    const l2 = new THREE.DirectionalLight(0xffffff, 0.7);
    l2.position.set(-5, 5, -3);
    scene.add(l2);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));

    // Boden-Gitter als räumliche Referenzebene (XY-Ebene bei Z = -0.45)
    const grid = new THREE.GridHelper(5, 10, 0x009B4C, 0xb8c4d1);
    grid.rotation.x = Math.PI / 2; // In die XY-Ebene drehen
    grid.position.z = -0.45;
    scene.add(grid);

    createFallbackCube();
    loadGLBModel();

    window.addEventListener('resize', window.resize3DViewport);

    let lastRenderTime = performance.now();

    function animate(now) {
        requestAnimationFrame(animate);

        const curNow = (typeof now === 'number') ? now : performance.now();
        const dt = Math.min((curNow - lastRenderTime) / 1000.0, 0.1);
        lastRenderTime = curNow;

        if (controls) controls.update();

        if (modelMesh) {
            // Kontinuierliche SLERP-Interpolation
            const slerpFactor = 1.0 - Math.exp(-8.5 * dt);
            modelMesh.quaternion.slerp(targetQuaternion, slerpFactor);

            // Dynamische Stoß-Auslenkung bei Beschleunigung
            const ax = window.curAx || 0;
            const ay = window.curAy || 0;
            const az = window.curAz || 0;

            const aLen = Math.hypot(ax, ay, az);
            const axF = (aLen > 0.20) ? ax : 0;
            const ayF = (aLen > 0.20) ? ay : 0;
            const azF = (aLen > 0.20) ? az : 0;

            const aVec = new THREE.Vector3(axF, ayF, azF);
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

        // 2D-Graphen auf ~14 FPS gedrosselt (70 ms)
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