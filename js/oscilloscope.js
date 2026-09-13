/*
 * Breadcrumb: 2026-09-13 09:35 - Decoupled Triple-Axis Oscilloscope Engine
 * [CRITICAL BUGFIX FLAG - OSCILLOSCOPE TIME GRID & METRICS]:
 * 1. Synchronized temporal grid lines with auto-scaling time steps (1s, 2s, 5s, 10s).
 * 2. Real-time metric badges: Peak-to-Peak, RMS, and current m/s² readout per axis.
 * 3. Zero-delay pan/zoom presets (5s, 10s, 30s, 60s) and sticky LIVE tracking anchor.
 */

let accZoom = 100; // 100 Punkte = 10 s Standardfenster
let accPan = 100;  // 0 bis 100% (100 = Live-Rand)
let isAccLive = true;

function onAccZoom(v) {
    accZoom = parseInt(v, 10);
    const valEl = document.getElementById('acc-zoom-val');
    if (valEl) valEl.innerText = (accZoom / 10).toFixed(0) + 's';
    drawAccGraphs();
}

function setAccZoomPreset(seconds) {
    const points = Math.min(Math.max(seconds * 10, 20), 600);
    accZoom = points;
    const zoomEl = document.getElementById('acc-zoom');
    if (zoomEl) zoomEl.value = points;
    const valEl = document.getElementById('acc-zoom-val');
    if (valEl) valEl.innerText = seconds + 's';
    drawAccGraphs();
}

function onAccPan(v) {
    accPan = parseFloat(v);
    isAccLive = (accPan >= 99);
    const panValEl = document.getElementById('acc-pan-val');
    if (panValEl) panValEl.innerText = isAccLive ? 'LIVE' : accPan.toFixed(0) + '%';
    const liveBtn = document.getElementById('btn-acc-live');
    if (liveBtn) {
        liveBtn.style.backgroundColor = isAccLive ? '#009B4C' : '#1f2937';
    }
    drawAccGraphs();
}

function jumpAccLive() {
    accPan = 100;
    const panEl = document.getElementById('acc-pan');
    if (panEl) panEl.value = 100;
    onAccPan(100);
}

function drawSingleAxis(cvId, axisKey, colorHex, label, maxAbs, startIdx, endIdx) {
    const cv = document.getElementById(cvId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const count = endIdx - startIdx;
    const timeWindowSec = (count > 1) ? (count / 10) : (accZoom / 10);

    const gridLines = [
        { ratio: 1.0, style: 'rgba(255,255,255,0.06)', label: `+${maxAbs.toFixed(1)}` },
        { ratio: 0.5, style: 'rgba(255,255,255,0.04)', label: `+${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: 0.0, style: 'rgba(255,255,255,0.18)', label: '0.0', dashed: true },
        { ratio: -0.5, style: 'rgba(255,255,255,0.04)', label: `-${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: -1.0, style: 'rgba(255,255,255,0.06)', label: `-${maxAbs.toFixed(1)}` }
    ];

    ctx.font = '9px monospace';
    gridLines.forEach(gl => {
        const y = midY - gl.ratio * (midY - 6);
        ctx.strokeStyle = gl.style;
        ctx.lineWidth = gl.ratio === 0 ? 1 : 0.8;
        if (gl.dashed) ctx.setLineDash([3, 3]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(32, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.fillText(gl.label, 4, y + 3);
    });
    ctx.setLineDash([]);

    let timeStepSec = 5;
    if (timeWindowSec <= 5) timeStepSec = 1;
    else if (timeWindowSec <= 15) timeStepSec = 2;
    else if (timeWindowSec <= 35) timeStepSec = 5;
    else timeStepSec = 10;

    const numTimeSteps = Math.floor(timeWindowSec / timeStepSec);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.fillStyle = '#475569';

    for (let t = 1; t <= numTimeSteps; t++) {
        const secAgo = t * timeStepSec;
        const px = w - (secAgo / timeWindowSec) * w;
        if (px > 35) {
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
            ctx.fillText(`-${secAgo}s`, px + 2, h - 4);
        }
    }

    if (count < 2) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px monospace';
        ctx.fillText(`${label}: Warte auf Sensor-Stream...`, 40, midY + 4);
        return;
    }

    let sumSq = 0;
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < count; i++) {
        const v = accHistory[startIdx + i][axisKey];
        sumSq += v * v;
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
    }
    const rms = Math.sqrt(sumSq / count);
    const p2p = maxVal - minVal;
    const curVal = accHistory[endIdx - 1][axisKey];

    ctx.save();
    ctx.beginPath();
    ctx.rect(32, 0, w - 32, h);
    ctx.clip();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, colorHex + '33');
    grad.addColorStop(0.5, colorHex + '08');
    grad.addColorStop(1, colorHex + '33');

    ctx.beginPath();
    ctx.moveTo(32, midY);
    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const px = 32 + (i / (count - 1)) * (w - 32);
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 6);
        ctx.lineTo(px, py);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const px = 32 + (i / (count - 1)) * (w - 32);
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 6);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    const badgeText = `${label}  IST: ${(curVal >= 0 ? '+' : '')}${curVal.toFixed(2)} m/s² | RMS: ${rms.toFixed(2)} | P-P: ${p2p.toFixed(2)}`;
    ctx.font = 'bold 10px monospace';
    const textW = ctx.measureText(badgeText).width;

    ctx.fillStyle = 'rgba(7, 10, 15, 0.85)';
    ctx.fillRect(w - textW - 14, 3, textW + 10, 16);
    ctx.strokeStyle = colorHex + '66';
    ctx.lineWidth = 1;
    ctx.strokeRect(w - textW - 14, 3, textW + 10, 16);

    ctx.fillStyle = colorHex;
    ctx.fillText(badgeText, w - textW - 9, 15);
}

function drawAccGraphs() {
    const total = accHistory.length;
    if (total < 2) {
        drawSingleAxis('cv-acc-x', 'x', '#ef4444', 'ACC X', 1.5, 0, 0);
        drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', 1.5, 0, 0);
        drawSingleAxis('cv-acc-z', 'z', '#3b82f6', 'ACC Z', 1.5, 0, 0);
        return;
    }

    const win = Math.min(accZoom, total);
    const maxStart = Math.max(0, total - win);
    const startIdx = isAccLive ? maxStart : Math.round((accPan / 100) * maxStart);
    const endIdx = Math.min(total, startIdx + win);

    let globalMax = 1.5;
    for (let i = startIdx; i < endIdx; i++) {
        const ax = Math.abs(accHistory[i].x);
        const ay = Math.abs(accHistory[i].y);
        const az = Math.abs(accHistory[i].z);
        if (ax > globalMax) globalMax = ax;
        if (ay > globalMax) globalMax = ay;
        if (az > globalMax) globalMax = az;
    }
    globalMax = Math.ceil(globalMax * 1.15 * 10) / 10;

    drawSingleAxis('cv-acc-x', 'x', '#ef4444', 'ACC X', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-z', 'z', '#3b82f6', 'ACC Z', globalMax, startIdx, endIdx);
}

window.drawAccGraphs = drawAccGraphs;