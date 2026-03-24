// src/ai.js — AI categorization via Gemini API (vision-capable)
const fs = require('fs');
const path = require('path');

function getApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/GEMINI_API_KEY=(.+)/);
    if (match) return match[1].trim();
  } catch (e) {}
  return null;
}

async function callGemini(parts) {
  const key = getApiKey();
  if (!key) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
    }),
  });

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function categorize(comment, categories, imageDataURL = null) {
  const prompt =
    `You are a knowledge categorization assistant. Analyze the note` +
    (imageDataURL ? ' and the attached screenshot' : '') +
    `. Respond ONLY with valid JSON, no markdown:\n` +
    `{"category":"best fit from ${JSON.stringify(categories)} or create a new broad one",` +
    `"tags":["2-4","short","tags"],"summary":"1-line context, max 12 words"}\n\n` +
    `Note: "${comment}"`;

  const parts = [];
  if (imageDataURL) {
    const base64 = imageDataURL.replace(/^data:image\/\w+;base64,/, '');
    parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
  }
  parts.push({ text: prompt });

  try {
    return await callGemini(parts);
  } catch (e) {
    console.error('[AI] categorize error:', e.message);
    return null;
  }
}

async function search(query, clips) {
  const clipList = clips
    .map(
      (c) =>
        `ID:${c.id}|Cat:${c.category}|Tags:${(c.tags || []).join(',')}|Comment:${c.comment}|AI:${c.aiSummary || ''}|Extra:${(c.comments || []).map((x) => x.text).join(';')}`
    )
    .join('\n');

  try {
    return await callGemini([
      {
        text: `Find matching clips for: "${query}". Return ONLY a JSON array of IDs, most relevant first. No markdown.\nClips:\n${clipList}`,
      },
    ]);
  } catch (e) {
    console.error('[AI] search error:', e.message);
    return null;
  }
}

module.exports = { categorize, search, getApiKey };
