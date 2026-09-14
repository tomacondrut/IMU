/*
 * Breadcrumb: 2026-09-13 09:35 - Interactive IMU Storage Browser & Replay Deck
 * [CRITICAL BUGFIX FLAG - MULTI-DEVICE STORAGE & 60 FPS REPLAY]:
 * 1. fetchImuCloudLogs() filters chunks strictly by selectedDeviceId.
 * 2. Dedicated Three.js canvas instance isolated from live viewport to prevent context thrashing.
 * 3. Sub-sample SLERP interpolation across 100ms CSV records with scrubbable timeline.
 * 4. Dual-mode curve visualizer: 3-axis Linear Acceleration vs. 3D Euler Angles (Roll, Pitch, Yaw).
 */

/*
 * Breadcrumb: 2026-09-14 19:55 - Interactive Oscilloscope Region Zoom, Pan & 0.1x Slow-Motion Replay
 * [CRITICAL BUGFIX FLAG - OSCILLOSCOPE REGION ZOOM & MICRO-ANALYSIS]:
 * 1. Region Drag-to-Zoom: Dragging across canvas selects time window [tMin, tMax]; single click seeks cursor.
 * 2. Wheel Panning: Mouse wheel over canvas smoothly pans the zoomed window left/right without resetting.
 * 3. 0.1x Ultra-Slow Motion: SLERP quaternion & linear acceleration interpolation at 60 FPS across 100ms CSV records.
 * 4. Zoom Boundary Loop: Playback cleanly loops within the selected zoom range for vibration analysis.
 * 5. Full Reset: resetReplayZoom() returns to 100% full duration view instantly.
 */

/*
 * Breadcrumb: 2026-09-14 20:10 - Consolidated Replay Engine: Region Zoom, Pan, 0.1x Slow-Mo & Accordion
 * [CRITICAL BUGFIX FLAG - REMOVE DUPLICATE FUNCTION DECLARATIONS]:
 * 1. Removed duplicate declarations of drawReplayGraph, playLoop and resetReplayPlayback.
 * 2. Unified zoom bounds calculation and canvas interaction pipeline.
 * 3. Daily log accordion and bulk controls fully integrated.
 */

let replayGraphMode = 'accel';
let replayZoomStartSec = 0.0;
let replayZoomEndSec = 0.0;
let isReplayZoomed = false;
let isSelectingZoom = false;
let selectStartX = 0;
let selectCurrentX = 0;
let canvasListenersAttached = false;

// Zoom- und Koordinatenumrechnung
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
                ? 'px-2 py-0.5 text-xs font-bold rounded bg-stag-green text-white shadow-sm transition'
                : 'px-2 py-0.5 text-xs font-bold rounded bg-slate-200 text-slate-700 hover:bg-slate-300 transition';
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
    const cv = document.getElementById('replayGraphCanvas');
    if (!cv || canvasListenersAttached) return;
    canvasListenersAttached = true;

    const leftMargin = 38;

    cv.addEventListener('mousedown', (e) => {
        const rect = cv.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        if (mouseX < leftMargin) return;

        isSelectingZoom = true;
        selectStartX = mouseX;
        selectCurrentX = mouseX;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isSelectingZoom) return;
        const cvNow = document.getElementById('replayGraphCanvas');
        if (!cvNow) return;
        const rect = cvNow.getBoundingClientRect();
        selectCurrentX = Math.max(leftMargin, Math.min(cvNow.clientWidth, e.clientX - rect.left));
        drawReplayGraph(replayCurrentTimeSec);
    });

    window.addEventListener('mouseup', (e) => {
        if (!isSelectingZoom) return;
        isSelectingZoom = false;

        const cvNow = document.getElementById('replayGraphCanvas');
        if (!cvNow) return;

        const dx = Math.abs(selectCurrentX - selectStartX);
        const w = cvNow.clientWidth;

        if (dx >= 15) {
            const t1 = xToTime(Math.min(selectStartX, selectCurrentX), w, leftMargin);
            const t2 = xToTime(Math.max(selectStartX, selectCurrentX), w, leftMargin);

            if (t2 - t1 >= 0.05) {
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
    });

    cv.addEventListener('wheel', (e) => {
        if (!isReplayZoomed) return;
        e.preventDefault();

        const { maxDur, tSpan } = getTimeBounds();
        const panDeltaSec = (e.deltaY > 0 ? 1 : -1) * (tSpan * 0.15);

        let newStart = replayZoomStartSec + panDeltaSec;
        let newEnd = replayZoomEndSec + panDeltaSec;

        if (newStart < 0) {
            newEnd -= newStart;
            newStart = 0;
        }
        if (newEnd > maxDur) {
            newStart -= (newEnd - maxDur);
            newEnd = maxDur;
            if (newStart < 0) newStart = 0;
        }

        replayZoomStartSec = newStart;
        replayZoomEndSec = newEnd;

        if (replayCurrentTimeSec < replayZoomStartSec) replayCurrentTimeSec = replayZoomStartSec;
        if (replayCurrentTimeSec > replayZoomEndSec) replayCurrentTimeSec = replayZoomEndSec;

        renderInterpolatedFrame(replayCurrentTimeSec);
    }, { passive: false });
}

function drawReplayGraph(curTimeSec) {
    const cv = document.getElementById('replayGraphCanvas');
    if (!cv || replayFilteredData.length === 0) return;

    attachCanvasInteraction();

    const w = cv.width = cv.clientWidth;
    const h = cv.height = cv.clientHeight;
    if (w === 0 || h === 0) return;

    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const count = replayFilteredData.length;
    const midY = h / 2;
    const leftMargin = 38;
    const plotW = w - leftMargin;

    if (count < 2) return;

    const { tStart, tEnd, tSpan } = getTimeBounds();

    let maxScale = 2.0;
    const isEuler = (replayGraphMode === 'euler');

    const startIndex = Math.max(0, Math.floor(tStart / 0.1) - 1);
    const endIndex = Math.min(count - 1, Math.ceil(tEnd / 0.1) + 1);

    if (!isEuler) {
        for (let i = startIndex; i <= endIndex; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.ax) > maxScale) maxScale = Math.abs(d.ax);
            if (Math.abs(d.ay) > maxScale) maxScale = Math.abs(d.ay);
            if (Math.abs(d.az) > maxScale) maxScale = Math.abs(d.az);
        }
        maxScale = Math.ceil(maxScale * 1.15 * 10) / 10;
    } else {
        maxScale = 45.0;
        for (let i = startIndex; i <= endIndex; i++) {
            const d = replayFilteredData[i];
            if (Math.abs(d.roll) > maxScale) maxScale = Math.abs(d.roll);
            if (Math.abs(d.pitch) > maxScale) maxScale = Math.abs(d.pitch);
            if (Math.abs(d.yaw) > maxScale) maxScale = Math.abs(d.yaw);
        }
        maxScale = Math.min(180.0, Math.ceil(maxScale / 15) * 15);
    }

    const gridPoints = [1.0, 0.5, 0.0, -0.5, -1.0];
    ctx.font = '9px monospace';
    gridPoints.forEach(ratio => {
        const y = midY - ratio * (midY - 8);
        ctx.strokeStyle = ratio === 0 ? 'rgba(15, 23, 42, 0.25)' : 'rgba(15, 23, 42, 0.07)';
        ctx.lineWidth = 1;
        if (ratio === 0) ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(leftMargin, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText((ratio > 0 ? '+' : '') + (ratio * maxScale).toFixed(isEuler ? 0 : 1), 2, y + 3);
    });
    ctx.setLineDash([]);

    let timeStep = 1.0;
    if (tSpan <= 0.5) timeStep = 0.05;
    else if (tSpan <= 2.0) timeStep = 0.2;
    else if (tSpan <= 5.0) timeStep = 0.5;
    else if (tSpan <= 20.0) timeStep = 2.0;
    else timeStep = 5.0;

    const firstTick = Math.ceil(tStart / timeStep) * timeStep;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.fillStyle = '#94a3b8';

    for (let t = firstTick; t <= tEnd; t += timeStep) {
        const px = timeToX(t, w, leftMargin);
        if (px >= leftMargin && px <= w) {
            ctx.beginPath();
            ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
            ctx.fillText(`${t.toFixed(tSpan <= 1 ? 2 : 1)}s`, px + 2, h - 4);
        }
    }

    const drawCurve = (key, colorHex) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(leftMargin, 0, plotW, h);
        ctx.clip();
        ctx.strokeStyle = colorHex;
        ctx.lineWidth = 1.8;
        ctx.beginPath();

        let first = true;
        for (let i = startIndex; i <= endIndex; i++) {
            const t = i * 0.1;
            const px = timeToX(t, w, leftMargin);
            const py = midY - (replayFilteredData[i][key] / maxScale) * (midY - 8);
            if (first) { ctx.moveTo(px, py); first = false; }
            else { ctx.lineTo(px, py); }
        }
        ctx.stroke();
        ctx.restore();
    };

    if (!isEuler) {
        drawCurve('ax', '#dc2626');
        drawCurve('ay', '#009B4C');
        drawCurve('az', '#2563eb');
    } else {
        drawCurve('roll', '#dc2626');
        drawCurve('pitch', '#009B4C');
        drawCurve('yaw', '#7c3aed');
    }

    ctx.font = 'bold 9px monospace';
    const legendText = isEuler ? '● Roll  ● Pitch  ● Yaw' : '● ACC X  ● ACC Y  ● ACC Z';
    const legendWidth = ctx.measureText(legendText).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(w - legendWidth - 14, 3, legendWidth + 10, 15);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(w - legendWidth - 14, 3, legendWidth + 10, 15);

    if (!isEuler) {
        ctx.fillStyle = '#dc2626'; ctx.fillText('● ACC X', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● ACC Y', w - legendWidth + 37, 14);
        ctx.fillStyle = '#2563eb'; ctx.fillText('● ACC Z', w - legendWidth + 83, 14);
    } else {
        ctx.fillStyle = '#dc2626'; ctx.fillText('● Roll', w - legendWidth - 9, 14);
        ctx.fillStyle = '#009B4C'; ctx.fillText('● Pitch', w - legendWidth + 31, 14);
        ctx.fillStyle = '#7c3aed'; ctx.fillText('● Yaw', w - legendWidth + 77, 14);
    }

    if (isSelectingZoom && Math.abs(selectCurrentX - selectStartX) > 2) {
        const xMin = Math.max(leftMargin, Math.min(selectStartX, selectCurrentX));
        const xMax = Math.min(w, Math.max(selectStartX, selectCurrentX));
        const selW = xMax - xMin;

        ctx.fillStyle = 'rgba(0, 155, 76, 0.16)';
        ctx.fillRect(xMin, 0, selW, h);
        ctx.strokeStyle = '#009B4C';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(xMin, 0, selW, h);

        const tSelA = xToTime(xMin, w, leftMargin);
        const tSelB = xToTime(xMax, w, leftMargin);
        ctx.fillStyle = '#009B4C';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`Δ ${(tSelB - tSelA).toFixed(2)}s`, xMin + 4, 18);
    }

    const curTime = (curTimeSec !== undefined ? curTimeSec : replayCurrentTimeSec);
    const curX = timeToX(curTime, w, leftMargin);

    if (curX >= leftMargin && curX <= w) {
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(curX, 0); ctx.lineTo(curX, h); ctx.stroke();
        ctx.fillStyle = '#d97706';
        ctx.beginPath(); ctx.arc(curX, 6, 4, 0, Math.PI * 2); ctx.fill();
    }
}

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
        btn.className = 'bg-stag-green text-white px-4 py-1.5 rounded text-xs font-bold hover:opacity-90 transition';
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

async function deleteImuCloudFile(filePath, fileName) {
    if (!confirm(`Möchtest du "${fileName}" (${selectedDeviceId}) wirklich aus Supabase löschen?\n\nHinweis: Die Originaldatei bleibt auf der SD-Karte des Boards erhalten.`)) {
        return;
    }

    try {
        const { error: sErr } = await sbClient.storage.from('imu-logs').remove([filePath]);
        if (sErr) throw sErr;

        const { error: dbErr } = await sbClient.from('imu_log_files').delete().eq('file_path', filePath);
        if (dbErr) throw dbErr;

        if (document.getElementById('replay-file-title').innerText === fileName) {
            closeImuReplayDeck();
        }

        fetchImuCloudLogs();
    } catch (err) {
        alert('Fehler beim Löschen: ' + (err.message || JSON.stringify(err)));
    }
}

function toggleDayCollapse(dayId) {
    const content = document.getElementById(`day-content-${dayId}`);
    const chevron = document.getElementById(`day-chevron-${dayId}`);
    if (!content) return;

    const isHidden = content.classList.toggle('hidden');
    if (chevron) {
        chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(90deg)';
    }
}

function setAllDaysCollapse(expand) {
    document.querySelectorAll('[id^="day-content-"]').forEach(el => {
        if (expand) el.classList.remove('hidden');
        else el.classList.add('hidden');
    });
    document.querySelectorAll('[id^="day-chevron-"]').forEach(chevron => {
        chevron.style.transform = expand ? 'rotate(90deg)' : 'rotate(0deg)';
    });
}

async function fetchImuCloudLogs() {
    const container = document.getElementById('imu-logs-container');
    if (!container) return;

    container.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">Lade IMU-Archive für ${selectedDeviceId}...</div>`;

    const { data, error } = await sbClient
        .from('imu_log_files')
        .select('*')
        .eq('device_id', selectedDeviceId)
        .order('uploaded_at', { ascending: false });

    if (error) {
        container.innerHTML = `<div class="p-3 bg-red-50 border border-red-300 rounded text-xs text-red-700">Fehler beim Laden: ${error.message}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `<div class="text-xs text-slate-500 py-6 text-center">Keine IMU-Dateiblöcke für ${selectedDeviceId} vorhanden.</div>`;
        return;
    }

    const groupedByDay = {};
    data.forEach(item => {
        const folder = item.day_folder || 'Unbekanntes Datum';
        if (!groupedByDay[folder]) groupedByDay[folder] = [];
        groupedByDay[folder].push(item);
    });

    const dayKeys = Object.keys(groupedByDay);

    let html = `
        <div class="flex justify-between items-center mb-3 pb-2 px-1 border-b border-slate-200">
            <span class="text-xs font-bold text-slate-700 font-mono">
                📅 ${dayKeys.length} ${dayKeys.length === 1 ? 'Tag erfasst' : 'Tage erfasst'} (${data.length} Chunks)
            </span>
            <div class="flex items-center gap-1.5">
                <button onclick="setAllDaysCollapse(true)" 
                        class="px-2 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 transition">
                    Alle auf ▾
                </button>
                <button onclick="setAllDaysCollapse(false)" 
                        class="px-2 py-1 text-[11px] font-bold rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 transition">
                    Alle zu ▴
                </button>
            </div>
        </div>
        <div class="space-y-3">
    `;

    dayKeys.forEach((day, idx) => {
        const files = groupedByDay[day];
        const totalBytes = files.reduce((sum, f) => sum + Number(f.file_size_bytes || 0), 0);
        const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
        const dayId = 'day_' + day.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isDefaultOpen = (idx === 0);

        html += `
        <div class="bg-slate-50 border border-slate-300 rounded-lg p-3 shadow-sm transition">
            <div onclick="toggleDayCollapse('${dayId}')"
                 class="flex justify-between items-center cursor-pointer select-none py-1 px-1 rounded hover:bg-slate-100 transition"
                 role="button" aria-expanded="${isDefaultOpen}">
                <div class="flex items-center gap-2 min-w-0">
                    <span id="day-chevron-${dayId}" 
                          class="text-xs text-slate-500 font-bold transition-transform duration-200 inline-block"
                          style="transform: ${isDefaultOpen ? 'rotate(90deg)' : 'rotate(0deg)'};">
                        ▶
                    </span>
                    <span class="text-green-700 font-bold text-xs truncate">📅 ${day}</span>
                    <span class="text-[11px] text-slate-500 font-mono whitespace-nowrap">(${files.length} &bull; ${totalMb} MB)</span>
                </div>
                <span class="text-[10px] text-slate-400 font-mono hidden sm:inline ml-2">Umschalten ⇄</span>
            </div>

            <div id="day-content-${dayId}" class="space-y-1.5 mt-2.5 pt-2 border-t border-slate-200 ${isDefaultOpen ? '' : 'hidden'}">
        `;

        files.forEach(f => {
            const kb = (Number(f.file_size_bytes || 0) / 1024).toFixed(1);
            const uploadTime = new Date(f.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/imu-logs/${encodeURI(f.file_path)}`;

            html += `
                <div class="flex justify-between items-center p-2 rounded bg-white border border-slate-200 text-xs font-mono hover:border-slate-400 transition shadow-sm">
                    <div class="flex items-center gap-2 truncate mr-3">
                        <span class="text-slate-800 font-semibold truncate">📄 ${f.file_name}</span>
                        <span class="text-[10px] text-slate-500 shrink-0">(${kb} KB)</span>
                    </div>
                    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
                        <span class="text-[10px] text-slate-500 hidden md:inline mr-1">${uploadTime}</span>
                        <button onclick="inspectImuFile('${downloadUrl}', '${f.file_name}')"
                                class="bg-slate-100 hover:bg-slate-200 text-green-700 border border-slate-300 px-2.5 py-1 rounded text-xs font-bold transition">
                            📊 Visualisieren
                        </button>
                        <a href="${downloadUrl}" download="${f.file_name}" target="_blank"
                           class="text-slate-600 hover:text-slate-900 border border-slate-200 rounded px-2 py-1 text-xs transition" title="Download">
                            ⬇
                        </a>
                        <button onclick="deleteImuCloudFile('${f.file_path}', '${f.file_name}')" title="Aus Cloud löschen"
                                class="text-red-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 p-1 rounded transition text-xs">
                            🗑️
                        </button>
                    </div>
                </div>
            `;
        });

        html += `
            </div>
        </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;
}

// Window-Exporte
window.fetchImuCloudLogs = fetchImuCloudLogs;
window.toggleDayCollapse = toggleDayCollapse;
window.setAllDaysCollapse = setAllDaysCollapse;
window.setReplaySpeedPreset = setReplaySpeedPreset;
window.resetReplayZoom = resetReplayZoom;