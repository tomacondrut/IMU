/*
 * Breadcrumb: 2026-09-13 09:40 - Decoupled Battery Engine & Multi-Device Historical Chart
 * [CRITICAL BUGFIX FLAG - BATTERY DATA & CHART LIFECYCLE]:
 * 1. Queries battery_logs strictly by selectedDeviceId to prevent device telemetry mixing.
 * 2. Manages Chart.js instance destruction and canvas resizing inside openBatteryModal().
 * 3. Updates header status bar battery icon (fill level, color gradient, charging lightning bolt).
 * 4. Exposes fetchLatestBatteryData() for window-level coordination in main.js.
 */

let chartInstance = null;

function openBatteryModal() {
    const modal = document.getElementById('battery-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (chartInstance) {
        setTimeout(() => chartInstance.resize(), 60);
    }
}

function closeBatteryModal() {
    const modal = document.getElementById('battery-modal');
    if (modal) modal.classList.add('hidden');
}

function initChart(labels, voltages, percents) {
    const cv = document.getElementById('batChart');
    if (!cv) return;
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
                    backgroundColor: 'rgba(0, 155, 76, 0.1)',
                    yAxisID: 'yVolt',
                    tension: 0.25,
                    fill: true
                },
                {
                    label: 'Kapazität (%)',
                    data: percents,
                    borderColor: '#3498db',
                    yAxisID: 'yPct',
                    borderDash: [5, 5],
                    tension: 0.2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: { color: '#7f8c8d', maxTicksLimit: 12 },
                    grid: { color: '#1a2332' }
                },
                yVolt: {
                    type: 'linear',
                    position: 'left',
                    min: 3.2,
                    max: 4.3,
                    ticks: { color: '#009B4C' },
                    grid: { color: '#1a2332' }
                },
                yPct: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 100,
                    ticks: { color: '#3498db' },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: { labels: { color: '#ecf0f1' } }
            }
        }
    });
}

async function fetchLatestBatteryData() {
    const { data, error } = await sbClient
        .from('battery_logs')
        .select('*')
        .eq('device_id', selectedDeviceId)
        .order('recorded_at', { ascending: false })
        .limit(100);

    if (error || !data || data.length === 0) {
        const hdrPct = document.getElementById('header-battery-pct');
        if (hdrPct) hdrPct.innerText = '--%';
        return;
    }

    const latest = data[0];
    const recTime = new Date(latest.recorded_at);
    const pct = parseInt(latest.battery_percent, 10);
    const isCharging = (latest.charging_status || '').toLowerCase().includes('lad') ||
        (latest.charging_status || '').toLowerCase().includes('usb');

    // 1. Akkuanzeige im Header aktualisieren
    const hdrPct = document.getElementById('header-battery-pct');
    const hdrFill = document.getElementById('header-battery-fill');
    const hdrBolt = document.getElementById('header-battery-bolt');

    if (hdrPct) hdrPct.innerText = `${pct}%`;
    if (hdrFill) {
        hdrFill.style.width = `${Math.min(Math.max(pct, 4), 100)}%`;
        if (pct >= 50) {
            hdrFill.className = 'h-full bg-green-500 rounded-[1px] transition-all duration-300';
        } else if (pct >= 25) {
            hdrFill.className = 'h-full bg-yellow-500 rounded-[1px] transition-all duration-300';
        } else {
            hdrFill.className = 'h-full bg-red-500 rounded-[1px] transition-all duration-300';
        }
    }
    if (hdrBolt) {
        hdrBolt.classList.toggle('hidden', !isCharging);
    }

    // 2. Akku-Modal KPIs aktualisieren
    const mPct = document.getElementById('modal-metric-pct');
    const mVolt = document.getElementById('modal-metric-volt');
    const mStatus = document.getElementById('modal-metric-status');
    const mBoot = document.getElementById('modal-metric-boot');
    const mTime = document.getElementById('modal-metric-time');
    const mAgo = document.getElementById('modal-metric-ago');

    if (mPct) mPct.innerText = `${pct}%`;
    if (mVolt) mVolt.innerText = `${Number(latest.battery_voltage).toFixed(3)} V`;
    if (mStatus) mStatus.innerText = latest.charging_status;
    if (mBoot) mBoot.innerText = `#${latest.boot_cycle}`;
    if (mTime) mTime.innerText = recTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (mAgo) mAgo.innerText = recTime.toLocaleDateString();

    // 3. Diagramm & Tabelle im Modal befüllen
    const reversed = [...data].reverse();
    const labels = reversed.map(r => new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const volts = reversed.map(r => r.battery_voltage);
    const pcts = reversed.map(r => r.battery_percent);

    initChart(labels, volts, pcts);

    const tblBody = document.getElementById('modal-log-table-body');
    if (tblBody) {
        tblBody.innerHTML = data.slice(0, 20).map(r => `
            <tr class="hover:bg-gray-800/40">
                <td class="py-1.5 px-3 text-gray-300">${new Date(r.recorded_at).toLocaleString()}</td>
                <td class="py-1.5 px-3 text-green-400 font-semibold">${Number(r.battery_voltage).toFixed(3)} V</td>
                <td class="py-1.5 px-3">${r.battery_percent}%</td>
                <td class="py-1.5 px-3 text-gray-400">${r.charging_status}</td>
                <td class="py-1.5 px-3">#${r.boot_cycle}</td>
            </tr>
        `).join('');
    }
}

window.fetchLatestBatteryData = fetchLatestBatteryData;
window.openBatteryModal = openBatteryModal;
window.closeBatteryModal = closeBatteryModal;