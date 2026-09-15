/* ─────────────────────────────────────────────────────────────────────────────
 * Ring of 12 — API server (instrumented build)
 *
 * render.yaml-compatible env vars (Render.com → service → Environment):
 *
 *   LLM_API_KEY   (REQUIRED)  Emergent LLM API key.
 *                 The key previously committed to this repo is LEAKED in the
 *                 public git history and MUST be rotated: revoke it in the
 *                 Emergent dashboard, generate a new key, and set it here.
 *                 Never commit an API key to the repo again.
 *
 *   PORT          (optional)  Set automatically by Render. Defaults to 3000
 *                 for local development.
 *
 * Endpoints:
 *   GET  /        health check (also reports live endpoints + LLM config)
 *   POST /ask     full Ring of 12 run (12 seats + Agent Zero synthesis)
 *   POST /single  plain single-perspective answer (for the compare feature)
 *   POST /log     anonymous feedback intake (JSONL file + rate limited)
 * ───────────────────────────────────────────────────────────────────────────── */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); /* correct req.ip behind Render's proxy */
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LLM_BASE_URL = 'https://integrations.emergentagent.com/llm';

/* REQUIRED — never hardcode the key in this file. See header note about the
 * previously leaked key: it must be rotated in the Emergent dashboard. */
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = 'gpt-4o-mini';

if (!LLM_API_KEY) {
  console.warn('WARNING: LLM_API_KEY is not set — /ask and /single will return 500 until it is configured.');
}

const SYSTEM_PROMPT = `You are the Ring of 12 — twelve psychological archetypes that each analyze a question from a unique angle. When given a question, respond in valid JSON only, no markdown, no explanation outside the JSON.

Return this exact structure:
{
  "seats": [
    {"seat": "I", "name": "Mnemosyne", "zodiac": "Cancer", "answer": "...2-3 sentences from this seat's perspective..."},
    {"seat": "II", "name": "Themis", "zodiac": "Libra", "answer": "..."},
    {"seat": "III", "name": "Athena", "zodiac": "Capricorn", "answer": "..."},
    {"seat": "IV", "name": "Hephaestus", "zodiac": "Taurus", "answer": "..."},
    {"seat": "V", "name": "Cupid", "zodiac": "Libra", "answer": "..."},
    {"seat": "VI", "name": "Dionysus", "zodiac": "Pisces", "answer": "..."},
    {"seat": "VII", "name": "Aphrodite", "zodiac": "Taurus", "answer": "..."},
    {"seat": "VIII", "name": "Hermes", "zodiac": "Gemini", "answer": "..."},
    {"seat": "IX", "name": "Apollo", "zodiac": "Leo", "answer": "..."},
    {"seat": "X", "name": "Clio", "zodiac": "Virgo", "answer": "..."},
    {"seat": "XI", "name": "Astraea", "zodiac": "Virgo", "answer": "..."},
    {"seat": "XII", "name": "Prometheus", "zodiac": "Aries", "answer": "..."}
  ],
  "synthesis": "...Agent Zero braids all 12 perspectives into one 3-4 sentence truth here..."
}

Each seat's angle:
- Mnemosyne (I, Cancer): Memory and past experience
- Themis (II, Libra): Justice, fairness, law
- Athena (III, Capricorn): Strategic wisdom and best action
- Hephaestus (IV, Taurus): What can be built or made
- Cupid (V, Libra): What the heart wants and what it costs
- Dionysus (VI, Pisces): Instinct and raw feeling
- Aphrodite (VII, Taurus): Beauty, harmony, what is worth preserving
- Hermes (VIII, Gemini): How to communicate it and to whom
- Apollo (IX, Leo): Evidence, patterns, prediction
- Clio (X, Virgo): Historical record of similar situations
- Astraea (XI, Virgo): Ethical and moral reading
- Prometheus (XII, Aries): The bold new path this opens

Agent Zero does NOT soften, hedge, or suggest. It identifies the point where the most seats converge and states the truth plainly -- no corporate language, no "may help", no "could lead to". It delivers a verdict: direct, grounded, specific to the question. 3-4 sentences. The first sentence names the core truth. The second names what the seats in disagreement are actually afraid of. The third names what Prometheus sees that the others miss. End with the one thing the questioner should carry forward.`;

const SINGLE_SYSTEM_PROMPT = 'Answer the question directly in 3-4 sentences, single perspective, no archetypes.';

/* ── Shared LLM call ── */
async function callLLM(systemPrompt, userContent, opts) {
  const llmRes = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: (opts && opts.temperature) || 0.8,
      max_tokens: (opts && opts.maxTokens) || 3000
    })
  });

  if (!llmRes.ok) {
    const errText = await llmRes.text();
    const err = new Error('LLM API error');
    err.status = llmRes.status;
    err.detail = errText;
    throw err;
  }

  const llmData = await llmRes.json();
  return (llmData.choices && llmData.choices[0] && llmData.choices[0].message && llmData.choices[0].message.content) || '';
}

/* Strip markdown fences if the model wraps the JSON in them. */
function stripFences(raw) {
  let cleaned = (raw || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

function validQuestion(q) {
  return typeof q === 'string' && !!q.trim() && q.trim().length <= 2000;
}

/* ── Health check ── */
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Ring of 12',
    endpoints: ['/ask', '/single', '/log'],
    llmConfigured: !!LLM_API_KEY
  });
});

/* ── Full Ring run ── */
app.post('/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!validQuestion(question)) {
    return res.status(400).json({ error: 'Missing or empty "question" field (max 2000 chars).' });
  }

  if (!LLM_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured -- LLM_API_KEY is not set.' });
  }

  try {
    const raw = await callLLM(SYSTEM_PROMPT, question.trim(), { temperature: 0.8, maxTokens: 3000 });

    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch (parseErr) {
      console.error('JSON parse failed. Raw:', raw);
      return res.status(502).json({ error: 'LLM returned invalid JSON.', raw: stripFences(raw) });
    }

    /* Validate structure */
    if (!parsed.seats || !Array.isArray(parsed.seats) || parsed.seats.length < 12 || !parsed.synthesis) {
      return res.status(502).json({ error: 'LLM returned incomplete structure.', raw: parsed });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('Server error:', err.status || '', err.detail || err.message || err);
    return res.status(err.status ? 502 : 500).json({ error: 'LLM request failed.' });
  }
});

/* ── Single-perspective answer (singularity comparison) ── */
app.post('/single', async (req, res) => {
  const { question } = req.body || {};
  if (!validQuestion(question)) {
    return res.status(400).json({ error: 'Missing or empty "question" field (max 2000 chars).' });
  }

  if (!LLM_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured -- LLM_API_KEY is not set.' });
  }

  try {
    const answer = await callLLM(SINGLE_SYSTEM_PROMPT, question.trim(), { temperature: 0.7, maxTokens: 400 });
    return res.json({ answer: answer.trim() });
  } catch (err) {
    console.error('Single-answer error:', err.status || '', err.detail || err.message || err);
    return res.status(err.status ? 502 : 500).json({ error: 'LLM request failed.' });
  }
});

/* ── Anonymous feedback intake ── */
const LOG_FILE = path.join(__dirname, 'ring12_feedback.log');
const ALLOWED_RATINGS = ['changed', 'confirmed', 'missed'];
const LOG_RATE_LIMIT = 30; /* requests per minute per IP */

/* Simple in-memory per-IP rate limiter (fixed 60s window). */
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60 * 1000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > LOG_RATE_LIMIT;
}

app.post('/log', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded (30 requests/minute).' });
  }

  const { question, rating, comment, ts, userAgent } = req.body || {};

  if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
    return res.status(400).json({ error: 'Invalid "question" (required string, max 2000 chars).' });
  }
  if (!ALLOWED_RATINGS.includes(rating)) {
    return res.status(400).json({ error: 'Invalid "rating" (must be one of: changed, confirmed, missed).' });
  }
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)) {
    return res.status(400).json({ error: 'Invalid "comment" (string, max 1000 chars).' });
  }

  const entry = {
    question: question.trim(),
    rating,
    comment: typeof comment === 'string' ? comment.trim() : '',
    ts: typeof ts === 'string' ? ts : new Date().toISOString(),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : ''
  };

  const line = JSON.stringify(entry) + '\n';
  console.log('[feedback]', line.trim());
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) {
      console.error('Log write failed:', err);
      return res.status(500).json({ error: 'Could not store feedback.' });
    }
    return res.json({ ok: true });
  });
});

app.listen(PORT, () => {
  console.log(`Ring of 12 API listening on port ${PORT}`);
});
