// renderer/overlay.js — Fullscreen transparent overlay for annotation + region capture

const COLORS = {
  red: '#ff0000',
  green: '#00ff00',
  pink: '#ff69b4',
};

// ── State ──

let activeColor = 'red';
let isDrawing = false;
let hasDrawn = false; // Track if any drawing occurred (avoids full pixel scan)
let isRegionMode = false;
let regionStart = null;
let regionRect = null;
let screenshotDataUrl = null; // Set when entering region-select mode
let compositedImage = null; // Cached Image for region select redraws

// ── Text Mode State ──

let isTextMode = false;
let textContent = '';
let textPosition = null;
const textCursor = document.getElementById('textCursor');

// ── Drawing Canvas ──

const drawCanvas = document.getElementById('drawCanvas');
const drawCtx = drawCanvas.getContext('2d');

// Set initial canvas size (no resize listener — overlay is always fullscreen)
drawCanvas.width = window.innerWidth;
drawCanvas.height = window.innerHeight;

function setPenStyle() {
  drawCtx.strokeStyle = COLORS[activeColor] || COLORS.red;
  drawCtx.lineWidth = 3;
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
}

// ── Mouse Drawing ──

drawCanvas.addEventListener('mousedown', (e) => {
  if (isRegionMode) return;
  if (e.button === 2) {
    // Right-click exits draw mode (or cancels text mode)
    if (isTextMode) {
      cancelText();
      setTextMode(false);
      window.quickclip.textModeChanged(false);
    } else {
      window.quickclip.exitDrawMode();
    }
    return;
  }
  if (isTextMode) {
    // Commit any in-progress text, then place cursor at click position
    if (textPosition && textContent) commitText();
    textPosition = { x: e.clientX, y: e.clientY };
    textContent = '';
    updateTextCursor();
    return;
  }
  isDrawing = true;
  hasDrawn = true;
  setPenStyle();
  drawCtx.beginPath();
  drawCtx.moveTo(e.clientX, e.clientY);
});

drawCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawing || isRegionMode) return;
  drawCtx.lineTo(e.clientX, e.clientY);
  drawCtx.stroke();
});

drawCanvas.addEventListener('mouseup', () => {
  isDrawing = false;
});

// Prevent context menu on right-click
drawCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', (e) => {
  if (isRegionMode) {
    if (e.key === 'Escape') {
      exitRegionMode();
    }
    return;
  }

  // ── Text mode typing ──
  if (isTextMode && textPosition) {
    if (e.key === 'Enter') {
      commitText();
      setTextMode(false);
      window.quickclip.textModeChanged(false);
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      cancelText();
      setTextMode(false);
      window.quickclip.textModeChanged(false);
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace') {
      textContent = textContent.slice(0, -1);
      updateTextCursor();
      e.preventDefault();
      return;
    }
    // Append printable characters
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      textContent += e.key;
      updateTextCursor();
      e.preventDefault();
      return;
    }
    return;
  }

  // ── Normal mode shortcuts ──
  if (e.key === 'Escape') {
    if (isTextMode) {
      cancelText();
      setTextMode(false);
      window.quickclip.textModeChanged(false);
    } else {
      window.quickclip.exitDrawMode();
    }
  } else if (e.key === '1') {
    activeColor = 'red';
  } else if (e.key === '2') {
    activeColor = 'green';
  } else if (e.key === '3') {
    activeColor = 'pink';
  } else if (e.key === 's' || e.key === 'S') {
    window.quickclip.takeSnippet();
  } else if (e.key === 't' || e.key === 'T') {
    const next = !isTextMode;
    setTextMode(next);
    window.quickclip.textModeChanged(next);
  }
});

// ── IPC: Color change from toolbar ──

window.quickclip.onColorChange((color) => {
  if (COLORS[color]) {
    activeColor = color;
    // Update text cursor color to match active color
    if (textCursor) textCursor.style.color = COLORS[activeColor];
  }
});

// ── IPC: Text mode toggle from toolbar ──

window.quickclip.onTextModeToggle((enabled) => setTextMode(enabled));

// ── Text Mode Functions ──

function setTextMode(enabled) {
  isTextMode = enabled;
  document.body.style.cursor = enabled ? 'text' : 'crosshair';
  if (!enabled) cancelText();
}

function updateTextCursor() {
  if (!textPosition || !textCursor) return;
  textCursor.style.left = textPosition.x + 'px';
  textCursor.style.top = textPosition.y + 'px';
  textCursor.style.color = COLORS[activeColor] || COLORS.red;
  textCursor.textContent = textContent;
  textCursor.classList.remove('hidden');
}

function commitText() {
  if (!textPosition || !textContent) return;
  const color = COLORS[activeColor] || COLORS.red;
  drawCtx.font = 'bold 16px Consolas, "Courier New", monospace';
  drawCtx.lineWidth = 3;
  drawCtx.strokeStyle = 'rgba(0,0,0,0.8)';
  drawCtx.strokeText(textContent, textPosition.x, textPosition.y + 14);
  drawCtx.fillStyle = color;
  drawCtx.fillText(textContent, textPosition.x, textPosition.y + 14);
  hasDrawn = true;
  cancelText();
}

function cancelText() {
  textContent = '';
  textPosition = null;
  if (textCursor) {
    textCursor.textContent = '';
    textCursor.classList.add('hidden');
  }
}

// ── Region Select Mode ──

const regionUI = document.getElementById('regionUI');
const regionCanvas = document.getElementById('regionCanvas');
const regionCtx = regionCanvas.getContext('2d');

window.quickclip.onEnterRegionSelect((dataUrl) => {
  screenshotDataUrl = dataUrl;
  enterRegionMode();
});

function enterRegionMode() {
  isRegionMode = true;
  regionCanvas.width = window.innerWidth;
  regionCanvas.height = window.innerHeight;

  const img = new Image();
  img.onload = () => {
    // Create a composited offscreen canvas (screenshot + annotations)
    const offscreen = document.createElement('canvas');
    offscreen.width = regionCanvas.width;
    offscreen.height = regionCanvas.height;
    const offCtx = offscreen.getContext('2d');
    offCtx.drawImage(img, 0, 0, offscreen.width, offscreen.height);
    offCtx.drawImage(drawCanvas, 0, 0);

    // Cache as an image for fast redraws
    compositedImage = new Image();
    compositedImage.onload = () => {
      // Initial draw with scrim
      regionCtx.drawImage(compositedImage, 0, 0);
      regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

      drawCanvas.style.display = 'none';
      regionUI.classList.remove('hidden');
    };
    compositedImage.src = offscreen.toDataURL();
  };
  img.src = screenshotDataUrl;
}

function exitRegionMode() {
  isRegionMode = false;
  regionUI.classList.add('hidden');
  drawCanvas.style.display = 'block';
  regionStart = null;
  regionRect = null;
  compositedImage = null;
  // If there were no annotations, just close
  if (isCanvasEmpty()) {
    window.quickclip.exitDrawMode();
  }
}

function isCanvasEmpty() {
  return !hasDrawn;
}

// ── Region Drag ──

regionCanvas.addEventListener('mousedown', (e) => {
  regionStart = { x: e.clientX, y: e.clientY };
  regionRect = null;
});

regionCanvas.addEventListener('mousemove', (e) => {
  if (!regionStart) return;
  regionRect = {
    x: Math.min(regionStart.x, e.clientX),
    y: Math.min(regionStart.y, e.clientY),
    w: Math.abs(e.clientX - regionStart.x),
    h: Math.abs(e.clientY - regionStart.y),
  };
  redrawRegion();
});

regionCanvas.addEventListener('mouseup', () => {
  if (regionRect && regionRect.w > 10 && regionRect.h > 10) {
    cropAndSend();
  }
  regionStart = null;
});

function redrawRegion() {
  if (!compositedImage) return;
  regionCtx.clearRect(0, 0, regionCanvas.width, regionCanvas.height);
  // Draw composited image with scrim
  regionCtx.drawImage(compositedImage, 0, 0);
  regionCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  regionCtx.fillRect(0, 0, regionCanvas.width, regionCanvas.height);

  if (regionRect) {
    // Clear scrim in selection and show bright region
    regionCtx.clearRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    regionCtx.drawImage(compositedImage, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
      regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    // Dashed selection border
    regionCtx.strokeStyle = '#fff';
    regionCtx.lineWidth = 2;
    regionCtx.setLineDash([6, 3]);
    regionCtx.strokeRect(regionRect.x, regionRect.y, regionRect.w, regionRect.h);
    regionCtx.setLineDash([]);
  }
}

function cropAndSend() {
  if (!compositedImage) return;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = regionRect.w;
  cropCanvas.height = regionRect.h;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(compositedImage, regionRect.x, regionRect.y, regionRect.w, regionRect.h,
    0, 0, regionRect.w, regionRect.h);
  const dataUrl = cropCanvas.toDataURL('image/png');
  window.quickclip.snippetCaptured(dataUrl);
}
