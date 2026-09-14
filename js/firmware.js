/*
 * Breadcrumb: 2026-09-14 20:30 - Targeted Multi-Device OTA Release Manager
 * [CRITICAL BUGFIX FLAG - MULTI-DEVICE RELEASE ISOLATION]:
 * 1. fetchReleases() filters strictly by selectedDeviceId and 'ALL' to isolate firmware feeds.
 * 2. handleFirmwareUpload() tags uploads with target_device (STAG-IMU-01, STAG-IMU-02 or ALL).
 * 3. Renders high-contrast target device badge in table rows.
 */

async function fetchReleases() {
    const tbody = document.getElementById('releases-table-body');
    if (!tbody) return;

    // Nur Releases für das aktuell im Header ausgewählte Gerät oder universelle 'ALL' abrufen
    const { data, error } = await sbClient
        .from('firmware_releases')
        .select('*')
        .or(`target_device.eq.${selectedDeviceId},target_device.eq.ALL,target_device.is.null`)
        .order('id', { ascending: false });

    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-slate-500">Keine Releases für ${selectedDeviceId} vorhanden.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map((rel, idx) => {
        const targetBadge = rel.target_device === 'ALL' || !rel.target_device
            ? '<span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded text-[10px] font-sans font-bold">ALLE</span>'
            : `<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold">${rel.target_device}</span>`;

        return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100 ${idx === 0 ? 'bg-emerald-50/40' : ''}">
          <td class="py-2.5 px-3 font-bold text-green-700 font-mono">
            ${rel.version} ${idx === 0 ? '<span class="ml-1 text-[10px] bg-stag-green text-white px-1.5 py-0.5 rounded font-sans">LATEST</span>' : ''}
          </td>
          <td class="py-2.5 px-3 font-mono">${targetBadge}</td>
          <td class="py-2.5 px-3 text-slate-500 font-mono">${new Date(rel.created_at).toLocaleString()}</td>
          <td class="py-2.5 px-3 text-slate-700 max-w-xs truncate">${rel.release_notes || '-'}</td>
          <td class="py-2.5 px-3 text-right">
            <a href="${rel.bin_url}" download class="text-green-700 hover:text-green-800 font-bold hover:underline">Download</a>
          </td>
        </tr>
      `;
    }).join('');
}

async function handleFirmwareUpload(e) {
    e.preventDefault();
    const file = document.getElementById('ota-file').files[0];
    const version = document.getElementById('ota-version').value.trim();
    const notes = document.getElementById('ota-notes').value.trim();
    const targetDev = document.getElementById('ota-target-device')?.value || selectedDeviceId;

    const btn = document.getElementById('btn-upload-ota');
    const pBox = document.getElementById('upload-progress-box');
    const pBar = document.getElementById('upload-progress-bar');
    const pMsg = document.getElementById('upload-status-msg');

    if (!file || !version) return;

    btn.disabled = true;
    pBox.classList.remove('hidden');
    pBar.style.width = '25%';
    pMsg.innerText = `Lade Binary für ${targetDev} hoch...`;

    try {
        const storagePath = `releases/${targetDev}_${version}_${Date.now()}.bin`;
        const { error: upErr } = await sbClient.storage.from('firmware').upload(storagePath, file, { upsert: true });
        if (upErr) throw upErr;

        pBar.style.width = '70%';
        pMsg.innerText = 'Erstelle Release-Eintrag...';

        const { data: urlData } = sbClient.storage.from('firmware').getPublicUrl(storagePath);
        const { error: dbErr } = await sbClient.from('firmware_releases').insert([{
            version: version,
            bin_url: urlData.publicUrl,
            release_notes: notes,
            target_device: targetDev
        }]);
        if (dbErr) throw dbErr;

        pBar.style.width = '100%';
        pMsg.innerText = `Firmware ${version} für ${targetDev} aktiv!`;
        pMsg.className = 'text-xs text-green-700 mt-2 text-center font-bold';

        document.getElementById('ota-file').value = '';
        document.getElementById('ota-version').value = '';
        document.getElementById('ota-notes').value = '';
        fetchReleases();
    } catch (err) {
        pMsg.innerText = 'Upload-Fehler: ' + (err.message || JSON.stringify(err));
        pMsg.className = 'text-xs text-red-600 mt-2 text-center font-bold';
    } finally {
        btn.disabled = false;
    }
}

window.fetchReleases = fetchReleases;
window.handleFirmwareUpload = handleFirmwareUpload;