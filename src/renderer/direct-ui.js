'use strict';

// Direct mode on the screens: the status line under the public address, and (in settings.js) the switch.
// What the line says comes from directText.js; the state comes from the main process (directMode.js).

const srvDirect = $('srvDirect');
const srvDirectText = $('srvDirectText');
const srvDirectRetryBtn = $('srvDirectRetryBtn');

let directInfo = null; // { enabled, public, supported, status } for the server on screen
let directInfoFor = null;

function paintDirectLine() {
  const info = directInfo;
  const show = Boolean(info && info.public && info.enabled && info.supported && info.status && info.status.state !== 'off');
  srvDirect.classList.toggle('hidden', !show);
  if (!show) return;
  const d = window.VPDirect.describeDirect(info.status, t);
  srvDirectText.textContent = d.text;
  srvDirect.dataset.tone = d.tone;
  srvDirectRetryBtn.classList.toggle('hidden', !d.retry);
  srvDirectRetryBtn.disabled = false;
}

// Called by console.js whenever the public address area is drawn.
window.renderDirectLine = async function renderDirectLine() {
  if (typeof managingProfileId === 'undefined' || !managingProfileId || !isThisProfilePublic()) {
    directInfo = null;
    directInfoFor = null;
    paintDirectLine();
    return;
  }
  if (directInfoFor !== managingProfileId) {
    directInfoFor = managingProfileId;
    try { directInfo = await window.vp.server.direct.get(managingProfileId); } catch { directInfo = null; }
  }
  paintDirectLine();
};

// The main process reports each change (it only ever reports the public server's Direct mode).
window.vp.on('tunnel:direct', (status) => {
  if (!directInfo) { directInfoFor = null; window.renderDirectLine(); return; }
  directInfo = { ...directInfo, status };
  paintDirectLine();
});

// Turning it on or off in Settings changes what the line shows.
window.directSettingChanged = function directSettingChanged() { directInfoFor = null; window.renderDirectLine(); };

srvDirectRetryBtn.addEventListener('click', async () => {
  srvDirectRetryBtn.disabled = true;
  const res = await window.vp.server.direct.retry(managingProfileId);
  if (!res || !res.ok) srvDirectRetryBtn.disabled = false;
});
