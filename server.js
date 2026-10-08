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

/* ── Paid members (Gumroad subscriptions) ────────────────────────────────
 * A subscriber sends their Gumroad license key in the x-license-key header. The server asks Gumroad
 * whether the key is real, belongs to one of our three membership products, and is still in good
 * standing (not refunded, charged back, cancelled or failed). The tier sets a DAILY allowance.
 * Nothing about a member is stored except a per-day counter keyed by a hash of the license key.
 * Gumroad is the source of truth: if Gumroad says no, the answer is no. A positive answer is cached
 * for 10 minutes so each question does not cost a Gumroad call. */
const TIERS = {
  ophtywm: { name: 'Federation Entry: The Inner Ring (Starter)', daily: 2 },
  dqyabh:  { name: "The Scholar's Ledger: Advanced Ring Access", daily: 5 },
  xctpus:  { name: "The Architect's Covenant: 200-Year Legacy Pass", daily: 15 }
};
const memberCache = new Map();      // key-hash -> { until, tier }
const memberUse = new Map();        // key-hash -> { day, n }
const sha = (t) => require('crypto').createHash('sha256').update(String(t)).digest('hex').slice(0, 24);

async function verifyMember(licenseKey) {
  const key = String(licenseKey || '').trim();
  if (key.length < 8 || key.length > 80 || !/^[A-Za-z0-9\-_]+$/.test(key)) return null;
  const h = sha(key);
  const hit = memberCache.get(h);
  if (hit && hit.until > Date.now()) return { h, tier: hit.tier };
  for (const code of Object.keys(TIERS)) {
    try {
      const r = await fetch((process.env.GUMROAD_VERIFY_URL || 'https://api.gumroad.com/v2/licenses/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_permalink: code, license_key: key, increment_uses_count: 'false' })
      });
      if (r.status !== 200) continue;
      const d = await r.json();
      if (!d || !d.success) continue;
      const pu = d.purchase || {};
      if (pu.refunded || pu.chargebacked || pu.disputed) return null;
      if (pu.subscription_cancelled_at || pu.subscription_failed_at || pu.subscription_ended_at) return null;
      memberCache.set(h, { until: Date.now() + 10 * 60 * 1000, tier: code });
      return { h, tier: code };
    } catch (e) { /* try next tier code */ }
  }
  return null;
}
function memberLeft(m) {
  const d = today();
  let u = memberUse.get(m.h);
  if (!u || u.day !== d) { u = { day: d, n: 0 }; memberUse.set(m.h, u); }
  return { used: u.n, daily: TIERS[m.tier].daily, remaining: Math.max(0, TIERS[m.tier].daily - u.n), rec: u };
}

function quotaBody(req) {
  const u = usageFor(clientIp(req));
  return { freeLimit: FREE_LIMIT,
    providers: buildProviders().map(p => p.name),
    lastProvider,
    providerFails, used: u.asks, remaining: Math.max(0, FREE_LIMIT - u.asks), owner: isOwner(req), subscribeUrl: SUBSCRIBE_URL || null };
}
function gate(kind) {
  return async (req, res, next) => {
    if (isOwner(req)) return next();
    const lk = req.get('x-license-key');
    if (lk) {
      const m = await verifyMember(lk);
      if (!m) return res.status(401).json({ error: 'bad_license', message: 'That license key is not an active membership. Check it, or use your own API key.' });
      const l = memberLeft(m);
      if (l.remaining <= 0) return res.status(429).json({ error: 'member_daily', message: 'You have used your ' + l.daily + ' daily questions for the ' + TIERS[m.tier].name + '. They renew tomorrow, or add your own API key to keep going.', daily: l.daily, used: l.used, remaining: 0 });
      req.member = m;
      return next();
    }
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
  if (req.member) { memberLeft(req.member).rec.n += 1; return; }
  const u = usageFor(clientIp(req));
  if (kind === 'ask') { u.asks += 1; globalToday().count += 1; } else { u.singles += 1; }
}

app.get('/quota', async (req, res) => {
  const body = quotaBody(req);
  const lk = req.get('x-license-key');
  if (lk) {
    const m = await verifyMember(lk);
    if (m) { const l = memberLeft(m); body.member = { tier: TIERS[m.tier].name, daily: l.daily, used: l.used, remaining: l.remaining }; }
    else body.member = { error: 'That license key is not an active membership.' };
  }
  res.json(body);
});

/* ── Health check ── */
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Ring of 12',
    endpoints: ['/ask', '/single', '/log', '/quota', '/complete', '/council', '/library/inquire'],
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


/* ── Council: one question, several seat voices, ONE model call, ONE free question ───────────────
 * The page sends the question and the seat list (id, name, role). The server asks the model once to answer
 * as each seat, returns JSON keyed by seat id, and counts it as a single free question (or a single member
 * question). Seats are voices of one model unless the visitor uses their own keys on the page. */
app.post('/council', gate('ask'), async (req, res) => {
  const { question, seats } = req.body || {};
  if (typeof question !== 'string' || !question.trim() || question.length > 1500) {
    return res.status(400).json({ error: 'question must be 1 to 1500 characters.' });
  }
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 8) {
    return res.status(400).json({ error: 'seats must be an array of 1 to 8.' });
  }
  const clean = [];
  for (const st of seats) {
    if (!st || typeof st.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(st.id)) return res.status(400).json({ error: 'bad seat id.' });
    clean.push({ id: st.id, name: String(st.name || st.id).slice(0, 40), role: String(st.role || '').slice(0, 300) });
  }
  if (!buildProviders().length) return res.status(500).json({ error: 'Server misconfigured: no model provider.' });
  const roster = clean.map((c) => '- id "' + c.id + '" = ' + c.name + ': ' + c.role).join('\n');
  const system = 'You run a deliberation council. Answer the question once for EACH seat below, in that seat\'s own voice and perspective, each in 60 words or fewer. ' +
    'Seats may disagree; keep real disagreement. Label claims honestly: say when something is uncertain. No flattery, no pressure language. ' +
    'Reply with JSON only, no other text, shaped exactly like {"answers":{"<seat id>":"<answer>"}}. Use each seat id EXACTLY as written inside the quotes (for example "roger-ai"), never add the name to the key. Every seat id must be present.\n\nSEATS:\n' + roster;
  try {
    const wanted = clean.map((c) => c.id);
    const norm = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const pick = (obj, id) => {
      if (!obj || typeof obj !== 'object') return '';
      if (typeof obj[id] === 'string') return obj[id];
      const want = norm(id);
      for (const k of Object.keys(obj)) { const nk = norm(k); if (nk === want || nk.startsWith(want)) return typeof obj[k] === 'string' ? obj[k] : ''; }
      return '';
    };
    const parseLoose = (raw) => {
      const a0 = raw.indexOf('{'); if (a0 < 0) return null;
      let t = raw.slice(a0, raw.lastIndexOf('}') + 1);
      try { return JSON.parse(t); } catch (e) { /* try to repair a cut-off reply below */ }
      let cut = raw.slice(a0).replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '').replace(/"[^"]*$/, '');
      if (!/}\s*}?\s*$/.test(cut)) cut = cut.replace(/,\s*$/, '') + '"}}';
      try { return JSON.parse(cut); } catch (e) { return null; }
    };
    let answers = null;
    for (let attempt = 0; attempt < 2 && !answers; attempt++) {
      const raw = await callLLM(system, 'QUESTION: ' + question.trim(), { temperature: attempt ? 0.3 : 0.7, maxTokens: 1600 });
      const parsed = parseLoose(raw);
      const body = parsed && (parsed.answers || parsed);
      const got = {};
      for (const id of wanted) got[id] = String(pick(body, id) || '').slice(0, 900);
      if (Object.values(got).some((v) => v.trim())) answers = got;
    }
    if (!answers) throw new Error('empty answers');
    countUse(req, 'ask');
    return res.json({ answers, quota: quotaBody(req), provider: lastProvider });
  } catch (err) {
    console.error('Council error:', err.status || '', err.detail || err.message || err);
    return res.status(502).json({ error: 'The Council could not convene. Try again.' });
  }
});


/* ── Living Library gate ─────────────────────────────────────────────────────
 * POST /library/inquire  body {code?}  header x-owner-token optional.
 * Counts full-text inquiries per visitor (server-side, per IP, per day). The first LIBRARY_FREE are free.
 * After that a library code is needed. The code is a Gumroad license key for the product named in
 * LIBRARY_PRODUCT_PERMALINK, verified with Gumroad on every new key (cached 10 minutes). Nothing secret is on the page.
 * If LIBRARY_PRODUCT_PERMALINK is not set, the paid path is closed and the reply says so plainly. */
const LIBRARY_FREE = parseInt(process.env.LIBRARY_FREE || '3', 10);
const LIBRARY_PRODUCT = process.env.LIBRARY_PRODUCT_PERMALINK || '';
const libUse = new Map();
const libCodeCache = new Map();
/* A Supporter Key is a Gumroad license key, one per sale. It works on up to LIBRARY_DEVICES devices (default 3).
 * Counting is stateless so a Render restart cannot reset it: Gumroad's own use counter holds the number of
 * activated devices, and each activated browser keeps a signed device token (HMAC, 400 days). A browser that
 * already holds a valid token for the key is not counted again. A 4th new device is refused. */
const LIBRARY_DEVICES = parseInt(process.env.LIBRARY_DEVICES || '3', 10);
const LIB_SECRET = process.env.LIBRARY_TOKEN_SECRET || process.env.FEDERATION_OWNER_TOKEN || process.env.OWNER_TOKEN || '';
const hmac = (s) => require('crypto').createHmac('sha256', LIB_SECRET).update(s).digest('hex').slice(0, 32);
function deviceToken(key) { const exp = Date.now() + 400 * 86400000; const body = sha(key) + '.' + exp; return body + '.' + hmac(body); }
function deviceOk(key, tok) {
  if (!LIB_SECRET || !tok) return false;
  const p = String(tok).split('.'); if (p.length !== 3 || p[0] !== sha(key) || !(parseInt(p[1], 10) > Date.now())) return false;
  const want = hmac(p[0] + '.' + p[1]); return want.length === p[2].length && require('crypto').timingSafeEqual(Buffer.from(want), Buffer.from(p[2]));
}
async function gumroadVerify(key, increment) {
  const r = await fetch((process.env.GUMROAD_VERIFY_URL || 'https://api.gumroad.com/v2/licenses/verify'), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ product_permalink: LIBRARY_PRODUCT, license_key: key, increment_uses_count: increment ? 'true' : 'false' })
  });
  if (r.status !== 200) return null;
  const d = await r.json();
  if (!d || !d.success) return null;
  const pu = d.purchase || {};
  if (pu.refunded || pu.chargebacked || pu.disputed) return null;
  return { uses: parseInt(d.uses, 10) || 0 };
}
/* returns {ok:true, device?} | {ok:false, reason:'bad'|'devices'} */
async function verifyLibraryCode(code, devTok) {
  const key = String(code || '').trim();
  if (!LIBRARY_PRODUCT || key.length < 8 || key.length > 80 || !/^[A-Za-z0-9\-_]+$/.test(key)) return { ok: false, reason: 'bad' };
  const h = sha(key);
  const hit = libCodeCache.get(h);
  if (hit && hit > Date.now() && deviceOk(key, devTok)) return { ok: true };
  try {
    const v = await gumroadVerify(key, false);
    if (!v) return { ok: false, reason: 'bad' };
    if (deviceOk(key, devTok)) { libCodeCache.set(h, Date.now() + 10 * 60 * 1000); return { ok: true, device: deviceToken(key) }; }
    if (!LIB_SECRET) return { ok: true };
    if (v.uses >= LIBRARY_DEVICES) return { ok: false, reason: 'devices' };
    const v2 = await gumroadVerify(key, true);
    if (!v2) return { ok: false, reason: 'bad' };
    libCodeCache.set(h, Date.now() + 10 * 60 * 1000);
    return { ok: true, device: deviceToken(key) };
  } catch (e) { return { ok: false, reason: 'bad' }; }
}
app.post('/library/inquire', async (req, res) => {
  if (isOwner(req)) return res.json({ unlimited: true, owner: true });
  const code = (req.body && req.body.code) || '';
  if (code) {
    if (!LIBRARY_PRODUCT) return res.status(401).json({ error: 'codes_not_on_sale', message: 'Supporter Keys are coming soon. The free YAML files are always available to download.' });
    const v = await verifyLibraryCode(code, req.get('x-library-device') || '');
    if (v.ok) return res.json({ unlimited: true, device: v.device || undefined });
    if (v.reason === 'devices') return res.status(403).json({ error: 'device_limit', message: 'This Supporter Key is already used on ' + LIBRARY_DEVICES + ' devices. Write to keywebco@gmail.com and we will help.' });
    return res.status(401).json({ error: 'bad_code', message: 'That Supporter Key was not accepted. Check it, or download the free YAML.' });
  }
  const ip = clientIp(req), d = today();
  let u = libUse.get(ip);
  if (!u || u.day !== d) { u = { day: d, n: 0 }; libUse.set(ip, u); }
  if (libUse.size > 20000) { for (const [k, v] of libUse) if (v.day !== d) libUse.delete(k); }
  if (u.n >= LIBRARY_FREE) {
    return res.status(402).json({ error: 'free_limit', message: 'Your ' + LIBRARY_FREE + ' free inquiries are used. Enter your Supporter Key, or download the free YAML.', limit: LIBRARY_FREE, remaining: 0, codesOnSale: !!LIBRARY_PRODUCT });
  }
  u.n += 1;
  return res.json({ limit: LIBRARY_FREE, used: u.n, remaining: LIBRARY_FREE - u.n });
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
