/*
 * Breadcrumb: 2026-09-13 09:40 - Decoupled Cloud Firmware Releases Engine
 * [CRITICAL BUGFIX FLAG - FIRMWARE REGISTRATION]:
 * 1. Uploads compiled .bin to Supabase Storage bucket 'firmware/releases/'.
 * 2. Automatically indexes publicUrl in public.firmware_releases.
 * 3. Highlights the latest build with a LATEST badge for over-the-air pulls.
 */

async function fetchReleases() {
    const { data, error } = await sbClient
        .from('firmware_releases')
        .select('*')
        .order('id', { ascending: false });

    const tbody = document.getElementById('releases-table-body');
    if (!tbody) return;

    if (error || !data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-500">Keine Releases vorhanden.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map((rel, idx) => `
    <tr class="hover:bg-gray-800/40 ${idx === 0 ? 'bg-green-950/20' : ''}">
      <td class="py-2 px-3 font-bold text-green-400">
        ${rel.version} ${idx === 0 ? '<span class="ml-1 text-[10px] bg-stag-green text-white px-1.5 py-0.5 rounded">LATEST</span>' : ''}
      </td>
      <td class="py-2 px-3 text-gray-400">${new Date(rel.created_at).toLocaleString()}</td>
      <td class="py-2 px-3 text-gray-300 max-w-xs truncate">${rel.release_notes || '-'}</td>
      <td class="py-2 px-3 text-right"><a href="${rel.bin_url}" download class="text-green-500 hover:underline">Download</a></td>
    </tr>
  `).join('');
}

async function handleFirmwareUpload(e) {
    e.preventDefault();
    const file = document.getElementById('ota-file').files[0];
    const version = document.getElementById('ota-version').value.trim();
    const notes = document.getElementById('ota-notes').value.trim();
    const btn = document.getElementById('btn-upload-ota');
    const pBox = document.getElementById('upload-progress-box');
    const pBar = document.getElementById('upload-progress-bar');
    const pMsg = document.getElementById('upload-status-msg');

    if (!file || !version) return;

    btn.disabled = true;
    pBox.classList.remove('hidden');
    pBar.style.width = '25%';
    pMsg.innerText = 'Lade Binary in Storage hoch...';

    try {
        const storagePath = `releases/${version}_${Date.now()}.bin`;
        const { error: upErr } = await sbClient.storage.from('firmware').upload(storagePath, file, { upsert: true });
        if (upErr) throw upErr;

        pBar.style.width = '70%';
        pMsg.innerText = 'Erstelle Datenbank-Eintrag...';

        const { data: urlData } = sbClient.storage.from('firmware').getPublicUrl(storagePath);
        const { error: dbErr } = await sbClient.from('firmware_releases').insert([{
            version: version,
            bin_url: urlData.publicUrl,
            release_notes: notes
        }]);
        if (dbErr) throw dbErr;

        pBar.style.width = '100%';
        pMsg.innerText = `Firmware Release ${version} aktiv!`;
        pMsg.className = 'text-xs text-green-400 mt-2 text-center font-bold';

        document.getElementById('ota-file').value = '';
        document.getElementById('ota-version').value = '';
        document.getElementById('ota-notes').value = '';
        fetchReleases();
    } catch (err) {
        pMsg.innerText = 'Upload-Fehler: ' + (err.message || JSON.stringify(err));
        pMsg.className = 'text-xs text-red-400 mt-2 text-center font-bold';
    } finally {
        btn.disabled = false;
    }
}

window.fetchReleases = fetchReleases;
window.handleFirmwareUpload = handleFirmwareUpload;