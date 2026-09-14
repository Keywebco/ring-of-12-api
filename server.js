const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LLM_BASE_URL = 'https://integrations.emergentagent.com/llm';
const LLM_API_KEY = process.env.EMERGENT_LLM_KEY || '';
const LLM_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are the Ring of 12 \u2014 twelve psychological archetypes that each analyze a question from a unique angle. When given a question, respond in valid JSON only, no markdown, no explanation outside the JSON.

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

Agent Zero synthesizes by finding where multiple seats agree and where they diverge \u2014 the truth lives where they agree.`;

/* Health check */
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Ring of 12' });
});

/* Main endpoint */
app.post('/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Missing or empty "question" field.' });
  }

  if (!LLM_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured \u2014 no LLM key.' });
  }

  try {
    const llmRes = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question.trim() }
        ],
        temperature: 0.8,
        max_tokens: 3000
      })
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      console.error('LLM API error:', llmRes.status, errText);
      return res.status(502).json({ error: 'LLM API returned an error.', detail: llmRes.status });
    }

    const llmData = await llmRes.json();
    const raw = (llmData.choices && llmData.choices[0] && llmData.choices[0].message && llmData.choices[0].message.content) || '';

    /* Strip markdown fences if the model wraps them */
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw:', cleaned);
      return res.status(502).json({ error: 'LLM returned invalid JSON.', raw: cleaned });
    }

    /* Validate structure */
    if (!parsed.seats || !Array.isArray(parsed.seats) || parsed.seats.length < 12 || !parsed.synthesis) {
      return res.status(502).json({ error: 'LLM returned incomplete structure.', raw: parsed });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`Ring of 12 API listening on port ${PORT}`);
});
