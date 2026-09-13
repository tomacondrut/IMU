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
        console.log("[3D] IMU.glb erfolgreich geladen!");
    }, undefined, () => {
        createFallbackCube();
    });
}

window.updateTargetOrientation = function (w, x, y, z) {
    const norm = Math.hypot(x, y, z, w) || 1.0;
    const qTarget = new THREE.Quaternion(-y / norm, x / norm, z / norm, w / norm);
    qTarget.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));

    // Antipodale Ausrichtung: Verhindert 180°-Rücksetzer bei Vorzeichenwechsel
    if (targetQuaternion.dot(qTarget) < 0) {
        qTarget.set(-qTarget.x, -qTarget.y, -qTarget.z, -qTarget.w);
    }
    targetQuaternion.copy(qTarget);
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
        const redrawRequired = window.graphNeedsRedraw || false;
        if (redrawRequired && (now - lastGraphDrawTime >= 70)) {
            lastGraphDrawTime = now;
            window.graphNeedsRedraw = false;
            if (typeof window.drawAccGraphs === 'function') {
                window.drawAccGraphs();
            }
        }
    }
    requestAnimationFrame(animate);
};