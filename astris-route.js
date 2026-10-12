/* Astris speaks: add-on route for the Galactic Library. Loaded by start.js; server.js is NOT modified.
 * Key stays on the server. Plain search never calls this. Rate limit per visitor + daily ceiling for the whole library. */
module.exports = function (app) {
  const PER_MIN = parseInt(process.env.ASTRIS_PER_MIN || '6', 10);
  const DAILY_CAP = parseInt(process.env.ASTRIS_DAILY_CAP || '150', 10);
  const FREE_UNTIL = process.env.ASTRIS_FREE_UNTIL || '';
  const mins = new Map(); const day = { d: '', n: 0 };
  const today = () => new Date().toISOString().slice(0, 10);
  const ip = (req) => (req.get('cf-connecting-ip') || (req.get('x-forwarded-for') || '').split(',')[0] || req.ip || 'unknown').trim();
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, n);
  const SYSTEM = 'You are Astris, keeper of the Galactic Record, librarian of 4,300 short poems, one for each moment in the history of the world. Answer in 2 to 4 plain, warm sentences, in the language of the question. Use ONLY the library entries given. Name entries by number and title. Never add facts, dates or names not in the entries. If they do not answer the question, say so plainly and suggest a place, time or thing to try. The poems are creative work, not a history textbook.';
  async function llm(user) {
    const base = (process.env.LLM_BASE_URL || '').replace(/\/$/, ''), path = process.env.LLM_CHAT_PATH || '/v1/chat/completions';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(base + path, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LLM_API_KEY },
        body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0.4, max_tokens: 350, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }) });
      if (!r.ok) throw new Error('llm ' + r.status);
      const j = await r.json(); return String(j.choices[0].message.content || '').trim();
    } finally { clearTimeout(t); }
  }
  app.post('/library/astris', async (req, res) => {
    const now = Date.now(), who = ip(req), b = req.body || {};
    const q = clean(b.question, 300).trim(); const entries = Array.isArray(b.entries) ? b.entries.slice(0, 8) : [];
    if (!q) return res.status(400).json({ error: 'no_question', message: 'Ask me about a place, a time or a thing.' });
    if (!entries.length) return res.status(400).json({ error: 'no_entries', message: 'Plain search found nothing to read from.' });
    if (FREE_UNTIL && today() > FREE_UNTIL) return res.status(402).json({ error: 'free_over', message: 'Astris answering in sentences needs a donation. Plain search stays free forever.' });
    let m = mins.get(who); if (!m || now > m.reset) { m = { n: 0, reset: now + 60000 }; mins.set(who, m); } m.n++;
    if (mins.size > 20000) for (const [k, v] of mins) if (now > v.reset) mins.delete(k);
    if (m.n > PER_MIN) return res.status(429).json({ error: 'slow_down', message: 'One moment. Astris answers a few questions a minute so she can stay available to everyone.' });
    if (day.d !== today()) { day.d = today(); day.n = 0; }
    if (day.n >= DAILY_CAP) return res.status(503).json({ error: 'daily_ceiling', message: 'Astris has spoken a great deal today. Plain search still works; she will speak again tomorrow.' });
    const lines = entries.map((e) => 'Entry ' + clean(e && e.n, 6) + ' | ' + clean(e && e.t, 80) + ' | ' + clean(e && e.d, 24) + ' | ' + clean(e && e.r, 60) + ' | ' + clean(e && e.x, 400));
    try { const text = await llm('Visitor question: ' + q + '\n\nLibrary entries found:\n' + lines.join('\n')); day.n++; return res.json({ text: text.slice(0, 1400) }); }
    catch (e) { return res.status(502).json({ error: 'astris_resting', message: 'Astris is resting for a moment. The plain search results above are still good.' }); }
  });
  app.get('/library/astris/status', (_q, res) => res.json({ ready: !!process.env.LLM_API_KEY, perMinute: PER_MIN, dailyCeiling: DAILY_CAP, spokenToday: day.d === today() ? day.n : 0 }));
};
