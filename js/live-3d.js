/*
 * Breadcrumb: 2026-09-13 09:35 - Decoupled 3D WebGL Engine & SLERP Interpolator
 * [CRITICAL BUGFIX FLAG - 3D LIFECYCLE & AXIS MAPPING]:
 * 1. Encapsulates Three.js scene, camera, and renderer with auto-resize observer.
 * 2. Exposes updateTargetOrientation() for clean decoupled updates from cloud-engine.js.
 * 3. Preserves sensor-to-model coordinate transformation (ay, -ax, az) with 0.20 m/s² deadband damping.
 * 4. Fallback cube generation if IMU.glb fails to load or WebGL context resets.
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
    // Mattgrauer Studio-Hintergrund für maximalen Kontrast zum schwarzen Gehäuse:
    scene.background = new THREE.Color(0xdbe2ea);

    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    camera.position.set(0, 0, 3.8);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xdbe2ea, 1.0);
    container.appendChild(renderer.domElement);

    // Studio-Ausleuchtung für dunkle Oberflächen
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

        const dt = Math.min((now - lastRenderTime) / 1000.0, 0.1); // Sekunden seit letztem Frame
        lastRenderTime = now;

        if (modelMesh) {
            // Frame-Rate-unabhängiger SLERP: Glättet 25-Hz-Pakete auf 60/120 FPS
            const slerpFactor = 1.0 - Math.exp(-14.0 * dt);
            modelMesh.quaternion.slerp(targetQuaternion, slerpFactor);

            // Beschleunigungs-Offset mit Federdämpfung
            const aLen = Math.hypot(curAx, curAy, curAz);
            const axF = (aLen > 0.20) ? curAx : 0;
            const ayF = (aLen > 0.20) ? curAy : 0;
            const azF = (aLen > 0.20) ? curAz : 0;

            const aVec = new THREE.Vector3(ayF, -axF, azF);
            aVec.applyQuaternion(modelMesh.quaternion);

            const tx = Math.max(-0.45, Math.min(0.45, aVec.x * 0.05));
            const ty = Math.max(-0.45, Math.min(0.45, aVec.y * 0.05));
            const tz = Math.max(-0.45, Math.min(0.45, aVec.z * 0.05));

            const posDamping = 1.0 - Math.exp(-10.0 * dt);
            posX += (tx - posX) * posDamping;
            posY += (ty - posY) * posDamping;
            posZ += (tz - posZ) * posDamping;
            modelMesh.position.set(posX, posY, posZ);
        }
        renderer.render(scene, camera);

        if (graphNeedsRedraw && (now - lastGraphDrawTime >= 35)) {
            lastGraphDrawTime = now;
            graphNeedsRedraw = false;
            if (window.drawAccGraphs) window.drawAccGraphs();
        }
    }
    requestAnimationFrame(animate);