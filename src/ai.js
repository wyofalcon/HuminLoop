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
const CORE_INTRO = `You are the AI backend for Sciurus, an ADHD-friendly knowledge-capture tool.
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

// State: which blocks are enabled (loaded from DB, defaults to all on)
let enabledBlocks = null; // { category: true, project: true, ... }
let customBlocks = []; // user-added custom instruction blocks

const SEARCH_SYSTEM = `You are the search backend for Sciurus, a knowledge-capture tool.
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

async function callGemini(systemInstruction, parts) {
  if (!isEnabled()) return null;

  let url, headers;

  if (authMode === 'apikey') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiApiKey}`;
    headers = { 'Content-Type': 'application/json' };
  } else {
    const token = await getAccessToken();
    url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${vertexCreds.project_id}`
      + `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: GENERATION_CONFIG,
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

const SUMMARIZE_SYSTEM = `You are the summarization backend for Sciurus, a knowledge-capture tool.
You receive a list of notes from a single project. Each note has an ID and text written by the user.
For each note, generate an actionable AI prompt that another AI (like Copilot or ChatGPT) could use
to fix, implement, or resolve the issue described in the note. The prompt should:
- State the problem or task clearly in imperative form (e.g. "Fix the…", "Implement…", "Refactor…")
- Include relevant technical context: file names, function names, error messages, tools, or libraries mentioned
- Be specific enough to act on without seeing the original screenshot
- If the note describes a working solution or reference, frame it as "Apply this pattern: …" or "Use this approach: …"
- Keep it to 1-3 sentences — concise but complete enough for an AI to start working immediately

Return ONLY a valid JSON array. No markdown fences, no explanation.
Each element: { "id": "string — the note ID", "summary": "string — the actionable AI prompt" }
If a note is empty or unintelligible, return a fallback like "Review this note — insufficient context to generate a fix prompt."`;

async function summarizeNotes(notes) {
  if (!isEnabled() || !notes.length) return [];

  const input = notes.map((n) => ({ id: n.id, note: n.comment || '' }));
  try {
    const result = await callGemini(SUMMARIZE_SYSTEM, [
      { text: JSON.stringify(input) },
    ]);
    if (Array.isArray(result)) return result;
    return [];
  } catch (e) {
    console.error('[AI] Summarize notes error:', e.message);
    return [];
  }
}

module.exports = {
  init, isEnabled, categorize, search, summarizeNotes,
  getCategorizePrompt, getPromptBlocks, setPromptBlocks, resetPromptBlocks, estimateTokens,
};
