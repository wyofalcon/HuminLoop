// src/ai.js — AI categorization + search via Vertex AI Gemini (billed to GCP)

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ── Constants ──

const MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const GENERATION_CONFIG = { temperature: 0.3, maxOutputTokens: 600 };

// ── System Prompts ──

const CATEGORIZE_SYSTEM = `You are the AI backend for Sciurus, an ADHD-friendly knowledge-capture tool.
The user just captured a screenshot of something on their screen and wrote a quick note about it.
They're moving fast — your job is to do the organizing they don't have time for. Analyze EVERYTHING
available — the screenshot, the note, and any visible UI elements, URLs, text, or context in the
image — and return structured metadata so they can find this later.

Rules:
- Pick the single best category from the existing list. Only invent a new one if nothing fits at all.
  New categories should be broad and reusable (e.g. "Networking", not "That One VPN Thing").
- Tags should be specific, lowercase, and useful for search (e.g. "powertoys", "clipboard", "ai").
- The summary should capture WHY this is worth saving, not just describe the screenshot.
- If you can see a URL in the screenshot or infer one from the content, include it.
- Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

JSON schema:
{
  "category": "string — existing category or a new broad one",
  "tags": ["string array — 2 to 5 short lowercase tags"],
  "summary": "string — 1-2 sentences on what this is and why it matters",
  "url": "string — extracted URL if visible, otherwise empty string"
}`;

const SEARCH_SYSTEM = `You are the search backend for Sciurus, a knowledge-capture tool.
The user is searching their saved clips using natural language. They may use vague phrasing,
nicknames, or partial recall (e.g. "that paste thing for Marcus", "gpu driver fix from last week").

You receive a list of clips with their metadata. Your job is to find the most relevant matches.
Consider: the comment text, AI summary, tags, category, and any thread comments.
Rank by relevance — best match first. Return between 0 and 10 results.

Return ONLY a JSON array of clip ID strings, most relevant first. No markdown, no explanation.
Example: ["1711234567890", "1711234512345"]
If nothing matches, return: []`;

// ── State ──

let authClient = null;
let projectId = null;

// ── Public API ──

/** Initialize Vertex AI auth using the GCP service account. */
function init() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.log('[AI] No credentials.json — AI disabled.');
    return false;
  }
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    projectId = creds.project_id;
    authClient = new google.auth.GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    console.log(`[AI] Vertex AI ready (project: ${projectId}, model: ${MODEL})`);
    return true;
  } catch (e) {
    console.error('[AI] Init failed:', e.message);
    return false;
  }
}

/** Returns true if Vertex AI is configured and ready. */
function isEnabled() {
  return !!authClient && !!projectId;
}

/** Categorize a clip using Gemini vision. Returns structured metadata or null. */
async function categorize(comment, categories, imageDataURL = null) {
  const userText = `Existing categories: ${JSON.stringify(categories)}\n\nUser's note: "${comment}"`;
  const parts = [];
  if (imageDataURL) {
    const base64 = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
  }
  parts.push({ text: userText });

  try {
    const result = await callGemini(CATEGORIZE_SYSTEM, parts);
    if (!result) return null;
    // Ensure expected fields exist
    if (!result.category) result.category = 'Uncategorized';
    if (!Array.isArray(result.tags)) result.tags = [];
    if (!result.summary) result.summary = comment;
    if (!result.url) result.url = '';
    return result;
  } catch (e) {
    console.error('[AI] Categorize error:', e.message);
    return null;
  }
}

/** Search clips by natural-language query. Returns an array of matching IDs or null. */
async function search(query, clips) {
  const clipList = clips
    .map((c) => {
      const fields = [`ID: ${c.id}`, `Category: ${c.category}`];
      if (c.comment) fields.push(`Note: ${c.comment}`);
      if (c.aiSummary) fields.push(`Summary: ${c.aiSummary}`);
      if (c.tags?.length) fields.push(`Tags: ${c.tags.join(', ')}`);
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

/** Send a request to the Vertex AI Gemini endpoint and parse the JSON response. */
async function callGemini(systemInstruction, parts) {
  if (!isEnabled()) return null;

  const token = await authClient.getAccessToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}`
    + `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: GENERATION_CONFIG,
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { init, isEnabled, categorize, search };
