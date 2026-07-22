// src/ai.js — AI categorization + search via Gemini / Vertex AI
// Zero heavy dependencies — uses native fetch + crypto for auth

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Constants ──

const MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const GENERATION_CONFIG = { temperature: 0.3, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } };
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// ── System Prompts ──

// Prompt is composed from toggleable instruction blocks.
// Core role + JSON output are always included. Everything else is toggleable.

const PROMPT_BLOCKS = [
  {
    id: 'category',
    label: 'Category assignment',
    desc: 'Pick the best category from existing list or create new broad ones',
    locked: false,
    default: true,
    text: `Rules for CATEGORY:
- Pick the single best category from the existing list. Only invent a new one if nothing fits at all.
  New categories should be broad and reusable (e.g. "Networking", not "That One VPN Thing").
- Consider the full context: what app is visible, what topic the note describes, what kind of
  problem or task this relates to, and any text visible in the screenshot.
- If the screenshot shows code, a terminal, or a dev tool — look at what project/repo/file is
  visible and match it to the best category.`,
  },
  {
    id: 'project',
    label: 'Project matching',
    desc: 'Match clips to projects by repo path, window title, or topic alignment',
    locked: false,
    default: true,
    text: `Rules for PROJECT:
- You may also receive a list of projects. Each project has a name, description, and optionally
  a local repo path.
- If the screenshot or note clearly relates to one of these projects, include its ID in your response.
- Match by: visible repo/folder names in the screenshot, file paths, project names in window titles
  or tab titles, topic alignment between the note and the project description, or any other clue.
- If no project matches, return null for project_id. Do NOT force a match.
- Repo path matching: if the screenshot shows a path like "C:\\Users\\...\\projects\\cvstomize"
  and a project has repo_path "C:\\Users\\...\\projects\\cvstomize", that's a strong match.`,
  },
  {
    id: 'tags',
    label: 'Tag generation',
    desc: 'Generate 2-5 searchable tags from screenshot content',
    locked: false,
    default: true,
    text: `Rules for TAGS:
- Tags should be specific, lowercase, and useful for search (e.g. "powertoys", "clipboard", "ai").
- Include the project name as a tag if you assign a project.
- Include technology names, tool names, and key concepts visible in the screenshot.`,
  },
  {
    id: 'summary',
    label: 'Summary generation',
    desc: 'Write a 1-2 sentence summary of why the clip matters',
    locked: false,
    default: true,
    text: `Rules for SUMMARY:
- The summary should capture WHY this is worth saving, not just describe the screenshot.
- Be specific — mention the tool, feature, error, or concept. 1-2 sentences max.`,
  },
  {
    id: 'markup',
    label: 'Markup color detection',
    desc: 'Red = bug, Green = approved, Pink = question — read annotation colors as intent',
    locked: false,
    default: true,
    text: `Rules for MARKUP COLORS:
- The user annotates screenshots with colored markers before capturing. The colors have meaning:
  - RED marker = bug, error, or problem that needs fixing
  - GREEN marker = working correctly, approved, or "keep this"
  - PINK marker = question, needs discussion, or "ask about this"
- If you see colored markup/annotations on the screenshot, factor the color meaning into your
  category, tags, and summary. For example, red markup on a stack trace → tag with "bug".
- Include a "markup" tag (e.g. "markup-red", "markup-green", "markup-pink") if annotations are visible.`,
  },
  {
    id: 'url',
    label: 'URL extraction',
    desc: 'Extract visible URLs from the screenshot',
    locked: false,
    default: true,
    text: `Rules for URL:
- If you can see a URL in the screenshot or infer one from the content, include it.`,
  },
];

// These are always included regardless of toggles
const CORE_INTRO = `You are the AI backend for HuminLoop, an ADHD-friendly knowledge-capture tool.
The user just captured a screenshot of something on their screen and wrote a quick note about it.
They're moving fast — your job is to do the organizing they don't have time for. Analyze EVERYTHING
available — the screenshot, the note, and any visible UI elements, URLs, text, or context in the
image — and return structured metadata so they can find this later.`;

const CORE_OUTPUT = `Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

JSON schema:
{
  "category": "string — existing category or a new broad one",
  "project_id": "number or null — ID of the matching project, or null if none",
  "tags": ["string array — 2 to 5 short lowercase tags"],
  "summary": "string — 1-2 sentences on what this is and why it matters",
  "url": "string — extracted URL if visible, otherwise empty string"
}`;

const DEFAULT_ANNOTATION_COLORS = [
  { id: 'red', hex: '#FF0000', label: 'Remove, delete, or fix what is marked', shortLabel: 'remove' },
  { id: 'green', hex: '#00FF00', label: 'Add or create something at this location', shortLabel: 'add' },
  { id: 'pink', hex: '#FF69B4', label: 'Reference point — identifying or pointing out this element for context', shortLabel: 'reference' },
];

function buildFocusedPrompt(annotationColors) {
  const colors = annotationColors && annotationColors.length > 0 ? annotationColors : DEFAULT_ANNOTATION_COLORS;
  const colorLines = colors.map(c =>
    `- ${c.id.toUpperCase()} markings (${c.hex}): ${c.label}`
  ).join('\n');

  return `You are analyzing a screenshot with colored annotations from a developer.
The annotations follow this color coding:
${colorLines}

PRIORITY: The developer's written note is the primary source of intent. If the note clarifies, overrides, or adds nuance to what the color annotations suggest, follow the note. Annotations are also expressions of intent and should be treated as instructions — but when the note and annotations conflict, the note wins.

Use the project context and session information to generate a more specific and relevant prompt. Reference the current branch, recent work, and known issues where they relate to what the annotations and note describe.

Generate a single, specific, actionable prompt that a coding AI could execute directly. Be concrete about what to change based on the annotations and note. Reference marked elements as context when relevant. Output only the prompt text, no explanation or formatting.`;
}

// State: which blocks are enabled (loaded from DB, defaults to all on)
let enabledBlocks = null; // { category: true, project: true, ... }
let customBlocks = []; // user-added custom instruction blocks

const SEARCH_SYSTEM = `You are the search backend for HuminLoop, a knowledge-capture tool.
The user is searching their saved clips using natural language. They may use vague phrasing,
nicknames, or partial recall (e.g. "that paste thing for Marcus", "gpu driver fix from last week").

You receive a list of clips with their metadata. Your job is to find the most relevant matches.
Consider: the comment text, AI summary, tags, category, project name, and any thread comments.
Rank by relevance — best match first. Return between 0 and 10 results.

Return ONLY a JSON array of clip ID strings, most relevant first. No markdown, no explanation.
Example: ["1711234567890", "1711234512345"]
If nothing matches, return: []`;

// ── State ──

let authMode = 'none'; // 'apikey' | 'vertex' | 'none'
let vertexCreds = null; // parsed credentials.json
let cachedToken = null; // { token, expiresAt }
let geminiApiKey = null;

// ── Vertex AI JWT Auth (replaces googleapis — saves 196MB) ──

function createJWT(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(creds.private_key, 'base64url');

  return `${header}.${payload}.${signature}`;
}

async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }

  const jwt = createJWT(vertexCreds);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token exchange failed: ${data.error_description || data.error}`);

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return cachedToken.token;
}

// ── Public API ──

function init() {
  const mode = process.env.AI_AUTH_MODE || 'auto';

  // Try API key first (simplest)
  if (mode === 'apikey' || mode === 'auto') {
    const key = process.env.GEMINI_API_KEY;
    if (key && key.trim()) {
      geminiApiKey = key.trim();
      authMode = 'apikey';
      console.log(`[AI] Gemini API key ready (model: ${MODEL})`);
      return true;
    }
  }

  // Try Vertex AI (service account — lightweight JWT auth)
  if (mode === 'vertex' || mode === 'auto') {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      try {
        vertexCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        authMode = 'vertex';
        console.log(`[AI] Vertex AI ready (project: ${vertexCreds.project_id}, model: ${MODEL})`);
        return true;
      } catch (e) {
        console.error('[AI] Vertex AI init failed:', e.message);
      }
    }
  }

  console.log('[AI] No AI credentials configured — AI disabled.');
  authMode = 'none';
  return false;
}

function isEnabled() {
  return authMode !== 'none';
}

async function categorize(comment, categories, imageDataURL = null, projects = null, windowMeta = null) {
  let userText = `Existing categories: ${JSON.stringify(categories)}\n\n`;

  if (projects && projects.length > 0) {
    const projectList = projects.map((p) => {
      const parts = [`ID: ${p.id}`, `Name: ${p.name}`];
      if (p.description) parts.push(`Description: ${p.description}`);
      if (p.repo_path) parts.push(`Repo: ${p.repo_path}`);
      return parts.join(' | ');
    }).join('\n');
    userText += `Projects:\n${projectList}\n\n`;
  } else {
    userText += `Projects: none\n\n`;
  }

  if (windowMeta && (windowMeta.windowTitle || windowMeta.processName)) {
    userText += `Window context: title="${windowMeta.windowTitle || ''}", process="${windowMeta.processName || ''}"\n\n`;
  }

  userText += `User's note: "${comment}"`;

  const parts = [];
  if (imageDataURL) {
    const base64 = imageDataURL.replace(/^data:image\/[^;]+;base64,/, '');
    parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
  }
  parts.push({ text: userText });

  try {
    const result = await callGemini(getCategorizePrompt(), parts);
    if (!result) return null;
    if (!result.category) result.category = 'Uncategorized';
    if (!Array.isArray(result.tags)) result.tags = [];
    if (!result.summary) result.summary = comment;
    if (!result.url) result.url = '';
    if (result.project_id !== undefined && result.project_id !== null) {
      result.project_id = parseInt(result.project_id, 10);
      if (isNaN(result.project_id)) result.project_id = null;
    } else {
      result.project_id = null;
    }
    return result;
  } catch (e) {
    console.error('[AI] Categorize error:', e.message);
    return null;
  }
}

async function generateFocusedPrompt(comment, imageDataURL, windowMeta = {}, project = {}, workflowContext = {}, annotationColors = null) {
  if (!isEnabled()) return null;

  const parts = [];
  if (comment) parts.push(`Developer's note: ${comment}`);
  if (windowMeta.windowTitle) parts.push(`Window: ${windowMeta.processName || 'unknown'} — ${windowMeta.windowTitle}`);
  if (project.name) parts.push(`Project: ${project.name}`);
  if (project.repo_path) parts.push(`Repository: ${project.repo_path}`);
  if (project.description) parts.push(`Description: ${project.description}`);
  if (workflowContext.session) parts.push(`\nCurrent development session context:\n${workflowContext.session}`);
  if (workflowContext.audit) parts.push(`\nRecent code audit findings:\n${workflowContext.audit}`);

  const userText = parts.join('\n');

  const messageParts = [];
  if (imageDataURL) {
    const mimeMatch = imageDataURL.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64 = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    messageParts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }
  messageParts.push({ text: userText });

  try {
    const result = await callGemini(buildFocusedPrompt(annotationColors), messageParts, { raw: true });
    if (!result) return null;
    return result.replace(/^["'`]+|["'`]+$/g, '').trim();
  } catch (e) {
    console.error('[HuminLoop AI] Focused prompt generation failed:', e.message);
    return null;
  }
}

async function search(query, clips) {
  const clipList = clips
    .map((c) => {
      const fields = [`ID: ${c.id}`, `Category: ${c.category}`];
      if (c.comment) fields.push(`Note: ${c.comment}`);
      if (c.aiSummary) fields.push(`Summary: ${c.aiSummary}`);
      if (c.tags?.length) fields.push(`Tags: ${c.tags.join(', ')}`);
      if (c.projectName) fields.push(`Project: ${c.projectName}`);
      if (c.comments?.length) fields.push(`Thread: ${c.comments.map((x) => x.text).join('; ')}`);
      return fields.join(' | ');
    })
    .join('\n');

  try {
    return await callGemini(SEARCH_SYSTEM, [
      { text: `Search query: "${query}"\n\nClips:\n${clipList}` },
    ]);
  } catch (e) {
    console.error('[AI] Search error:', e.message);
    return null;
  }
}

// ── Internal ──

async function callGemini(systemInstruction, parts, options = {}) {
  if (!isEnabled()) return null;

  // Most callers use the defaults (categorize/search/focused). Audio work
  // overrides: `model` (TTS needs a different model), `generationConfig`
  // (bigger token cap for transcripts, AUDIO modality for TTS), `timeoutMs`
  // (audio can exceed the 30s image budget), and `wantAudio` (return the
  // response's inline audio bytes instead of text).
  const {
    raw = false,
    model = MODEL,
    generationConfig = GENERATION_CONFIG,
    timeoutMs = 30000,
    wantAudio = false,
  } = options;

  let url, headers;

  if (authMode === 'apikey') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
    headers = { 'Content-Type': 'application/json' };
  } else {
    const token = await getAccessToken();
    url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${vertexCreds.project_id}`
      + `/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  // TTS models reject a systemInstruction — callers pass null to omit it.
  if (systemInstruction) requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  // Audio (TTS) responses carry bytes in an inlineData part, not text.
  if (wantAudio) {
    const outParts = data.candidates?.[0]?.content?.parts || [];
    for (const p of outParts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        return { data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'audio/L16;rate=24000' };
      }
    }
    return null;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (raw) return text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('[AI] Failed to parse response:', clean.slice(0, 200));
    return null;
  }
}

// ── Prompt Composition ──

/** Build the full prompt from enabled blocks. */
function getCategorizePrompt() {
  const enabled = enabledBlocks || getDefaultEnabledBlocks();
  const parts = [CORE_INTRO, ''];

  for (const block of PROMPT_BLOCKS) {
    if (enabled[block.id]) parts.push(block.text, '');
  }

  // Append any custom user blocks
  for (const cb of customBlocks) {
    if (cb.enabled) parts.push(cb.text, '');
  }

  parts.push(CORE_OUTPUT);
  return parts.join('\n');
}

function getDefaultEnabledBlocks() {
  const defaults = {};
  for (const b of PROMPT_BLOCKS) defaults[b.id] = b.default;
  return defaults;
}

/** Get the block definitions + their enabled state for the UI. */
function getPromptBlocks() {
  const enabled = enabledBlocks || getDefaultEnabledBlocks();
  return {
    blocks: PROMPT_BLOCKS.map(b => ({
      id: b.id, label: b.label, desc: b.desc, locked: b.locked,
      enabled: enabled[b.id] !== false,
      tokens: estimateTokens(b.text),
    })),
    custom: customBlocks.map(cb => ({
      id: cb.id, label: cb.label, text: cb.text,
      enabled: cb.enabled,
      tokens: estimateTokens(cb.text),
    })),
    coreTokens: estimateTokens(CORE_INTRO) + estimateTokens(CORE_OUTPUT),
    totalTokens: estimateTokens(getCategorizePrompt()),
  };
}

/** Update which blocks are enabled. */
function setPromptBlocks(enabled, custom) {
  enabledBlocks = enabled || getDefaultEnabledBlocks();
  customBlocks = custom || [];
}

/** Reset all blocks to defaults. */
function resetPromptBlocks() {
  enabledBlocks = getDefaultEnabledBlocks();
  customBlocks = [];
}

/** Rough token estimate — ~4 chars per token for English text. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function getSummarizePrompt() {
  const base = `You are the summarization backend for HuminLoop, a knowledge-capture tool.
You receive a note from a project, optionally with a screenshot. Generate an actionable AI prompt
that another AI (like Copilot or ChatGPT) could use to fix, implement, or resolve the issue.
The prompt should:
- State the problem or task clearly in imperative form (e.g. "Fix the…", "Implement…", "Refactor…")
- Include relevant technical context: file names, function names, error messages, tools, or libraries mentioned
- If a screenshot is provided, analyze it for visible code, errors, UI issues, file paths, and tool context
- If the note describes a working solution or reference, frame it as "Apply this pattern: …" or "Use this approach: …"
- Keep it to 1-3 sentences — concise but complete enough for an AI to start working immediately`;

  // Include user custom rules so they apply to summarization too
  const enabled = enabledBlocks || getDefaultEnabledBlocks();
  const extras = [];
  for (const cb of customBlocks) {
    if (cb.enabled) extras.push(cb.text);
  }

  const output = `Return ONLY valid JSON. No markdown fences, no explanation.
Schema: { "id": "string — the note ID", "summary": "string — the actionable AI prompt" }
If the note is empty or unintelligible, return a fallback like "Review this note — insufficient context to generate a fix prompt."`;

  return [base, ...extras, output].join('\n\n');
}

async function summarizeNotes(notes) {
  if (!isEnabled() || !notes.length) return [];

  const results = [];
  for (const n of notes) {
    try {
      const parts = [];
      if (n.imageDataURL) {
        const base64 = n.imageDataURL.replace(/^data:image\/[^;]+;base64,/, '');
        parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
      }
      parts.push({ text: `Note ID: ${n.id}\nUser's note: "${n.comment || ''}"` });
      const result = await callGemini(getSummarizePrompt(), parts);
      if (result && result.summary) {
        results.push({ id: n.id, summary: result.summary });
      }
    } catch (e) {
      console.error(`[AI] Summarize note ${n.id} error:`, e.message);
    }
  }
  return results;
}

const COMBINE_PROMPT = `You receive multiple related notes from a developer's project, each with an optional screenshot.
Synthesize ALL of them into ONE unified, actionable prompt that another AI coding tool can execute.
The combined prompt should:
- Merge related context from all notes into a coherent task description
- State the problem or task in imperative form (e.g. "Fix the…", "Implement…", "Refactor…")
- Include all relevant technical context: file names, function names, error messages, tools, libraries
- If screenshots are provided, analyze them for code, errors, UI issues, file paths — reference specifics
- Eliminate redundancy — don't repeat the same information from different notes
- Preserve nuances — if notes describe different aspects of the same issue, cover all angles
- Keep it focused and structured — use numbered steps if the task has multiple parts
Return ONLY the prompt text. No JSON, no markdown fences, no preamble.`;

async function generateCombinedPrompt(notes) {
  if (!isEnabled() || !notes.length) return '';

  const parts = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.imageDataURL) {
      const base64 = n.imageDataURL.replace(/^data:image\/[^;]+;base64,/, '');
      parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
    }
    parts.push({ text: `--- Note ${i + 1} (ID: ${n.id}) ---\n${n.comment || '(no text)'}` });
  }

  const result = await callGemini(COMBINE_PROMPT, parts, { raw: true });
  return typeof result === 'string' ? result.replace(/^["']|["']$/g, '') : '';
}

// ── Demos: transcription + dubbing ──

// Transcription can produce a long script, so raise the token cap well above
// the 2048 image default and give audio a 2-minute budget instead of 30s.
const TRANSCRIBE_CONFIG = { temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } };
const AUDIO_TIMEOUT_MS = 120000;

const DEMO_TRANSCRIPT_SYSTEM = `You are the demo-narration editor for HuminLoop.
You receive an audio recording of a developer narrating a product/feature demo while performing
actions on screen, plus a list of timestamped markers the developer dropped during recording
(moments they flagged as worth explaining).

Your job: produce a CLEAN, readable narration script the developer can read aloud to re-record or
present the demo. Remove filler words ("um", "uh", "like"), false starts, and rambling — but keep
every technical specific (file names, commands, feature names, numbers). Preserve the developer's
meaning and order. Break the narration into short segments aligned to what was said, each with an
approximate start time in SECONDS from the beginning of the recording.

Return ONLY valid JSON. No markdown fences, no explanation. Schema:
{
  "title": "string — a short title for this demo",
  "plain": "string — the full cleaned narration as readable paragraphs",
  "segments": [
    { "start": <number seconds>, "text": "<clean segment text>", "type": "speech" }
  ]
}
Rules:
- segment.start values must be non-decreasing and fall within the recording duration.
- Do NOT invent content that was not spoken. If a stretch has no speech, skip it.
- If the audio contains no discernible speech, return {"title":"","plain":"","segments":[]}.`;

/**
 * Transcribe + clean a demo's narration audio into a readable, timestamped script.
 * @param {string} audioBase64 - base64 audio (mic track, typically audio/webm)
 * @param {string} mime - audio mime type (detected from the file, NOT hardcoded)
 * @param {{markers?: Array, durationMs?: number, project?: object}} context
 * @returns {Promise<{title:string, plain:string, segments:Array}|null>}
 */
async function generateDemoTranscript(audioBase64, mime, context = {}) {
  if (!isEnabled() || !audioBase64) return null;
  const { markers = [], durationMs = 0, project = {} } = context;

  const ctx = [];
  if (project.name) ctx.push(`Project: ${project.name}`);
  if (project.description) ctx.push(`Project description: ${project.description}`);
  if (durationMs) ctx.push(`Recording length: ${Math.round(durationMs / 1000)} seconds`);
  if (markers.length) {
    const secs = markers.map(m => Math.round((m.t || 0) / 1000)).join(', ');
    ctx.push(`Developer dropped markers at these seconds (pay extra attention there): ${secs}`);
  }
  const userText = ctx.length ? ctx.join('\n') : 'Transcribe and clean up the demo narration.';

  const parts = [
    { inline_data: { mime_type: mime || 'audio/webm', data: audioBase64 } },
    { text: userText },
  ];

  try {
    const result = await callGemini(DEMO_TRANSCRIPT_SYSTEM, parts, {
      generationConfig: TRANSCRIBE_CONFIG,
      timeoutMs: AUDIO_TIMEOUT_MS,
    });
    if (!result) return null;
    if (!Array.isArray(result.segments)) result.segments = [];
    if (typeof result.plain !== 'string') result.plain = '';
    if (typeof result.title !== 'string') result.title = '';
    return result;
  } catch (e) {
    console.error('[AI] Demo transcript generation failed:', e.message);
    return null;
  }
}

// ── Demo script: transcript + activity metadata → polished voice-over ────────

const DEMO_SCRIPT_SYSTEM = `You are a voice-over script writer for HuminLoop product demos.
You receive:
1. A cleaned transcript of what a developer said while recording a screen demo (with segment start times in seconds).
2. Optional activity metadata captured alongside the recording: which application windows had focus over time, and how much the mouse moved (a proxy for on-screen action).
3. Optional markers the developer dropped at moments worth explaining.

Your job: write the FINAL narration script for this demo — the polished voice-over the developer
(or a TTS voice) will read over the video. Requirements:
- Ground every line in what was actually said and done. Use the window-focus timeline to name the
  apps/files on screen when it clarifies the story ("switching to the terminal…"), but NEVER invent
  actions that aren't supported by the transcript or activity data.
- Rewrite rough, rambling speech into clear, confident, present-tense narration. Keep every
  technical specific (file names, commands, feature names, numbers).
- Keep segments aligned to the original timing: each segment's start must stay close to when that
  content was originally spoken, so the narration matches what's on screen. Cover marker moments.
- Match the spoken pace — a segment should be readable in the time before the next one starts.
- Write it to be READ ALOUD: contractions are fine, no headings, no stage directions, no timestamps
  inside the text.

Return ONLY valid JSON. No markdown fences. Schema:
{
  "plain": "string — the full script as readable paragraphs",
  "segments": [ { "start": <number seconds>, "text": "<script line>" } ]
}`;

/**
 * Generate the final polished voice-over script from the transcript plus the
 * recording's activity metadata (window focus + cursor activity + markers).
 * @returns {Promise<{plain:string, segments:Array}|null>}
 */
async function generateDemoScript({ transcript, markers = [], speechSegments = [], activityLog = null, durationMs = 0, project = {} } = {}) {
  if (!isEnabled() || !transcript || !(transcript.plain || (transcript.segments || []).length)) return null;

  const ctx = [];
  if (project.name) ctx.push(`Project: ${project.name}`);
  if (project.description) ctx.push(`Project description: ${project.description}`);
  if (durationMs) ctx.push(`Recording length: ${Math.round(durationMs / 1000)} seconds`);

  ctx.push('', 'TRANSCRIPT (cleaned, with start times in seconds):');
  const segs = transcript.segments || [];
  if (segs.length) {
    for (const s of segs) ctx.push(`[${Math.round(s.start || 0)}s] ${s.text || ''}`);
  } else {
    ctx.push(transcript.plain);
  }

  if (markers.length) {
    ctx.push('', `Markers dropped by the developer (seconds): ${markers.map(m => Math.round((m.t || 0) / 1000)).join(', ')}`);
  }
  if (speechSegments.length) {
    ctx.push('', `Detected narration windows (seconds): ${speechSegments.map(s => `${s.start}-${s.end}`).join(', ')}`);
  }
  if (activityLog && Array.isArray(activityLog.focus) && activityLog.focus.length) {
    ctx.push('', 'Window focus timeline (what was on screen):');
    for (const f of activityLog.focus.slice(0, 80)) {
      ctx.push(`[${Math.round((f.t || 0) / 1000)}s] ${f.app || '?'} — ${f.title || ''}`);
    }
  }
  if (activityLog && Array.isArray(activityLog.cursor) && activityLog.cursor.length) {
    const busy = activityLog.cursor
      .filter(c => c.moves > 500)
      .map(c => `${Math.round((c.t || 0) / 1000)}s`);
    if (busy.length) ctx.push('', `High mouse-activity moments (lots happening on screen): ${busy.slice(0, 60).join(', ')}`);
  }

  try {
    const result = await callGemini(DEMO_SCRIPT_SYSTEM, [{ text: ctx.join('\n') }], {
      generationConfig: TRANSCRIBE_CONFIG,
      timeoutMs: AUDIO_TIMEOUT_MS,
    });
    if (!result || typeof result.plain !== 'string' || !result.plain) return null;
    if (!Array.isArray(result.segments)) result.segments = [];
    return result;
  } catch (e) {
    console.error('[AI] Demo script generation failed:', e.message);
    return null;
  }
}

// EXPERIMENTAL — text-to-speech "dub" of the cleaned narration. Requires a
// Gemini TTS preview model and is most reliable on the API-key surface; on some
// Vertex configs the model may be unavailable (returns null, logged).
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

/**
 * Synthesize spoken audio from narration text.
 * @param {string} text
 * @param {{voice?: string}} opts - prebuilt voice name (e.g. 'Kore', 'Puck')
 * @returns {Promise<{pcmBase64:string, sampleRate:number}|null>} raw PCM (wrap via media.pcmToWav)
 */
async function synthesizeDemoDub(text, { voice = 'Kore' } = {}) {
  if (!isEnabled() || !text) return null;
  const generationConfig = {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
  };
  const parts = [{ text: `Read the following demo narration aloud in a clear, friendly, professional voice:\n\n${text}` }];
  try {
    const audio = await callGemini(null, parts, {
      model: TTS_MODEL,
      generationConfig,
      timeoutMs: AUDIO_TIMEOUT_MS,
      wantAudio: true,
    });
    if (!audio || !audio.data) return null;
    const rateMatch = /rate=(\d+)/.exec(audio.mimeType || '');
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    return { pcmBase64: audio.data, sampleRate };
  } catch (e) {
    console.error('[AI] Demo dub (TTS) failed:', e.message);
    return null;
  }
}

module.exports = {
  init, isEnabled, categorize, generateFocusedPrompt, search, summarizeNotes, generateCombinedPrompt,
  generateDemoTranscript, generateDemoScript, synthesizeDemoDub,
  getCategorizePrompt, getPromptBlocks, setPromptBlocks, resetPromptBlocks, estimateTokens,
  DEFAULT_ANNOTATION_COLORS,
};
