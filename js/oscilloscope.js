/*
 * Breadcrumb: 2026-09-13 17:45 - Clean 30s Time-Anchored Oscilloscope Engine
 * [CRITICAL BUGFIX FLAG - DEDUPLICATION & 30S FIXED GRID]:
 * 1. Removed duplicate drawSingleAxis and jumpAccLive function declarations.
 * 2. Default zoom locked to 300 points (30.0s time window at 10 Hz).
 * 3. Physical time-grid (-5s, -10s, -15s, -20s, -25s, -30s) locked to fixed pixel offsets.
 * 4. Fixed left-to-right sample progression: incoming live data enters at x = w
 *    and scrolls left without startup squashing or stretching.
 * 5. Robust firstPoint path clipping protects against off-screen panning tears.
 * 6. Explicit window exports for all HTML UI interaction bindings.
 */

let accZoom = 300; // 300 Punkte = 30 Sekunden Standardfenster bei 10 Hz
let accPan = 100;  // 0 bis 100% (100 = Live-Rand)
let isAccLive = true;

function onAccZoom(v) {
    accZoom = parseInt(v, 10);
    const valEl = document.getElementById('acc-zoom-val');
    if (valEl) valEl.innerText = (accZoom / 10).toFixed(0) + 's';
    updateZoomButtonsUI(accZoom / 10);
    drawAccGraphs();
}

function setAccZoomPreset(seconds) {
    const points = Math.min(Math.max(seconds * 10, 50), 600);
    accZoom = points;
    const zoomEl = document.getElementById('acc-zoom');
    if (zoomEl) zoomEl.value = points;
    const valEl = document.getElementById('acc-zoom-val');
    if (valEl) valEl.innerText = seconds + 's';
    updateZoomButtonsUI(seconds);
    drawAccGraphs();
}

function updateZoomButtonsUI(activeSec) {
    [5, 10, 30, 60].forEach(s => {
        const btn = document.getElementById(`btn-zoom-${s}`);
        if (btn) {
            if (s === activeSec) {
                btn.className = "px-2 py-1 text-[11px] font-bold rounded bg-stag-green text-white shadow-sm transition";
            } else {
                btn.className = "px-2 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 shadow-sm transition";
            }
        }
    });
}

function onAccPan(v) {
    accPan = parseFloat(v);
    isAccLive = (accPan >= 99);
    const panValEl = document.getElementById('acc-pan-val');
    if (panValEl) panValEl.innerText = isAccLive ? 'LIVE' : accPan.toFixed(0) + '%';
    const liveBtn = document.getElementById('btn-acc-live');
    if (liveBtn) {
        liveBtn.style.backgroundColor = isAccLive ? '#009B4C' : '#e2e8f0';
        liveBtn.style.color = isAccLive ? '#ffffff' : '#334155';
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
    if (!cv) return false;

    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w === 0 || h === 0) return false;

    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const leftMargin = 38;
    const plotW = w - leftMargin;

    // Feste Zeitfenster-Länge in Sekunden (Standard: 30s)
    const windowSec = accZoom / 10;

    // 1. Horizontale Amplituden-Gitterlinien
    const gridLines = [
        { ratio: 1.0, style: 'rgba(15, 23, 42, 0.09)', label: `+${maxAbs.toFixed(1)}` },
        { ratio: 0.5, style: 'rgba(15, 23, 42, 0.05)', label: `+${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: 0.0, style: 'rgba(15, 23, 42, 0.25)', label: '0.0', dashed: true },
        { ratio: -0.5, style: 'rgba(15, 23, 42, 0.05)', label: `-${(maxAbs * 0.5).toFixed(1)}` },
        { ratio: -1.0, style: 'rgba(15, 23, 42, 0.09)', label: `-${maxAbs.toFixed(1)}` }
    ];

    ctx.font = '9px monospace';
    gridLines.forEach(gl => {
        const y = midY - gl.ratio * (midY - 8);
        ctx.strokeStyle = gl.style;
        ctx.lineWidth = gl.ratio === 0 ? 1 : 0.8;
        if (gl.dashed) ctx.setLineDash([3, 3]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.fillText(gl.label, 2, y + 3);
    });
    ctx.setLineDash([]);

    // 2. Feste vertikale Zeit-Rasterlinien (bleiben an festen Pixeln stehen)
    let timeStepSec = 5;
    if (windowSec <= 5) timeStepSec = 1;
    else if (windowSec <= 15) timeStepSec = 2;
    else if (windowSec <= 35) timeStepSec = 5;
    else timeStepSec = 10;

    const numSteps = Math.floor(windowSec / timeStepSec);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.fillStyle = '#94a3b8';

    for (let t = 1; t <= numSteps; t++) {
        const secAgo = t * timeStepSec;
        const px = w - (secAgo / windowSec) * plotW;
        if (px >= leftMargin) {
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
            ctx.fillText(`-${secAgo}s`, px + 2, h - 4);
        }
    }

    const count = endIdx - startIdx;
    if (count < 2) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px monospace';
        ctx.fillText(`${label}: Signal läuft ein... (${windowSec.toFixed(0)}s Fenster)`, leftMargin + 10, midY + 4);
        return true;
    }

    // 3. Statistische Auswertung
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

    // 4. Kurvenverlauf mit festem Zeitanker zeichnen
    ctx.save();
    ctx.beginPath();
    ctx.rect(leftMargin, 0, plotW, h);
    ctx.clip();

    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 1.8;
    ctx.beginPath();

    const anchorIdx = isAccLive ? (endIdx - 1) : endIdx;
    let firstPoint = true;

    for (let i = 0; i < count; i++) {
        const pt = accHistory[startIdx + i];
        const agePoints = (anchorIdx - (startIdx + i));
        const px = w - (agePoints / accZoom) * plotW;
        const py = midY - (pt[axisKey] / maxAbs) * (midY - 8);

        if (px >= leftMargin - 10) {
            if (firstPoint) {
                ctx.moveTo(px, py);
                firstPoint = false;
            } else {
                ctx.lineTo(px, py);
            }
        }
    }
    ctx.stroke();
    ctx.restore();

    // 5. Live-Messwertanzeige
    const badgeText = `${label}  IST: ${(curVal >= 0 ? '+' : '')}${curVal.toFixed(2)} m/s² | RMS: ${rms.toFixed(2)} | P-P: ${p2p.toFixed(2)}`;
    ctx.font = 'bold 10px monospace';
    const textW = ctx.measureText(badgeText).width;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(w - textW - 14, 3, textW + 10, 16);
    ctx.strokeStyle = colorHex + '88';
    ctx.lineWidth = 1;
    ctx.strokeRect(w - textW - 14, 3, textW + 10, 16);

    ctx.fillStyle = colorHex;
    ctx.fillText(badgeText, w - textW - 9, 15);
    return true;
}

function drawAccGraphs() {
    const cvCheck = document.getElementById('cv-acc-x');
    if (!cvCheck || cvCheck.clientWidth === 0 || cvCheck.clientHeight === 0) {
        return false;
    }

    const total = accHistory.length;
    if (total < 2) {
        drawSingleAxis('cv-acc-x', 'x', '#dc2626', 'ACC X', 1.5, 0, 0);
        drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', 1.5, 0, 0);
        drawSingleAxis('cv-acc-z', 'z', '#2563eb', 'ACC Z', 1.5, 0, 0);
        return true;
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

    drawSingleAxis('cv-acc-x', 'x', '#dc2626', 'ACC X', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-y', 'y', '#009B4C', 'ACC Y', globalMax, startIdx, endIdx);
    drawSingleAxis('cv-acc-z', 'z', '#2563eb', 'ACC Z', globalMax, startIdx, endIdx);
    return true;
}

// Globale Bereitstellung für Event-Handler aus index.html
window.onAccZoom = onAccZoom;
window.setAccZoomPreset = setAccZoomPreset;
window.onAccPan = onAccPan;
window.jumpAccLive = jumpAccLive;
window.drawAccGraphs = drawAccGraphs;