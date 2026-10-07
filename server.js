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
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://integrations.emergentagent.com/llm';

/* REQUIRED — never hardcode the key in this file. See header note about the
 * previously leaked key: it must be rotated in the Emergent dashboard. */
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
/* LLM_CHAT_PATH lets the same server talk to any OpenAI-compatible provider (MiMo uses /v1/chat/completions). */
const LLM_CHAT_PATH = process.env.LLM_CHAT_PATH || '/v1/chat/completions';

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

/* ── Shared LLM call, with automatic fallback ──────────────────────────────
 * Providers are tried in order. Any failure (network error, non-200, empty reply, timeout)
 * moves on to the next one, so a visitor only sees an error when EVERY provider is down.
 * Order: 1) MiMo (the free primary)  2) Fireworks (prepaid backup)  3) Emergent (kept as the last backup).
 * A provider is skipped when its key is not set. Keys are read from environment variables only.
 * The last provider that answered is exposed as lastProvider for health checks. */
function buildProviders() {
  const list = [];
  if (process.env.LLM_API_KEY) {
    list.push({ name: process.env.LLM_PROVIDER_NAME || 'primary', base: LLM_BASE_URL, path: LLM_CHAT_PATH, key: process.env.LLM_API_KEY, model: LLM_MODEL });
  }
  if (process.env.FIREWORKS_API_KEY) {
    list.push({ name: 'fireworks', base: 'https://api.fireworks.ai/inference', path: '/v1/chat/completions', key: process.env.FIREWORKS_API_KEY, model: process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/gpt-oss-120b' });
  }
  if (process.env.EMERGENT_LLM_KEY) {
    list.push({ name: 'emergent', base: 'https://integrations.emergentagent.com/llm', path: '/v1/chat/completions', key: process.env.EMERGENT_LLM_KEY, model: 'gpt-4o-mini' });
  }
  return list;
}
const PROVIDER_TIMEOUT_MS = parseInt(process.env.PROVIDER_TIMEOUT_MS || '70000', 10);
let lastProvider = null;
const providerFails = {};

async function callOne(pv, systemPrompt, userContent, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const llmRes = await fetch(`${pv.base}${pv.path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pv.key}` },
      body: JSON.stringify({
        model: pv.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        temperature: (opts && opts.temperature) != null ? opts.temperature : 0.8,
        max_tokens: (opts && opts.maxTokens) || 3000
      })
    });
    if (!llmRes.ok) {
      const err = new Error('LLM API error');
      err.status = llmRes.status;
      err.detail = (await llmRes.text()).slice(0, 200);
      throw err;
    }
    const d = await llmRes.json();
    const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    if (!text.trim()) { const e = new Error('empty reply'); e.status = 0; throw e; }
    return text;
  } finally { clearTimeout(timer); }
}

async function callLLM(systemPrompt, userContent, opts) {
  const chain = buildProviders();
  if (!chain.length) { const e = new Error('no provider configured'); e.status = 500; throw e; }
  let lastErr = null;
  for (const pv of chain) {
    try {
      const text = await callOne(pv, systemPrompt, userContent, opts);
      lastProvider = pv.name;
      return text;
    } catch (err) {
      providerFails[pv.name] = (providerFails[pv.name] || 0) + 1;
      console.error('Provider failed:', pv.name, err.status || '', err.name === 'AbortError' ? 'timeout' : (err.detail || err.message));
      lastErr = err;
    }
  }
  throw lastErr;
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


/* ── Free-question gate ──────────────────────────────────────────────────
 * Every visitor gets FREE_LIMIT free Ring runs on the Federation key, counted
 * per IP address (a client-side counter is trivially cleared, so it is never
 * trusted). After that the page asks for the visitor's own key (used in their
 * browser, never sent here) or a paid plan. A global daily cap protects the
 * Federation's balance from a flood. The Owner token (OWNER_TOKEN env) skips
 * the gate for Roger and the Federation's own testing.
 * Honest limit: counts live in memory, so a restart or free-tier spin-down
 * resets them; people behind one shared IP share one allowance. */
const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '3', 10);
const FREE_DAILY_CAP = parseInt(process.env.FREE_DAILY_CAP || '300', 10);
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const SUBSCRIBE_URL = process.env.SUBSCRIBE_URL || '';
const usage = new Map();
const globalUse = { day: '', count: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
/* Render sits behind Cloudflare, so req.ip is a rotating Cloudflare edge address. The visitor's real address
 * is in CF-Connecting-IP (set by Cloudflare, which overwrites anything a client sends). Fall back to the
 * left-most X-Forwarded-For entry, then to req.ip. */
function clientIp(req) {
  const cf = (req.get('cf-connecting-ip') || '').trim();
  if (cf) return cf;
  const xf = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  return xf || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isOwner(req) {
  const t = req.get('x-owner-token') || '';
  return !!OWNER_TOKEN && t.length === OWNER_TOKEN.length && require('crypto').timingSafeEqual(Buffer.from(t), Buffer.from(OWNER_TOKEN));
}
function usageFor(ip) {
  const d = today();
  let u = usage.get(ip);
  if (!u || u.day !== d) { u = { day: d, asks: 0, singles: 0 }; usage.set(ip, u); }
  if (usage.size > 20000) { for (const [k, v] of usage) if (v.day !== d) usage.delete(k); }
  return u;
}
function globalToday() {
  const d = today();
  if (globalUse.day !== d) { globalUse.day = d; globalUse.count = 0; }
  return globalUse;
}
function quotaBody(req) {
  const u = usageFor(clientIp(req));
  return { freeLimit: FREE_LIMIT,
    providers: buildProviders().map(p => p.name),
    lastProvider,
    providerFails, used: u.asks, remaining: Math.max(0, FREE_LIMIT - u.asks), owner: isOwner(req), subscribeUrl: SUBSCRIBE_URL || null };
}
function gate(kind) {
  return (req, res, next) => {
    if (isOwner(req)) return next();
    const u = usageFor(clientIp(req));
    if (kind === 'ask') {
      if (u.asks >= FREE_LIMIT) {
        return res.status(402).json({ error: 'free_limit', message: 'Your ' + FREE_LIMIT + ' free questions are used. Add your own API key to keep going' + (SUBSCRIBE_URL ? ', or subscribe.' : '.'), freeLimit: FREE_LIMIT, used: u.asks, remaining: 0, subscribeUrl: SUBSCRIBE_URL || null });
      }
      if (globalToday().count >= FREE_DAILY_CAP) {
        return res.status(503).json({ error: 'daily_cap', message: 'The free allowance for today is used up. Add your own API key to keep going.', subscribeUrl: SUBSCRIBE_URL || null });
      }
    } else if (u.asks < 1 || u.singles >= FREE_LIMIT) {
      return res.status(402).json({ error: 'free_limit', message: 'The comparison needs a free Ring question first, and is limited to ' + FREE_LIMIT + ' a day.', freeLimit: FREE_LIMIT });
    }
    next();
  };
}
function countUse(req, kind) {
  if (isOwner(req)) return;
  const u = usageFor(clientIp(req));
  if (kind === 'ask') { u.asks += 1; globalToday().count += 1; } else { u.singles += 1; }
}

app.get('/quota', (req, res) => res.json(quotaBody(req)));

/* ── Health check ── */
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Ring of 12',
    endpoints: ['/ask', '/single', '/log', '/quota', '/complete'],
    freeLimit: FREE_LIMIT,
    llmConfigured: !!LLM_API_KEY
  });
});

/* ── Full Ring run ── */
app.post('/ask', gate('ask'), async (req, res) => {
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

    countUse(req, 'ask');
    parsed.quota = quotaBody(req);
    parsed.provider = lastProvider;
    return res.json(parsed);
  } catch (err) {
    console.error('Server error:', err.status || '', err.detail || err.message || err);
    return res.status(err.status ? 502 : 500).json({ error: 'LLM request failed.' });
  }
});

/* ── Single-perspective answer (singularity comparison) ── */
app.post('/single', gate('single'), async (req, res) => {
  const { question } = req.body || {};
  if (!validQuestion(question)) {
    return res.status(400).json({ error: 'Missing or empty "question" field (max 2000 chars).' });
  }

  if (!LLM_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured -- LLM_API_KEY is not set.' });
  }

  try {
    const answer = await callLLM(SINGLE_SYSTEM_PROMPT, question.trim(), { temperature: 0.7, maxTokens: 400 });
    countUse(req, 'single');
    return res.json({ answer: answer.trim() });
  } catch (err) {
    console.error('Single-answer error:', err.status || '', err.detail || err.message || err);
    return res.status(err.status ? 502 : 500).json({ error: 'LLM request failed.' });
  }
});


/* ── Free completion for the source-check (counts as one free question) ──
 * Same per-IP allowance as /ask. Input is size-capped so it cannot be used as a general-purpose proxy. */
app.post('/complete', gate('ask'), async (req, res) => {
  const { messages, maxTokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4) {
    return res.status(400).json({ error: 'messages must be an array of 1 to 4 items.' });
  }
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== 'string' || !['system', 'user'].includes(m.role)) {
      return res.status(400).json({ error: 'each message needs role system|user and string content.' });
    }
    total += m.content.length;
  }
  if (total > 9000) return res.status(400).json({ error: 'input too long (9000 chars max).' });
  if (!LLM_API_KEY) return res.status(500).json({ error: 'Server misconfigured -- LLM_API_KEY is not set.' });
  try {
    const text = await callLLM(messages[0].role === 'system' ? messages[0].content : 'Answer carefully.',
      messages.filter((m, i) => !(i === 0 && m.role === 'system')).map((m) => m.content).join('\n\n'),
      { temperature: 0, maxTokens: Math.min(parseInt(maxTokens || 900, 10) || 900, 1200) });
    countUse(req, 'ask');
    return res.json({ text, quota: quotaBody(req), provider: lastProvider });
  } catch (err) {
    console.error('Complete error:', err.status || '', err.detail || err.message || err);
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
module.exports = app;
