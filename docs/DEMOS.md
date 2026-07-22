# Project Demos

Record a screen demo (app-only or full screen) while narrating out loud, then let
AI turn the messy narration into a clean, timestamped voice-over script — and dub
the demo either with an AI voice or **in your own voice** by re-recording over
muted playback.

Demos live in their own **Demos** sub-tab inside each project, next to **Notes**
and **Workflow**.

> Status: **v1**. The full pipeline is implemented, but the GUI
> recording/playback path has not been hands-on tested yet (it needs a real
> screen + microphone). TTS dubbing is **experimental** (needs a Gemini
> TTS-capable key). See _Limitations_.

## User flow

1. **Demos tab → New Demo** (or tray → _Record Demo_). A small always-on-top
   recorder panel opens.
2. Pick **what to record** — an entire screen or a single app window (so demos
   that need steps outside HuminLoop still work) — toggle the **microphone**, and
   pick the target **project**.
3. **Start Recording.** Do the demo normally and roughly explain what you're
   doing as you go. While you record:
   - A **voice-activity detector** (WebAudio, in the recorder) tracks the
     moments you're actually talking — the panel shows a live 🎙 indicator.
   - An **activity tracker** (main process) logs which window has focus and how
     much the mouse moves, so the AI later knows what was on screen.
   - Press the **marker hotkey** (`Ctrl+Shift+M` by default, global) or the
     **Add Marker** button to flag any moment worth explaining.
4. **Stop & Save.** The recording is written to disk and a `demos` row is created
   (with markers, speech segments, and the activity log).
5. Back in the Demos tab, the expanded player shows a **timeline reel** under the
   video: narrated stretches are highlighted, markers are pinned, and clicking
   anywhere on the reel jumps the video there — so finding the spots that need
   voice-over is one click.
6. **Transcribe narration** → AI produces a readable, segmented transcript.
7. **Write voice-over script** → AI rewrites the transcript into a polished,
   read-aloud script, grounded in the window-focus/cursor activity metadata
   (so it can say "switching to the terminal…" only when that actually happened).
8. **Dub it** — two options:
   - **🔊 AI dub (beta)** — synthesizes the script with Gemini TTS (experimental).
   - **🎙 Dub it myself** — the video plays muted from the start while your mic
     records; read the script as it plays. It saves automatically when the video
     ends (or via Stop & Save). Playback then uses your new narration, with an
     Original/Dub toggle on the card.

## Architecture

```
record.html/js  ──MediaRecorder chunks──►  main.js  ──►  media.js (disk)
   (renderer)      (video + mic, IPC)      (streams to      {userData}/demos/{id}/
                                            disk, no          video.webm
                                            base64)           audio-original.webm
                                                              audio-dubbed.wav
                                                              poster.png
                                                              transcript.json
                          ▲                     │
                          │                     ▼
                    global marker          db (demos table, pg + sqlite)
                    hotkey (main)                 │
                                                  ▼
viewer Demos tab  ◄──HTTP range stream──  api-server.js  /api/demos/:id/video
 <video>, script     (127.0.0.1:7277)                    /api/demos/:id/audio
                                                          /api/demos/:id/poster
       AI: ai.generateDemoTranscript (Gemini 2.5 Flash audio input)
           ai.synthesizeDemoDub       (Gemini TTS preview — experimental)
```

### Why recording lives in a renderer

`MediaRecorder` / `getUserMedia` are DOM-only APIs, so capture happens in a
dedicated renderer (`record.html`). `desktopCapturer` (main-process only) supplies
the list of screens/windows. Chunks are **streamed to disk** as they arrive
(`src/media.js`) rather than buffered in memory — video is never round-tripped
through base64 (unlike screenshots in `images.js`), which would blow memory/IPC.

### Two audio tracks

- `video.webm` — screen video **plus** the mic, mixed, for playback.
- `audio-original.webm` — mic-only, small, sent to Gemini for transcription.

### Playback

Served by the existing local HTTP API with **HTTP Range** support so `<video>`
seeking works. The viewer's CSP was extended with `media-src`/`img-src` for
`http://127.0.0.1:*`.

## Data model — `demos` table (both pg + sqlite)

| column | notes |
|---|---|
| `id` | server-generated numeric string (main, at record-start) |
| `project_id` | FK → projects, `ON DELETE SET NULL` |
| `title`, `description` | title auto-filled from AI transcript if blank |
| `video_path`, `audio_original_path`, `audio_dubbed_path`, `poster_path` | relative filenames under the demo folder. The dubbed slot is `audio-dubbed.wav` (AI TTS) **or** `audio-dubbed.webm` (self-recorded) — the row records which |
| `transcript` | JSON `{ title, plain, segments:[{start,text,type}] }` |
| `script` | JSON `{ plain, segments:[{start,text}] }` — the AI-polished voice-over script (transcript + activity metadata) |
| `markers` | JSON `[{ t(ms), type }]` |
| `speech_segments` | JSON `[{ start, end }]` in **seconds** — VAD-detected narration windows (timeline highlights) |
| `activity_log` | JSON `{ focus:[{t(ms),app,title}], cursor:[{t(ms),moves}] }` — window-focus timeline + 5s cursor-travel buckets |
| `duration_ms`, `has_audio`, `audio_mode`, `source_type`, `mime` | `audio_mode`: `'original'` \| `'dubbed'` — which track playback uses |
| `deleted_at` | soft-delete / trash, 30-day auto-purge (also deletes files); restorable from the Demos tab's Trash section |

Schema is added in **four** places (project convention): `db-sqlite.js` SCHEMA +
`db-pg.js` runMigrations (existing DBs) + `docker/init.sql` (fresh pg) — sqlite
runs its full `CREATE TABLE IF NOT EXISTS` SCHEMA on every init.

## Surfaces (IPC + HTTP + MCP)

- **IPC** (`main.js` + `preload.js`): `open-recorder`, `get-recording-sources`,
  `demo-begin`, `demo-video-chunk`/`demo-audio-chunk`/`demo-poster`,
  `demo-finalize`, `demo-cancel`, `get-demos`/`get-demo`/`get-demo-trash`/
  `update-demo`/`delete-demo`/`restore-demo`/`permanent-delete-demo`,
  `generate-demo-transcript`, `generate-demo-script`, `generate-demo-dub`,
  `demo-dub-begin`/`demo-dub-chunk`/`demo-dub-finish`/`demo-dub-cancel` (self-dub).
- **HTTP** (`api-server.js`): `GET /api/demos`, `GET /api/demos/trash`,
  `GET /api/demos/:id`, `PATCH /api/demos/:id` (title/description/audio_mode),
  `GET /api/demos/:id/{video,audio,poster}` (range-streamed),
  `DELETE /api/demos/:id` (trash), `POST /api/demos/:id/restore`,
  `DELETE /api/demos/:id/permanent`.
- **MCP** (`mcp-server/index.js`): `demo_list`, `demo_get` (metadata, transcript,
  script, speech segments, activity log; recording can't be driven headlessly).

## Limitations / follow-ups

- **Per-click / per-keystroke capture across other apps is not implemented.**
  Electron has no global input hook. The activity tracker instead polls what
  Electron *can* see without native modules: the focused window (async
  `window-info` poll, 1.5s) and cursor travel (`screen.getCursorScreenPoint()`,
  250ms → 5s buckets). A native hook (`uiohook-napi`) is the future path for
  true click/keystroke markers. Keystroke *content* is deliberately never
  logged either way.
- **TTS dubbing is experimental.** It needs a Gemini TTS-capable model
  (`gemini-2.5-flash-preview-tts`), most reliable on the API-key surface; it
  returns a clear error if unavailable. PCM→WAV wrapping lives in `media.js`.
  An offline/open-source alternative worth evaluating is Kokoro via `kokoro-js`
  (Apache-2.0, runs locally via ONNX in Node/Electron, prebuilt voices) as a
  fallback behind the same dub slot; Chatterbox (MIT, voice cloning from a ~10s
  sample — the mic track we already store) is the path to AI dubs in the user's
  own voice, but needs a Python/GPU sidecar. The **self-dub** path avoids all
  of this by recording the user directly.
- **Long recordings**: transcription sends inline audio (Gemini's inline cap is
  ~20 MB). Very long demos would need the Files API (not implemented) — the
  mic-only track keeps typical demos well under the cap.
- **Codec**: Chromium `MediaRecorder` produces WebM (VP8/9 + Opus). Exporting
  shareable MP4 would need ffmpeg (intentionally not a dependency).
- **Not yet hands-on tested**: recording, permission prompts, playback, and the
  content-protection exclusion of the recorder panel need verification on a real
  screen/mic (couldn't be exercised in a headless dev environment).
- **Cross-platform**: built for Windows-primary (per CLAUDE.md). Wayland/macOS
  screen capture + `setContentProtection` support varies.
