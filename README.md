# Sciurus! — AI-Powered Knowledge Capture

**Sciurus** (Latin: *squirrel*) — also meaning *shadow* and *tail*.

Built by someone with ADHD who needed a way to stash knowledge mid-task
without losing the thread. Like a squirrel burying acorns before darting
to the next tree, Sciurus lets you capture what's on your screen in one
quick motion — screenshot, note, done — and trust that AI will sort it
for you later. The shadow-tail meaning fits too: every idea casts a
shadow you'll want to find again, and this tool is the tail that
follows your train of thought so you don't have to.

## How It Works

1. Press `Ctrl+Shift+Q` (or your MX Master button)
2. Capture popup appears with screenshot preview
3. Type a quick note and hit Enter
4. Gemini 2.5 Flash analyzes the screenshot + note (vision)
5. Auto-categorized, tagged, and saved locally + synced to Google Sheets
6. Browse, search, and manage clips in the main window

## Features

- **Clipboard watcher** — auto-detects new screenshots
- **Gemini vision AI** — analyzes screenshots for smart categorization
- **AI search** — natural language search across all clips
- **Local-first storage** — instant, works offline (electron-store)
- **Google Sheets sync** — background cloud backup
- **System tray** — runs quietly in background
- **Threaded comments** — add follow-up notes to any clip

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Google Cloud Setup
- Go to https://console.cloud.google.com/
- Create a project (or use existing)
- Enable the **Vertex AI API** and **Google Sheets API**
- Go to Credentials > Create Credentials > **Service Account**
- Download the JSON key and save as `credentials.json` in this folder

This single service account powers both Gemini AI (via Vertex AI)
and Google Sheets sync — all billed to your GCP credits.

### 3. Google Sheets Sync (optional)

#### Create & Configure the Sheet
Due to Google Cloud restrictions, service accounts start with 0 bytes of
Drive quota and cannot create new files. Create the sheet manually:

1. Go to https://sheets.google.com and create a new blank spreadsheet
2. Click **Share** and add your service account email as **Editor**
   (find the email in `credentials.json` under `client_email`)
3. Copy the Sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`
4. Add to `.env`: `GOOGLE_SHEET_ID=<SHEET_ID>`

### 4. Run Sciurus
```bash
npm start
```

## Logi MX Master 4 Shortcut

1. Open **Logi Options+** > select MX Master 4
2. Go to **Buttons** > pick a button (thumb/gesture)
3. Set action to **Keystroke** > enter `Ctrl+Shift+Q`
4. Now that button triggers Sciurus!

## Project Structure

```
sciurus/
├── src/
│   ├── main.js          # Electron main process — tray, hotkey, IPC, Sheets sync
│   ├── ai.js            # Gemini 2.5 Flash via Vertex AI (vision + text)
│   ├── sheets.js        # Google Sheets background sync
│   └── preload.js       # Context bridge for renderer
├── renderer/
│   ├── index.html       # Main window — clip browser
│   ├── index.js         # Clip list, AI search, filtering
│   ├── index.css        # Main window styles
│   ├── capture.html     # Capture popup
│   ├── capture.js       # Capture popup logic
│   └── capture.css      # Capture popup styles
├── .env                 # API keys (git-ignored)
├── .env.example         # Template for .env
├── credentials.json     # Google service account (git-ignored)
└── package.json
```
