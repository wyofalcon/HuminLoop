// src/media.js — On-disk storage for demo recordings (video + audio + transcript).
//
// Unlike images.js, this module NEVER round-trips large media through base64
// data URLs — video/audio are written to disk as they stream in and served to
// the renderer via HTTP range requests (see api-server.js). Only small assets
// (poster PNG, transcript JSON, TTS audio for AI input) are ever base64-encoded.
//
// Layout: {userData}/demos/{demoId}/
//   video.webm            — screen recording (video + mixed audio) for playback
//   audio-original.webm   — mic-only track, small, sent to AI for transcription
//   audio-dubbed.wav      — AI TTS "clean" narration (experimental)
//   poster.png            — thumbnail frame
//   transcript.json       — { plain, segments:[{start,end,text,type}] }

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Canonical filenames inside each demo folder.
const FILES = {
  video: 'video.webm',
  audioOriginal: 'audio-original.webm',
  audioDubbed: 'audio-dubbed.wav',       // AI TTS dub (raw PCM wrapped as WAV)
  audioDubbedSelf: 'audio-dubbed.webm',  // self-recorded dub (MediaRecorder)
  poster: 'poster.png',
  transcript: 'transcript.json',
};

/** Mime type for a demo audio filename. */
function audioMimeFor(filename) {
  return String(filename).endsWith('.wav') ? 'audio/wav' : 'audio/webm';
}

let demosRoot = null;

function getDemosDir() {
  if (!demosRoot) {
    demosRoot = path.join(app.getPath('userData'), 'demos');
    if (!fs.existsSync(demosRoot)) fs.mkdirSync(demosRoot, { recursive: true });
  }
  return demosRoot;
}

/** Absolute path to a demo's folder. Never touches the disk — read paths must
 *  not create directories (the auth-less HTTP API reaches them). */
function getDemoDir(demoId) {
  return path.join(getDemosDir(), sanitizeId(demoId));
}

/** Like getDemoDir but creates the folder — for write paths only. */
function ensureDemoDir(demoId) {
  const dir = getDemoDir(demoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Demo ids are server-generated numeric strings; refuse anything with path chars. */
function sanitizeId(demoId) {
  const id = String(demoId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid demo id: ${id}`);
  return id;
}

/**
 * Resolve an absolute path to a file inside a demo folder, guarding against
 * traversal. `filename` should be one of FILES (or a value derived from it).
 * Pass { ensure: true } from write paths to create the folder.
 */
function demoFilePath(demoId, filename, { ensure = false } = {}) {
  const base = ensure ? ensureDemoDir(demoId) : getDemoDir(demoId);
  const resolved = path.resolve(base, filename);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes demo folder: ${filename}`);
  }
  return resolved;
}

// ── Streaming writers (chunked recording) ───────────────────────────────────
// The recorder renderer streams MediaRecorder chunks over IPC; we append them
// to disk as they arrive instead of buffering a whole (possibly huge) file in
// memory. One set of streams per in-flight recording, keyed by demo id.

const writers = new Map(); // demoId -> { video: WriteStream, audio: WriteStream|null, failed: string|null }

// A write stream that errors (disk full, folder deleted mid-recording) must not
// crash the main process — Node kills the process on unhandled 'error' events.
// Record the failure so finalize can surface it instead.
function guardWriteStream(demoId, stream) {
  if (!stream) return null;
  stream.on('error', (e) => {
    console.error(`[HuminLoop media] Write failed for demo ${demoId}:`, e.message);
    const w = writers.get(demoId);
    if (w) w.failed = e.message;
    try { stream.destroy(); } catch {}
  });
  return stream;
}

function openDemoWriters(demoId, { audio = false } = {}) {
  closeDemoWriters(demoId); // defensive: never leak a prior stream
  const video = guardWriteStream(demoId, fs.createWriteStream(demoFilePath(demoId, FILES.video, { ensure: true })));
  const audioStream = audio ? guardWriteStream(demoId, fs.createWriteStream(demoFilePath(demoId, FILES.audioOriginal, { ensure: true }))) : null;
  writers.set(demoId, { video, audio: audioStream, failed: null });
}


function writeDemoVideoChunk(demoId, buffer) {
  const w = writers.get(demoId);
  if (w && w.video && !w.video.destroyed) w.video.write(toBuffer(buffer));
}

function writeDemoAudioChunk(demoId, buffer) {
  const w = writers.get(demoId);
  if (w && w.audio && !w.audio.destroyed) w.audio.write(toBuffer(buffer));
}

/** Flush and close a recording's streams. Resolves once bytes are on disk with
 *  { failed } — the error message if a stream died mid-recording, else null. */
function closeDemoWriters(demoId) {
  const w = writers.get(demoId);
  if (!w) return Promise.resolve({ failed: null });
  writers.delete(demoId);
  const done = (stream) => new Promise((resolve) => {
    if (!stream || stream.destroyed) return resolve();
    stream.end(resolve);
  });
  return Promise.all([done(w.video), done(w.audio)]).then(() => ({ failed: w.failed }));
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk && chunk.buffer) return Buffer.from(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
  return Buffer.from(chunk);
}

// ── Self-dub writer (mic re-recorded over muted playback in the viewer) ──────
// Same streaming pattern as the recording writers, but targets an existing,
// already-finalized demo — so it gets its own map instead of activeRecordings'.

const dubWriters = new Map(); // demoId -> { stream: WriteStream, failed: string|null }

function openDubWriter(demoId) {
  closeDubWriter(demoId);
  // A fresh self-dub replaces any earlier AI (wav) dub.
  try { fs.rmSync(demoFilePath(demoId, FILES.audioDubbed), { force: true }); } catch {}
  const stream = fs.createWriteStream(demoFilePath(demoId, FILES.audioDubbedSelf, { ensure: true }));
  const entry = { stream, failed: null };
  stream.on('error', (e) => {
    console.error(`[HuminLoop media] Dub write failed for demo ${demoId}:`, e.message);
    entry.failed = e.message;
    try { stream.destroy(); } catch {}
  });
  dubWriters.set(demoId, entry);
}

function writeDubChunk(demoId, buffer) {
  const w = dubWriters.get(demoId);
  if (w && w.stream && !w.stream.destroyed) w.stream.write(toBuffer(buffer));
}

/** Flush + close a self-dub recording. Resolves with { failed }. */
function closeDubWriter(demoId) {
  const w = dubWriters.get(demoId);
  if (!w) return Promise.resolve({ failed: null });
  dubWriters.delete(demoId);
  return new Promise((resolve) => {
    if (!w.stream || w.stream.destroyed) return resolve({ failed: w.failed });
    w.stream.end(() => resolve({ failed: w.failed }));
  });
}

/** Discard a self-dub in progress (or a saved one) and its file. */
function deleteDubFiles(demoId) {
  for (const f of [FILES.audioDubbed, FILES.audioDubbedSelf]) {
    try { fs.rmSync(demoFilePath(demoId, f), { force: true }); } catch {}
  }
}

// ── One-shot writers / readers ──────────────────────────────────────────────

/** Save a poster/thumbnail frame (base64 data URL) to poster.png. */
function saveDemoPoster(demoId, dataURL) {
  if (!dataURL) return null;
  const base64 = dataURL.replace(/^data:image\/\w+;base64,/, '');
  const p = demoFilePath(demoId, FILES.poster, { ensure: true });
  fs.writeFileSync(p, Buffer.from(base64, 'base64'));
  return FILES.poster;
}

/** Load poster.png as a data URL (small — safe to base64). */
function loadDemoPoster(demoId) {
  const p = demoFilePath(demoId, FILES.poster);
  if (!fs.existsSync(p)) return null;
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
}

function saveDemoTranscript(demoId, obj) {
  const p = demoFilePath(demoId, FILES.transcript, { ensure: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return FILES.transcript;
}

function loadDemoTranscript(demoId) {
  const p = demoFilePath(demoId, FILES.transcript);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Save AI-generated dubbed narration (WAV bytes) to audio-dubbed.wav. */
function saveDemoDub(demoId, wavBuffer) {
  // A fresh AI dub replaces any earlier self-recorded (webm) dub.
  try { fs.rmSync(demoFilePath(demoId, FILES.audioDubbedSelf), { force: true }); } catch {}
  const p = demoFilePath(demoId, FILES.audioDubbed, { ensure: true });
  fs.writeFileSync(p, toBuffer(wavBuffer));
  return FILES.audioDubbed;
}

/**
 * Read a demo's audio as base64 for sending to the AI (transcription input).
 * `which` = 'original' (mic track) | a dubbed filename. Returns { base64, mime } or null.
 */
function readDemoAudioBase64(demoId, which = 'original') {
  const filename = which === 'original' ? FILES.audioOriginal
    : (which === 'dubbed' ? FILES.audioDubbed : which);
  const p = demoFilePath(demoId, filename);
  if (!fs.existsSync(p)) return null;
  return { base64: fs.readFileSync(p).toString('base64'), mime: audioMimeFor(filename) };
}

function hasDemoFile(demoId, filename) {
  try { return fs.existsSync(demoFilePath(demoId, filename)); } catch { return false; }
}

/** For range streaming: absolute path + size, or null if missing. */
function demoFileStat(demoId, filename) {
  try {
    const p = demoFilePath(demoId, filename);
    if (!fs.existsSync(p)) return null;
    return { path: p, size: fs.statSync(p).size };
  } catch { return null; }
}

/** Recursively delete a demo's entire folder (video, audio, transcript, poster). */
function deleteDemoDir(demoId) {
  try {
    const dir = path.join(getDemosDir(), sanitizeId(demoId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`[HuminLoop media] Failed to delete demo ${demoId}:`, e.message);
  }
}

// ── PCM → WAV (for Gemini TTS output, which is raw little-endian PCM) ─────────

/**
 * Wrap raw PCM (default 24kHz mono 16-bit, matching Gemini TTS) in a WAV
 * container so it plays in a browser <audio>/<video> element.
 */
function pcmToWav(pcmBuffer, { sampleRate = 24000, channels = 1, bitDepth = 16 } = {}) {
  const pcm = toBuffer(pcmBuffer);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = {
  FILES,
  audioMimeFor,
  getDemosDir,
  getDemoDir,
  demoFilePath,
  openDemoWriters,
  writeDemoVideoChunk,
  writeDemoAudioChunk,
  closeDemoWriters,
  openDubWriter,
  writeDubChunk,
  closeDubWriter,
  deleteDubFiles,
  saveDemoPoster,
  loadDemoPoster,
  saveDemoTranscript,
  loadDemoTranscript,
  saveDemoDub,
  readDemoAudioBase64,
  hasDemoFile,
  demoFileStat,
  deleteDemoDir,
  pcmToWav,
};
