/*
 * Breadcrumb: 2026-09-13 09:40 - Leaflet GNSS Mapping & On-Demand Fix Engine
 * [CRITICAL BUGFIX FLAG - LEAFLET RESIZE & MULTI-DEVICE MARKER]:
 * 1. Calls map.invalidateSize() on modal open to prevent grey tile rendering artifacts.
 * 2. Binds popup labels dynamically to selectedDeviceId.
 * 3. Exports window.updateGpsUI() to be called directly by cloud-engine.js on command completion.
 * 4. Includes backdrop click-dismiss listener for both GPS and Battery modals.
 */

let gpsMapInstance = null;
let gpsMarker = null;

function initLeafletMap(lat = 47.2372, lon = 9.5981) {
    if (gpsMapInstance) return;

    const mapContainer = document.getElementById('leaflet-map');
    if (!mapContainer) return;

    gpsMapInstance = L.map('leaflet-map').setView([lat, lon], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(gpsMapInstance);
}

function openGpsModal() {
    const modal = document.getElementById('gps-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    if (!gpsMapInstance) {
        initLeafletMap();
    }
    setTimeout(() => {
        if (gpsMapInstance) gpsMapInstance.invalidateSize();
    }, 150);
}

function closeGpsModal() {
    const modal = document.getElementById('gps-modal');
    if (modal) modal.classList.add('hidden');
}

window.addEventListener('click', (e) => {
    const gpsModal = document.getElementById('gps-modal');
    const batModal = document.getElementById('battery-modal');
    if (gpsModal && e.target === gpsModal) closeGpsModal();
    if (batModal && e.target === batModal) closeBatteryModal();
});

function updateGpsUI(data) {
    const fixBadge = document.getElementById('gps-fix-badge');
    const satsVal = document.getElementById('gps-sats-val');
    const altVal = document.getElementById('gps-alt-val');
    const coordsVal = document.getElementById('gps-coords-val');
    const timeVal = document.getElementById('gps-timestamp');
    const btn = document.getElementById('btn-request-gps');

    if (btn) {
        btn.disabled = false;
        btn.innerText = '📡 GPS-Position jetzt abfragen';
    }

    if (!data || !data.has_fix) {
        if (fixBadge) {
            fixBadge.innerText = 'Kein Fix / Suche...';
            fixBadge.className = 'font-bold text-yellow-400';
        }
        return;
    }

    if (fixBadge) {
        fixBadge.innerText = 'Fix OK (3D)';
        fixBadge.className = 'font-bold text-green-400';
    }
    if (satsVal) satsVal.innerText = `${data.sats || '--'} Sats`;
    if (altVal) altVal.innerText = `${Number(data.alt || 0).toFixed(1)} m (${Number(data.speed || 0).toFixed(1)} km/h)`;
    if (coordsVal) coordsVal.innerText = `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`;
    if (timeVal) timeVal.innerText = `Letzte Messung: ${new Date().toLocaleTimeString()} (${data.utc || ''})`;

    const headerGps = document.getElementById('header-gps-status');
    if (headerGps) headerGps.innerText = 'GPS OK';

    if (gpsMapInstance) {
        gpsMapInstance.setView([data.lat, data.lon], 16);

        if (gpsMarker) {
            gpsMarker.setLatLng([data.lat, data.lon]);
        } else {
            gpsMarker = L.marker([data.lat, data.lon]).addTo(gpsMapInstance);
        }

        gpsMarker.bindPopup(`<b>${selectedDeviceId}</b><br>Lat: ${data.lat.toFixed(5)}<br>Lon: ${data.lon.toFixed(5)}<br>Höhe: ${data.alt}m`).openPopup();
    }
}

async function triggerGpsLocationFix() {
    const btn = document.getElementById('btn-request-gps');
    const fixBadge = document.getElementById('gps-fix-badge');
    if (btn) {
        btn.disabled = true;
        btn.innerText = `⏳ Schalte GNSS ein & frage ${selectedDeviceId} an...`;
    }
    if (fixBadge) {
        fixBadge.innerText = 'Fix wird gesucht...';
        fixBadge.className = 'font-bold text-yellow-400 animate-pulse';
    }

    await sendCloudCommand('GPS', '/', `Fordere GPS-Ortung von ${selectedDeviceId} an...`);
}

window.updateGpsUI = updateGpsUI;
window.openGpsModal = openGpsModal;
window.closeGpsModal = closeGpsModal;
window.triggerGpsLocationFix = triggerGpsLocationFix;