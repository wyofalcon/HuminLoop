// renderer/lite-capture.js — Lite mode capture popup

let screenshotData = null;
let windowMeta = null;

window.quickclip.onScreenshot((dataURL, meta) => {
  screenshotData = dataURL;
  windowMeta = meta || {};
  const img = document.getElementById('ssImg');
  const placeholder = document.getElementById('placeholder');
  if (dataURL) {
    img.src = dataURL;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  }
  updateSaveBtn();
  document.getElementById('noteInput').focus();
});

async function save() {
  const comment = document.getElementById('noteInput').value.trim();
  if (!screenshotData && !comment) return;

  const clip = {
    id: Date.now().toString(),
    image: screenshotData,
    comment,
    category: 'Uncategorized',
    project_id: null,
    tags: '',
    aiSummary: '',
    status: 'parked',
    timestamp: Date.now(),
    window_title: windowMeta?.title || null,
    process_name: windowMeta?.processName || null,
  };

  document.getElementById('saveBtn').disabled = true;
  document.getElementById('saveBtn').textContent = 'Saving...';

  await window.quickclip.saveClip(clip);
  window.quickclip.closeCapture();
}

function updateSaveBtn() {
  const hasContent = screenshotData || document.getElementById('noteInput').value.trim();
  document.getElementById('saveBtn').disabled = !hasContent;
}

document.getElementById('noteInput').addEventListener('input', updateSaveBtn);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!document.getElementById('saveBtn').disabled) save();
  } else if (e.key === 'Escape') {
    window.quickclip.closeCapture();
  }
});
