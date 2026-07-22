// renderer/record.js — Demo recorder control panel.
//
// MediaRecorder / getUserMedia are DOM-only, so recording happens here in the
// renderer. Chunks are streamed to the main process (which writes them to disk
// via src/media.js) instead of being buffered in memory. On stop, main persists
// a `demos` row and optionally the AI transcript.

const qc = window.quickclip;

// ── State ──
let ctx = { projectId: null, projects: [], markerHotkey: '', aiEnabled: false };
let sources = [];
let selectedSource = null;      // { id, name, type, thumbnail }

let demoId = null;
let sourceType = 'screen';
let hasAudio = false;
let videoMime = 'video/webm';

let screenStream = null;
let micStream = null;
let videoRecorder = null;
let audioRecorder = null;
let videoTail = Promise.resolve();  // serialize chunk sends to preserve order
let audioTail = Promise.resolve();

let startTime = 0;
let durationMs = 0;
let markers = [];
let timerInterval = null;

// ── Voice-activity detection (VAD) ──
// Samples mic RMS while recording to build a map of "moments you were talking"
// — shown as highlights on the playback timeline so narrated stretches are easy
// to find and click. Values are tuned for speech vs. keyboard/room noise.
let audioCtx = null;
let vadAnalyser = null;
let vadInterval = null;
let speechSegments = [];       // [{ start, end }] in ms, finalized
let vadOpen = null;            // start ms of the segment currently being spoken
let vadLastVoice = 0;          // last ms voice was heard (for hangover)
let vadNoiseFloor = 0.008;     // adaptive noise-floor estimate (RMS)

const VAD_POLL_MS = 100;
const VAD_HANGOVER_MS = 700;   // keep a segment open through short pauses
const VAD_MIN_SEGMENT_MS = 400; // discard blips shorter than this
const VAD_MERGE_GAP_MS = 800;  // merge segments separated by less than this

function startVad(stream) {
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    vadAnalyser = audioCtx.createAnalyser();
    vadAnalyser.fftSize = 1024;
    source.connect(vadAnalyser);
    const buf = new Float32Array(vadAnalyser.fftSize);
    speechSegments = [];
    vadOpen = null;
    vadInterval = setInterval(() => {
      vadAnalyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now() - startTime;

      // Track the noise floor from quiet stretches so a hummy room doesn't
      // read as constant speech; speech must clear both floors.
      if (rms < vadNoiseFloor * 1.5) vadNoiseFloor = vadNoiseFloor * 0.95 + rms * 0.05;
      const speaking = rms > Math.max(0.015, vadNoiseFloor * 3);

      if (speaking) {
        vadLastVoice = now;
        if (vadOpen === null) vadOpen = now;
      } else if (vadOpen !== null && now - vadLastVoice > VAD_HANGOVER_MS) {
        pushSpeechSegment(vadOpen, vadLastVoice);
        vadOpen = null;
      }
      updateSpeechIndicator(vadOpen !== null);
    }, VAD_POLL_MS);
  } catch (e) {
    console.error('VAD unavailable:', e.message);
  }
}

function pushSpeechSegment(start, end) {
  if (end - start < VAD_MIN_SEGMENT_MS) return;
  const last = speechSegments[speechSegments.length - 1];
  if (last && start - last.end < VAD_MERGE_GAP_MS) last.end = end;
  else speechSegments.push({ start: Math.round(start), end: Math.round(end) });
}

function stopVad() {
  if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
  if (vadOpen !== null) { pushSpeechSegment(vadOpen, performance.now() - startTime); vadOpen = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  vadAnalyser = null;
  updateSpeechIndicator(false);
}

function updateSpeechIndicator(speaking) {
  const el = document.getElementById('speechIndicator');
  if (el) {
    el.classList.toggle('speaking', speaking);
    const secs = Math.round(speechSegments.reduce((a, s) => a + (s.end - s.start), 0) / 1000)
      + (vadOpen !== null ? Math.round((performance.now() - startTime - vadOpen) / 1000) : 0);
    el.textContent = speaking ? `\u{1F399} narrating…` : (secs ? `\u{1F399} ${secs}s narrated` : `\u{1F399} silent`);
  }
}

// ── Init ──
(async () => {
  try {
    ctx = await qc.getRecorderContext();
  } catch { /* keep defaults */ }
  renderProjects();
  renderMarkerHint();
  await loadSources();
})();

function renderProjects() {
  const sel = document.getElementById('projectSelect');
  let html = `<option value="">No project (unassigned)</option>`;
  for (const p of ctx.projects || []) {
    const selected = ctx.projectId && String(ctx.projectId) === String(p.id) ? ' selected' : '';
    html += `<option value="${p.id}"${selected}>${escapeHtml(p.name)}</option>`;
  }
  sel.innerHTML = html;
}

function renderMarkerHint() {
  const hint = document.getElementById('markerHint');
  const hk = (ctx.markerHotkey || '').replace('CommandOrControl', 'Ctrl');
  hint.textContent = hk
    ? `Tip: press ${hk} anytime (even in another app) to mark a moment worth explaining.`
    : 'Tip: click Add Marker to flag a moment worth explaining.';
}

async function loadSources() {
  const screenGrid = document.getElementById('screenSources');
  const windowGrid = document.getElementById('windowSources');
  screenGrid.innerHTML = '<div class="rec-source-empty">Loading…</div>';
  windowGrid.innerHTML = '';
  try {
    sources = await qc.getRecordingSources();
  } catch (e) {
    showSourceError('Could not list capture sources: ' + e.message);
    return;
  }
  const screens = sources.filter(s => s.type === 'screen');
  const windows = sources.filter(s => s.type === 'window');
  screenGrid.innerHTML = screens.length ? screens.map(renderSource).join('') : '<div class="rec-source-empty">No screens found</div>';
  windowGrid.innerHTML = windows.length ? windows.map(renderSource).join('') : '<div class="rec-source-empty">No windows found</div>';

  // Wire clicks (avoid inline handlers with source ids that contain quotes)
  document.querySelectorAll('.rec-source').forEach((el) => {
    el.addEventListener('click', () => selectSource(el.dataset.sourceId));
  });
}

function renderSource(s) {
  const thumb = s.thumbnail
    ? `<img src="${s.thumbnail}" alt="" />`
    : `<div style="height:76px;background:#000"></div>`;
  return `<div class="rec-source" data-source-id="${escapeAttr(s.id)}">
    ${thumb}<div class="rec-source-name" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>
  </div>`;
}

function selectSource(id) {
  selectedSource = sources.find(s => s.id === id) || null;
  document.querySelectorAll('.rec-source').forEach((el) => {
    el.classList.toggle('selected', el.dataset.sourceId === id);
  });
  document.getElementById('startBtn').disabled = !selectedSource;
}

function showSourceError(msg) {
  const el = document.getElementById('sourceError');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Recording ──

function pickMime(candidates, fallback) {
  for (const c of candidates) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch {}
  }
  return fallback;
}

async function startRecording() {
  if (!selectedSource) return;
  document.getElementById('sourceError').style.display = 'none';
  sourceType = selectedSource.type;
  const wantMic = document.getElementById('micToggle').checked;

  // 1. Screen/window video via the Electron desktop-capture constraints.
  try {
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSource.id,
          maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
        },
      },
    });
  } catch (e) {
    showSourceError('Screen capture failed: ' + e.message);
    return;
  }

  // 2. Optional microphone.
  micStream = null;
  if (wantMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // Non-fatal: record video-only and tell the user.
      showSourceError('Microphone unavailable — recording video only. (' + e.message + ')');
    }
  }
  hasAudio = !!micStream;

  // 3. Begin the on-disk recording (gets a server-authoritative demo id).
  let begin;
  try {
    begin = await qc.demoBegin({
      projectId: selectedProjectId(),
      sourceType,
      hasAudio,
    });
  } catch (e) {
    showSourceError('Could not start recording: ' + e.message);
    stopTracks();
    return;
  }
  demoId = begin.demoId;

  // Poster = the source thumbnail captured at selection time.
  if (selectedSource.thumbnail) qc.demoPoster(demoId, selectedSource.thumbnail);

  // 4. Wire recorders. Combined stream (video + mic) is what plays back; a
  //    separate mic-only recorder produces a small file for AI transcription.
  const combinedTracks = [...screenStream.getVideoTracks()];
  if (micStream) combinedTracks.push(...micStream.getAudioTracks());
  const combined = new MediaStream(combinedTracks);

  videoMime = pickMime(
    ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
    'video/webm'
  );
  videoTail = Promise.resolve();
  videoRecorder = new MediaRecorder(combined, { mimeType: videoMime });
  videoRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    videoTail = videoTail.then(() => e.data.arrayBuffer()).then((buf) => qc.demoVideoChunk(demoId, buf));
  };
  videoRecorder.start(1000);

  if (micStream) {
    const audioMime = pickMime(['audio/webm;codecs=opus', 'audio/webm'], 'audio/webm');
    audioTail = Promise.resolve();
    audioRecorder = new MediaRecorder(new MediaStream(micStream.getAudioTracks()), { mimeType: audioMime });
    audioRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      audioTail = audioTail.then(() => e.data.arrayBuffer()).then((buf) => qc.demoAudioChunk(demoId, buf));
    };
    audioRecorder.start(1000);
  }

  // If the captured window/screen goes away, stop gracefully.
  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (videoRecorder && videoRecorder.state !== 'inactive') stopAndSave();
  });

  // 5. Switch to the recording view.
  startTime = performance.now();
  markers = [];
  updateMarkerCount();
  if (micStream) startVad(micStream);
  showView('recordingView');
  timerInterval = setInterval(updateTimer, 250);
}

function selectedProjectId() {
  const v = document.getElementById('projectSelect').value;
  return v ? parseInt(v, 10) : null;
}

function updateTimer() {
  const t = Math.floor((performance.now() - startTime) / 1000);
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  document.getElementById('timer').textContent = `${mm}:${ss}`;
}

function dropMarker() {
  if (!demoId || startTime === 0) return;
  markers.push({ t: Math.round(performance.now() - startTime), type: 'marker' });
  updateMarkerCount();
}
// Global marker hotkey relayed from main.
qc.onDemoMarker(() => dropMarker());

function updateMarkerCount() {
  const n = markers.length;
  document.getElementById('markerCount').textContent = `${n} marker${n === 1 ? '' : 's'}`;
}

function stopTracks() {
  [screenStream, micStream].forEach((s) => { if (s) s.getTracks().forEach(t => t.stop()); });
  screenStream = null; micStream = null;
}

async function stopRecorders() {
  stopVad();
  const stops = [];
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    stops.push(new Promise((r) => { videoRecorder.onstop = r; videoRecorder.stop(); }));
  }
  if (audioRecorder && audioRecorder.state !== 'inactive') {
    stops.push(new Promise((r) => { audioRecorder.onstop = r; audioRecorder.stop(); }));
  }
  await Promise.all(stops);
  await Promise.all([videoTail, audioTail]);  // flush any in-flight chunk sends
  stopTracks();
}

async function stopAndSave() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  durationMs = Math.round(performance.now() - startTime);
  await stopRecorders();

  let result;
  try {
    result = await qc.demoFinalize({
      demoId,
      projectId: selectedProjectId(),
      durationMs,
      markers,
      // Timeline highlights use seconds (matching transcript segments).
      speechSegments: speechSegments.map((s) => ({
        start: +(s.start / 1000).toFixed(1),
        end: +(s.end / 1000).toFixed(1),
      })),
      hasAudio,
      sourceType,
      mime: videoMime,
    });
  } catch (e) {
    result = { success: false, error: e.message };
  }

  const msg = document.getElementById('savedMsg');
  const tBtn = document.getElementById('transcribeBtn');
  if (!result || !result.success) {
    msg.textContent = 'Saved with an error: ' + ((result && result.error) || 'unknown');
  } else {
    const secs = Math.round(durationMs / 1000);
    msg.textContent = `${secs}s recorded${hasAudio ? ' with narration' : ' (no audio)'}${markers.length ? `, ${markers.length} marker(s)` : ''}.`;
  }
  // Transcription only makes sense with audio + AI available.
  tBtn.style.display = (hasAudio && ctx.aiEnabled) ? '' : 'none';
  showView('savedView');
}

async function discardRecording() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  await stopRecorders();
  if (demoId) { try { await qc.demoCancel(demoId); } catch {} }
  demoId = null;
  showView('setupView');
}

async function transcribeNow() {
  const tBtn = document.getElementById('transcribeBtn');
  const msg = document.getElementById('savedMsg');
  tBtn.disabled = true;
  tBtn.textContent = '⏳ Transcribing…';
  try {
    const r = await qc.generateDemoTranscript(demoId);
    msg.textContent = (r && r.success)
      ? 'Transcript ready — open HuminLoop to read and edit it.'
      : 'Transcription failed: ' + ((r && r.error) || 'unknown');
  } catch (e) {
    msg.textContent = 'Transcription failed: ' + e.message;
  }
  tBtn.textContent = '✨ Transcribe again';
  tBtn.disabled = false;
}

function finishAndOpen() {
  qc.showMain();
  qc.closeRecorder();
}

function closeRecorder() {
  qc.closeRecorder();
}

// ── View switching ──
function showView(id) {
  for (const v of ['setupView', 'recordingView', 'savedView']) {
    document.getElementById(v).style.display = v === id ? 'flex' : 'none';
  }
}

// ── Escaping ──
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
