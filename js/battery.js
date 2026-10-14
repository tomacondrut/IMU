/*
 * Breadcrumbs & Versionshistorie:
 * - 2026-09-13 09:40: Decoupled Battery Engine & Multi-Device Historical Chart (device_id Filter, Header Icon).
 * - 2026-09-13 10:00: Light Theme Battery Chart & Table Rows (Slate-Farbschema).
 * - 2026-10-14 21:35: Tagesauswahl, Dynamisches Horizontal-Scrolling, Vollständige Historie & Laufzeit-Prognose:
 *   [CRITICAL FEATURE & BUGFIX - FULL HISTORY, TOUCH/DRAG SCROLL & LINEAR DISCHARGE FORECAST]:
 *   1. Abruf von bis zu 2.500 Messpunkten (statt 100) und Gruppierung nach Kalendertagen (YYYY-MM-DD).
 *   2. Echter horizontaler Scroll: Berechnet die Mindestbreite von #bat-chart-inner dynamisch (28px pro Messpunkt)
 *      und ergänzt Mouse-Drag-Scrolling für Desktop sowie natives Touch-Panning für iOS/Android.
 *   3. Tabellenlimit aufgehoben: Zeigt standardmäßig alle Messpunkte des gewählten Tages inkl. ΔV-Spalte
 *      (umschaltbar zwischen 50, 200 und Alle).
 *   4. Intelligente Restlaufzeit-Prognose: Berechnet per linearer Regression (Methode der kleinsten Quadrate)
 *      über den aktuellen Entladezyklus (ohne Ladephasen) die reale Entladerate in mV/h bzw. %/d bis zur
 *      Hardware-Entladeschlussspannung von 3.30 V (0%).
 *   [DISMISSED]: Starres data.slice(0, 20) und feste min-w-[650px] (verhinderte Scrollbar bei >25 Punkten).
 */

let chartInstance = null;
let batteryDataAll = [];         // Chronologisch absteigend (neueste zuerst)
let batteryDaysMap = new Map();  // 'YYYY-MM-DD' -> Array (aufsteigend sortiert für den Tag)
let batteryAvailableDays = [];   // Sortierte Liste ['2026-10-14', '2026-10-13', ...]
let selectedBatteryDay = 'ALL';  // 'ALL' oder 'YYYY-MM-DD'
let batTableLimit = 'ALL';       // '50', '200', 'ALL'
let isBatDetailWidth = true;     // true = horizontales Wischen mit 28px/Punkt, false = 100% Fit
let batDragInitialized = false;

const BAT_CUTOFF_VOLT = 3.30;    // Entladeschlussspannung laut Firmware (readBMS: 3.30V = 3% / Cut-Off)
const BAT_FULL_VOLT = 4.18;

// ============================================================================
// 1. MODAL LIFECYCLE & INTERAKTION (DRAG-TO-SCROLL)
// ============================================================================

function openBatteryModal() {
    const modal = document.getElementById('battery-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    initBatScrollDrag();

    setTimeout(() => {
        renderBatteryView();
        scrollBatChartToRight();
    }, 60);
}

function closeBatteryModal() {
    const modal = document.getElementById('battery-modal');
    if (modal) modal.classList.add('hidden');
}

function initBatScrollDrag() {
    if (batDragInitialized) return;
    const wrapper = document.getElementById('bat-chart-scroll-wrapper');
    if (!wrapper) return;
    batDragInitialized = true;

    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;

    wrapper.addEventListener('mousedown', (e) => {
        isDown = true;
        startX = e.pageX - wrapper.offsetLeft;
        scrollLeft = wrapper.scrollLeft;
    });

    wrapper.addEventListener('mouseleave', () => { isDown = false; });
    wrapper.addEventListener('mouseup', () => { isDown = false; });

    wrapper.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - wrapper.offsetLeft;
        const walk = (x - startX) * 1.5;
        wrapper.scrollLeft = scrollLeft - walk;
    });

    // Horizontales Scrollen per Mausrad (falls Detail-Breite aktiv)
    wrapper.addEventListener('wheel', (e) => {
        if (wrapper.scrollWidth > wrapper.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            wrapper.scrollLeft += e.deltaY;
        }
    }, { passive: false });
}

function scrollBatChartToRight() {
    const wrapper = document.getElementById('bat-chart-scroll-wrapper');
    if (wrapper) {
        wrapper.scrollLeft = wrapper.scrollWidth;
    }
}

function toggleBatChartZoom() {
    isBatDetailWidth = !isBatDetailWidth;
    const btn = document.getElementById('btn-bat-zoom-mode');
    if (btn) {
        btn.innerText = isBatDetailWidth ? '🔍 Detail-Breite: AN' : '📐 Kompakt (100%): AN';
        btn.className = isBatDetailWidth
            ? 'px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-700 transition'
            : 'px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-stag-green text-white shadow-xs transition';
    }
    renderBatteryView();
    if (isBatDetailWidth) {
        setTimeout(scrollBatChartToRight, 50);
    }
}

// ============================================================================
// 2. TAGESAUSWAHL & NAVIGATION
// ============================================================================

function getLocalDayKey(isoString) {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Unbekannt';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDayLabel(dayKey) {
    if (dayKey === 'ALL') return 'Gesamter Verlauf';
    const parts = dayKey.split('-');
    if (parts.length !== 3) return dayKey;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const weekday = d.toLocaleDateString('de-CH', { weekday: 'short' });
    return `${weekday}, ${parts[2]}.${parts[1]}.${parts[0]}`;
}

function onBatteryDayChange(val) {
    selectedBatteryDay = val || 'ALL';
    updateDayNavigationButtons();
    renderBatteryView();
    setTimeout(scrollBatChartToRight, 40);
}

function stepBatteryDay(dir) {
    if (batteryAvailableDays.length === 0) return;

    // Index in absteigender Liste (0 = neuester Tag, length-1 = ältester Tag)
    let curIdx = batteryAvailableDays.indexOf(selectedBatteryDay);
    if (selectedBatteryDay === 'ALL') {
        curIdx = (dir < 0) ? 0 : -1;
    } else {
        // dir = -1 (älterer Tag -> höherer Index), dir = +1 (neuerer Tag -> kleinerer Index)
        curIdx = curIdx - dir;
    }

    if (curIdx >= 0 && curIdx < batteryAvailableDays.length) {
        selectedBatteryDay = batteryAvailableDays[curIdx];
    } else if (curIdx < 0) {
        selectedBatteryDay = 'ALL';
    }

    const sel = document.getElementById('battery-day-select');
    if (sel) sel.value = selectedBatteryDay;

    updateDayNavigationButtons();
    renderBatteryView();
    setTimeout(scrollBatChartToRight, 40);
}

function updateDayNavigationButtons() {
    const prevBtn = document.getElementById('btn-bat-prev-day');
    const nextBtn = document.getElementById('btn-bat-next-day');
    if (!prevBtn || !nextBtn) return;

    if (batteryAvailableDays.length === 0) {
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }

    if (selectedBatteryDay === 'ALL') {
        prevBtn.disabled = false; // Sprung zum neuesten Tag möglich
        nextBtn.disabled = true;
    } else {
        const idx = batteryAvailableDays.indexOf(selectedBatteryDay);
        prevBtn.disabled = (idx >= batteryAvailableDays.length - 1);
        nextBtn.disabled = false; // Nach rechts geht es bis 'ALL'
    }
}

function onBatTableLimitChange(val) {
    batTableLimit = val;
    renderBatteryTable();
}

// ============================================================================
// 3. LAUFZEIT-PROGNOSE (LINEARE REGRESSION AUF ENTLADEKURVE)
// ============================================================================

function computeBatteryForecast(chronologicalData) {
    if (!chronologicalData || chronologicalData.length < 2) {
        return { text: 'Zu wenig Daten', rateText: 'Warte auf Messpunkte...', icon: '⏳' };
    }

    const latest = chronologicalData[chronologicalData.length - 1];
    const latestVolt = Number(latest.battery_voltage);
    const latestPct = Number(latest.battery_percent);
    const statusStr = (latest.charging_status || '').toLowerCase();
    const isCurrentlyCharging = statusStr.includes('lad') || statusStr.includes('usb') || statusStr.includes('voll');

    if (isCurrentlyCharging) {
        return {
            text: 'Netzbetrieb / Lädt',
            rateText: `${latest.charging_status}`,
            icon: '⚡'
        };
    }

    // Aktuelles Entlade-Segment rückwärts ab dem neuesten Punkt isolieren
    // (stoppt, sobald ein Ladevorgang oder ein Spannungsanstieg > 0.06 V erkannt wird)
    const segment = [latest];
    const latestTsMs = new Date(latest.recorded_at).getTime();
    const maxLookbackMs = 14 * 24 * 3600 * 1000; // Max. 14 Tage Rückschau

    for (let i = chronologicalData.length - 2; i >= 0; i--) {
        const pt = chronologicalData[i];
        const nextPt = segment[segment.length - 1]; // zeitlich späterer Punkt
        const ptTs = new Date(pt.recorded_at).getTime();

        if (latestTsMs - ptTs > maxLookbackMs) break;

        const st = (pt.charging_status || '').toLowerCase();
        if (st.includes('lad') || st.includes('usb') || st.includes('voll')) break;

        // Falls die Spannung zum späteren Zeitpunkt um > 60 mV gestiegen ist, lag ein Ladevorgang dazwischen
        if (Number(nextPt.battery_voltage) - Number(pt.battery_voltage) > 0.06) break;

        segment.push(pt);
    }

    segment.reverse(); // Chronologisch aufsteigend

    if (segment.length < 2) {
        return { text: 'Kalibriere...', rateText: 'Nach Ladevorgang < 2 Pkt.', icon: '⏳' };
    }

    const t0 = new Date(segment[0].recorded_at).getTime();
    const tEnd = new Date(segment[segment.length - 1].recorded_at).getTime();
    const spanHours = (tEnd - t0) / (1000 * 3600);

    if (spanHours < 0.25) {
        return { text: 'Sammele Trend...', rateText: `Zeitbasis: ${(spanHours * 60).toFixed(0)} min`, icon: '⏳' };
    }

    // Lineare Regression (Kleinste Quadrate): Spannung V(t) = m * t_hours + b
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = segment.length;

    for (let i = 0; i < n; i++) {
        const x = (new Date(segment[i].recorded_at).getTime() - t0) / (1000 * 3600); // Stunden seit Start
        const y = Number(segment[i].battery_voltage);
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
    }

    const denom = (n * sumXX - sumX * sumX);
    let slopeVoltPerHour = (denom !== 0) ? ((n * sumXY - sumX * sumY) / denom) : 0;

    // Fallback auf Start-End-Differenz, falls Regression durch Temperatur-Erholung leicht positiv ist
    if (slopeVoltPerHour >= -0.00005) {
        const totalDropV = Number(segment[n - 1].battery_voltage) - Number(segment[0].battery_voltage);
        slopeVoltPerHour = totalDropV / spanHours;
    }

    // Wenn Spannung absolut stabil ist (z.B. reiner Deep Sleep ohne messbaren Drop)
    if (slopeVoltPerHour >= -0.00008) {
        return {
            text: '> 30 Tage (Standby)',
            rateText: 'Verbrauch minimal (<0.1 mV/h)',
            icon: '🟢'
        };
    }

    const drainMvPerHour = Math.abs(slopeVoltPerHour) * 1000;
    const drainPctPerDay = (Math.abs(slopeVoltPerHour) * 24 / (BAT_FULL_VOLT - BAT_CUTOFF_VOLT)) * 100;

    const remainingVolt = Math.max(0, latestVolt - BAT_CUTOFF_VOLT);
    const hoursRemaining = remainingVolt / Math.abs(slopeVoltPerHour);

    let forecastStr = '';
    if (hoursRemaining >= 48) {
        const days = Math.floor(hoursRemaining / 24);
        const remH = Math.round(hoursRemaining % 24);
        forecastStr = `~${days} d ${remH} h`;
    } else if (hoursRemaining >= 1) {
        const h = Math.floor(hoursRemaining);
        const m = Math.round((hoursRemaining - h) * 60);
        forecastStr = `~${h} h ${m} min`;
    } else {
        forecastStr = `< ${Math.max(1, Math.round(hoursRemaining * 60))} min`;
    }

    const icon = hoursRemaining > 72 ? '🟢' : (hoursRemaining > 24 ? '🟡' : '🔴');

    return {
        text: forecastStr,
        rateText: `-${drainMvPerHour.toFixed(1)} mV/h (~${drainPctPerDay.toFixed(1)}%/d)`,
        icon: icon
    };
}

// ============================================================================
// 4. CHART.JS RENDERING MIT DYNAMISCHER SCROLL-BREITE
// ============================================================================

function initChart(labels, voltages, percents, pointCount) {
    const cv = document.getElementById('batChart');
    const innerBox = document.getElementById('bat-chart-inner');
    const wrapper = document.getElementById('bat-chart-scroll-wrapper');
    if (!cv || !innerBox || !wrapper) return;

    // Dynamische Breite für echtes horizontales Wischen berechnen
    const wrapperWidth = wrapper.clientWidth || 700;
    if (isBatDetailWidth && pointCount > 20) {
        const pxPerPoint = 28; // 28px Abstand pro Messpunkt für optimale Lesbarkeit
        const targetWidth = Math.max(wrapperWidth, pointCount * pxPerPoint);
        innerBox.style.width = `${targetWidth}px`;
        innerBox.style.minWidth = `${targetWidth}px`;
    } else {
        innerBox.style.width = '100%';
        innerBox.style.minWidth = '100%';
    }

    const ctx = cv.getContext('2d');
    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Spannung (V)',
                    data: voltages,
                    borderColor: '#009B4C',
                    backgroundColor: 'rgba(0, 155, 76, 0.08)',
                    yAxisID: 'yVolt',
                    tension: 0.25,
                    pointRadius: pointCount > 80 ? 1.5 : 3,
                    pointHoverRadius: 5,
                    borderWidth: 2,
                    fill: true
                },
                {
                    label: 'Kapazität (%)',
                    data: percents,
                    borderColor: '#0284c7',
                    yAxisID: 'yPct',
                    borderDash: [5, 5],
                    pointRadius: pointCount > 80 ? 1 : 2.5,
                    borderWidth: 1.8,
                    tension: 0.2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            scales: {
                x: {
                    ticks: {
                        color: '#64748b',
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: isBatDetailWidth ? Math.max(12, Math.floor(pointCount / 3)) : 10,
                        font: { family: 'monospace', size: 10 }
                    },
                    grid: { color: '#f1f5f9' }
                },
                yVolt: {
                    type: 'linear',
                    position: 'left',
                    min: 3.2,
                    max: 4.3,
                    ticks: {
                        color: '#009B4C',
                        font: { family: 'monospace', size: 10 },
                        callback: (v) => v.toFixed(2) + ' V'
                    },
                    grid: { color: '#f1f5f9' }
                },
                yPct: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 100,
                    ticks: {
                        color: '#0284c7',
                        font: { family: 'monospace', size: 10 },
                        callback: (v) => v + '%'
                    },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#0f172a', font: { size: 11, weight: 'bold' } }
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            if (context.datasetIndex === 0) {
                                return ` Spannung: ${Number(context.parsed.y).toFixed(3)} V`;
                            }
                            return ` Kapazität: ${context.parsed.y}%`;
                        }
                    }
                }
            }
        }
    });
}

// ============================================================================
// 5. ANSICHT & TABELLE AKTUALISIEREN
// ============================================================================

function getActiveDatasetAscending() {
    if (selectedBatteryDay === 'ALL') {
        return [...batteryDataAll].reverse();
    }
    return batteryDaysMap.get(selectedBatteryDay) || [];
}

function renderBatteryView() {
    const ascData = getActiveDatasetAscending();
    const totalCount = ascData.length;

    const badgeEl = document.getElementById('bat-chart-badge');
    if (badgeEl) badgeEl.innerText = `${totalCount} Messpunkte`;

    const titleEl = document.getElementById('bat-chart-title');
    if (titleEl) {
        titleEl.innerText = selectedBatteryDay === 'ALL'
            ? 'Spannungsverlauf & Kapazität (Gesamthistorie)'
            : `Tagesverlauf: ${formatDayLabel(selectedBatteryDay)}`;
    }

    // Tages-Statistiken (Delta V / % und Boot-Zyklen im gewählten Zeitraum)
    const dayDeltaEl = document.getElementById('modal-metric-day-delta');
    const dayBootsEl = document.getElementById('modal-metric-day-boots');

    if (ascData.length >= 2) {
        const first = ascData[0];
        const last = ascData[ascData.length - 1];
        const dV = Number(last.battery_voltage) - Number(first.battery_voltage);
        const dPct = Number(last.battery_percent) - Number(first.battery_percent);
        const sign = dV >= 0 ? '+' : '';
        if (dayDeltaEl) {
            dayDeltaEl.innerText = `Δ: ${sign}${dV.toFixed(3)}V (${sign}${dPct}%)`;
            dayDeltaEl.className = `text-[10px] font-mono truncate font-semibold ${dV < 0 ? 'text-amber-700' : 'text-green-700'}`;
        }

        const uniqueBoots = new Set(ascData.map(r => r.boot_cycle)).size;
        if (dayBootsEl) dayBootsEl.innerText = `${uniqueBoots} Zyklen (${totalCount} Logs)`;
    } else {
        if (dayDeltaEl) dayDeltaEl.innerText = 'Δ: --';
        if (dayBootsEl) dayBootsEl.innerText = `${totalCount} Logs`;
    }

    // Labels formatieren (bei 'ALL' mit Datum+Uhrzeit, bei Einzeltag mit Sekundengenauigkeit)
    const labels = ascData.map(r => {
        const d = new Date(r.recorded_at);
        if (selectedBatteryDay === 'ALL') {
            return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }) + ' ' +
                d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    const volts = ascData.map(r => Number(r.battery_voltage));
    const pcts = ascData.map(r => Number(r.battery_percent));

    initChart(labels, volts, pcts, totalCount);
    renderBatteryTable();
}

function renderBatteryTable() {
    const tblBody = document.getElementById('modal-log-table-body');
    const tblTitle = document.getElementById('modal-table-title');
    if (!tblBody) return;

    // Chronologisch aufsteigende Daten holen, damit wir ΔV zum Vorgängerpunkt exakt berechnen können
    const ascData = getActiveDatasetAscending();
    const withDelta = ascData.map((r, idx) => {
        const prevV = idx > 0 ? Number(ascData[idx - 1].battery_voltage) : Number(r.battery_voltage);
        const diffV = idx > 0 ? (Number(r.battery_voltage) - prevV) : 0;
        return { ...r, diffV };
    });

    // Für die Tabelle wieder umdrehen (neueste Einträge oben)
    const descData = withDelta.reverse();
    const total = descData.length;

    let visibleRows = descData;
    if (batTableLimit !== 'ALL') {
        const lim = parseInt(batTableLimit, 10) || 50;
        visibleRows = descData.slice(0, lim);
    }

    if (tblTitle) {
        const scopeTxt = selectedBatteryDay === 'ALL' ? 'Gesamt' : formatDayLabel(selectedBatteryDay);
        tblTitle.innerText = `Messpunkte (${visibleRows.length} von ${total} angezeigt • ${scopeTxt})`;
    }

    if (visibleRows.length === 0) {
        tblBody.innerHTML = `<tr><td colspan="6" class="py-4 text-center text-slate-400">Keine Messpunkte für diesen Zeitraum vorhanden.</td></tr>`;
        return;
    }

    tblBody.innerHTML = visibleRows.map(r => {
        const dStr = new Date(r.recorded_at).toLocaleString('de-CH');
        const diffStr = r.diffV === 0
            ? '<span class="text-slate-400">±0.000</span>'
            : (r.diffV > 0
                ? `<span class="text-green-600 font-bold">+${r.diffV.toFixed(3)} V</span>`
                : `<span class="text-amber-700">${r.diffV.toFixed(3)} V</span>`);

        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="py-1.5 px-3 text-slate-600 whitespace-nowrap">${dStr}</td>
                <td class="py-1.5 px-3 text-green-700 font-semibold whitespace-nowrap">${Number(r.battery_voltage).toFixed(3)} V</td>
                <td class="py-1.5 px-3 text-slate-800 font-bold">${r.battery_percent}%</td>
                <td class="py-1.5 px-3 whitespace-nowrap">${diffStr}</td>
                <td class="py-1.5 px-3 text-slate-600 whitespace-nowrap">${r.charging_status || '--'}</td>
                <td class="py-1.5 px-3 text-slate-500">#${r.boot_cycle}</td>
            </tr>
        `;
    }).join('');
}

// ============================================================================
// 6. SUPABASE DATENABRUF & HEADER-SYNCHRONISATION
// ============================================================================

async function fetchLatestBatteryData() {
    const { data, error } = await sbClient
        .from('battery_logs')
        .select('*')
        .eq('device_id', selectedDeviceId)
        .order('recorded_at', { ascending: false })
        .limit(2500);

    if (error || !data || data.length === 0) {
        const hdrPct = document.getElementById('header-battery-pct');
        if (hdrPct) hdrPct.innerText = '--%';
        batteryDataAll = [];
        batteryDaysMap.clear();
        batteryAvailableDays = [];
        renderBatteryView();
        return;
    }

    batteryDataAll = data;

    // Nach Kalendertagen gruppieren (in den Tages-Arrays chronologisch aufsteigend)
    batteryDaysMap.clear();
    const chronologicalAll = [...data].reverse();

    chronologicalAll.forEach(row => {
        const dayKey = getLocalDayKey(row.recorded_at);
        if (!batteryDaysMap.has(dayKey)) {
            batteryDaysMap.set(dayKey, []);
        }
        batteryDaysMap.get(dayKey).push(row);
    });

    batteryAvailableDays = Array.from(batteryDaysMap.keys()).sort().reverse();

    // Dropdown-Menü für Tageswahl befüllen
    const daySelect = document.getElementById('battery-day-select');
    if (daySelect) {
        const prevSelection = selectedBatteryDay;
        let optsHtml = `<option value="ALL">Gesamter Verlauf (${data.length} Pkt.)</option>`;
        batteryAvailableDays.forEach(dKey => {
            const count = batteryDaysMap.get(dKey).length;
            optsHtml += `<option value="${dKey}">${formatDayLabel(dKey)} (${count} Pkt.)</option>`;
        });
        daySelect.innerHTML = optsHtml;

        if (prevSelection !== 'ALL' && batteryDaysMap.has(prevSelection)) {
            selectedBatteryDay = prevSelection;
        } else {
            selectedBatteryDay = 'ALL';
        }
        daySelect.value = selectedBatteryDay;
    }
    updateDayNavigationButtons();

    // Aktuellsten Messwert im Header & Modal-KPIs eintragen
    const latest = data[0];
    const recTime = new Date(latest.recorded_at);
    const pct = parseInt(latest.battery_percent, 10);
    const isCharging = (latest.charging_status || '').toLowerCase().includes('lad') ||
        (latest.charging_status || '').toLowerCase().includes('usb');

    const hdrPct = document.getElementById('header-battery-pct');
    const hdrFill = document.getElementById('header-battery-fill');
    const hdrBolt = document.getElementById('header-battery-bolt');

    if (hdrPct) hdrPct.innerText = `${pct}%`;
    if (hdrFill) {
        hdrFill.style.width = `${Math.min(Math.max(pct, 4), 100)}%`;
        if (pct >= 50) {
            hdrFill.className = 'h-full bg-green-600 rounded-[1px] transition-all duration-300';
        } else if (pct >= 25) {
            hdrFill.className = 'h-full bg-amber-500 rounded-[1px] transition-all duration-300';
        } else {
            hdrFill.className = 'h-full bg-red-500 rounded-[1px] transition-all duration-300';
        }
    }
    if (hdrBolt) {
        hdrBolt.classList.toggle('hidden', !isCharging);
    }

    const mPct = document.getElementById('modal-metric-pct');
    const mVolt = document.getElementById('modal-metric-volt');
    const mStatus = document.getElementById('modal-metric-status');
    const mBoot = document.getElementById('modal-metric-boot');
    const mTime = document.getElementById('modal-metric-time');
    const mAgo = document.getElementById('modal-metric-ago');
    const mSub = document.getElementById('modal-bat-subtitle');

    if (mPct) mPct.innerText = `${pct}%`;
    if (mVolt) mVolt.innerText = `${Number(latest.battery_voltage).toFixed(3)} V`;
    if (mStatus) mStatus.innerText = latest.charging_status;
    if (mBoot) mBoot.innerText = `#${latest.boot_cycle}`;
    if (mTime) mTime.innerText = recTime.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (mAgo) mAgo.innerText = recTime.toLocaleDateString('de-CH');
    if (mSub) mSub.innerText = `Gerät: ${selectedDeviceId} • ${batteryAvailableDays.length} Messtage (${data.length} Logs)`;

    // Prognose berechnen & anzeigen
    const forecast = computeBatteryForecast(chronologicalAll);
    const fValEl = document.getElementById('modal-metric-forecast');
    const fRateEl = document.getElementById('modal-metric-rate');
    const fIconEl = document.getElementById('modal-forecast-icon');

    if (fValEl) fValEl.innerText = forecast.text;
    if (fRateEl) fRateEl.innerText = forecast.rateText;
    if (fIconEl) fIconEl.innerText = forecast.icon;

    renderBatteryView();
}

// Globale Exporte für HTML-Events
window.fetchLatestBatteryData = fetchLatestBatteryData;
window.openBatteryModal = openBatteryModal;
window.closeBatteryModal = closeBatteryModal;
window.onBatteryDayChange = onBatteryDayChange;
window.stepBatteryDay = stepBatteryDay;
window.onBatTableLimitChange = onBatTableLimitChange;
window.toggleBatChartZoom = toggleBatChartZoom;