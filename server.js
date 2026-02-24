require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json({ limit: '20kb' }));

const lim = rateLimit({ windowMs: 60000, max: 40, message: { error: 'Too many requests' } });

function client(key) {
  if (!key) throw new Error('NO_KEY');
  return new Groq({ apiKey: key });
}

async function chat(key, messages, maxTokens = 2000, json = false) {
  const c = client(key);
  const opts = {
    model: 'llama-3.3-70b-versatile',
    max_tokens: maxTokens,
    messages,
  };
  if (json) opts.response_format = { type: 'json_object' };
  const res = await c.chat.completions.create(opts);
  return res.choices[0].message.content;
}

function parseJ(text) {
  const s = text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
  const a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return JSON.parse(s.slice(a, b+1));
}

function err(e) {
  if (e.message === 'NO_KEY') return { code: 401, msg: 'API key required' };
  if (e.status === 401) return { code: 401, msg: 'Invalid Groq API key' };
  if (e.status === 429) return { code: 429, msg: 'Rate limit hit. Try again in a moment.' };
  return { code: 500, msg: e.message };
}

app.get('/health', (_, res) => res.json({ ok: true, model: 'llama-3.3-70b-versatile' }));

// ── Validate key ──────────────────────────────────────────────
app.post('/api/validate-key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey?.startsWith('gsk_')) return res.status(400).json({ valid: false, error: 'Groq keys start with gsk_' });
  try {
    await chat(apiKey, [{ role:'user', content:'hi' }], 5);
    res.json({ valid: true });
  } catch(e) {
    res.status(400).json({ valid: false, error: err(e).msg });
  }
});

// ── Generate full roadmap ─────────────────────────────────────
app.post('/api/generate-roadmap', lim, async (req, res) => {
  const { apiKey, goalTitle, durationMonths, skillLevel, dailyHours, targetDepth } = req.body;
  try {
    const text = await chat(apiKey, [
      { role:'system', content:'Expert curriculum designer. Return ONLY valid JSON.' },
      { role:'user', content:`Create a detailed learning roadmap.
TOPIC: ${goalTitle}
DURATION: ${durationMonths} months | SKILL: ${skillLevel}/5 | HOURS/DAY: ${dailyHours} | DEPTH: ${targetDepth}

JSON format (return this exact structure):
{
  "goal_summary": "2-3 sentence description",
  "total_estimated_hours": 120,
  "key_outcomes": ["outcome1","outcome2","outcome3","outcome4"],
  "prerequisites": ["prereq1","prereq2"],
  "modules": [
    {
      "id": "m1",
      "title": "Module Title",
      "difficulty": 4,
      "estimated_hours": 20,
      "description": "What this covers",
      "weeks": [
        {
          "week_number": 1,
          "focus": "Week focus",
          "daily_tasks": [
            {
              "day": 1,
              "topic": "Specific topic",
              "estimated_minutes": 60,
              "learning_objective": "Learner will be able to...",
              "activity_type": "Reading"
            }
          ]
        }
      ]
    }
  ]
}` }
    ], 4000);
    res.json({ success: true, roadmap: parseJ(text) });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Chapter content (full lesson) ────────────────────────────
app.post('/api/chapter', lim, async (req, res) => {
  const { apiKey, topic, objective, goalTitle, moduleTitle, difficulty, skillLevel } = req.body;
  try {
    const content = await chat(apiKey, [
      { role:'system', content:'You are a world-class professor and textbook author. Write engaging, accurate, comprehensive lessons.' },
      { role:'user', content:`Write a complete lesson chapter on: "${topic}"
Course: ${goalTitle} | Module: ${moduleTitle} | Difficulty: ${difficulty}/10 | Student level: ${skillLevel}/5

Learning objective: ${objective}

Structure your lesson with these sections:
## 🎯 What You'll Learn
Brief overview of this topic and why it matters in the real world.

## 📖 Core Concepts
Explain the fundamental ideas clearly. Start simple, build complexity. Use analogies.

## 🔢 Formulas & Mathematics
All relevant formulas. Explain every variable. Show derivations where helpful.

## 💡 Worked Example
A realistic, detailed example. Show ALL steps. Use real numbers.

## 🌍 Real World Application
How is this used in practice? Industry examples, case studies.

## ⚠️ Common Mistakes & Misconceptions
What do learners typically get wrong? Exam traps.

## 🔗 Connections
How does this connect to other concepts in the course?

Write at least 600 words. Be thorough, accurate, and engaging. Use **bold** for key terms, \`backticks\` for formulas/code, and - for bullet points.` }
    ], 2000);
    res.json({ success: true, content });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Generate practice questions ───────────────────────────────
app.post('/api/quiz', lim, async (req, res) => {
  const { apiKey, topic, moduleTitle, goalTitle, difficulty, count = 5 } = req.body;
  try {
    const text = await chat(apiKey, [
      { role:'system', content:'Expert educator. Return ONLY a valid JSON array.' },
      { role:'user', content:`Generate ${count} practice questions on: "${topic}"
Course: ${goalTitle} | Module: ${moduleTitle} | Difficulty: ${difficulty}/10

Create questions at EXACTLY these levels (in order):
1. Basic recall
2. Understanding  
3. Application/Calculation
4. Analysis
5. Expert/Synthesis

Return JSON array:
[{"id":1,"level":"Basic","question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"correct":"A","explanation":"detailed why correct + why others wrong","formula":"relevant formula or null","hint":"small hint without giving answer"}]` }
    ], 2000);
    res.json({ success: true, questions: parseJ(text) });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Chapter AI tutor chat ─────────────────────────────────────
app.post('/api/tutor', lim, async (req, res) => {
  const { apiKey, message, topic, goalTitle, moduleTitle, chapterSummary, history, mode } = req.body;
  const modes = {
    explain: 'Explain concepts clearly with analogies and examples.',
    quiz:    'Ask the student questions to test their understanding. Give hints if they struggle.',
    debate:  'Challenge the student with devil\'s advocate questions to deepen understanding.',
    simple:  'Explain like I\'m 10 years old. Use very simple language and fun analogies.',
  };
  try {
    const msgs = [
      { role:'system', content:`You are an expert tutor for: "${topic}" in course "${goalTitle}" (module: ${moduleTitle}).
${modes[mode] || modes.explain}
${chapterSummary ? `Chapter context: ${chapterSummary.slice(0,400)}` : ''}
Keep responses focused, max 250 words. Use **bold**, \`formulas\`, and bullet points.` },
      ...(history||[]).slice(-6),
      { role:'user', content: message }
    ];
    const reply = await chat(apiKey, msgs, 500);
    res.json({ success: true, reply });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── AI Forecast ───────────────────────────────────────────────
app.post('/api/forecast', lim, async (req, res) => {
  const { apiKey, goalTitle, completedTasks, totalTasks, daysElapsed, totalDays, streak, consistency } = req.body;
  const tasksPerDay = completedTasks / Math.max(daysElapsed, 1);
  const remaining = totalTasks - completedTasks;
  const daysLeft = totalDays - daysElapsed;
  const required = remaining / Math.max(daysLeft, 1);
  const pace = tasksPerDay / Math.max(required, 0.01);
  const riskLevel = pace >= 0.9 && consistency >= 70 ? 'On Track' : pace >= 0.6 ? 'At Risk' : 'Delayed';
  const conf = riskLevel === 'On Track' ? 80 + Math.min(15, consistency/10) : riskLevel === 'At Risk' ? 55 : 30;
  const projDate = new Date(); projDate.setDate(projDate.getDate() + Math.ceil(remaining / Math.max(tasksPerDay, 0.1)));
  try {
    const text = await chat(apiKey, [
      { role:'system', content:'Learning analytics expert. Return JSON only.' },
      { role:'user', content:`Analyze: ${goalTitle}
${completedTasks}/${totalTasks} tasks | ${daysElapsed}/${totalDays} days | streak: ${streak} | consistency: ${consistency}% | risk: ${riskLevel}
Return: {"recommendation":"2-3 specific actions","pattern":"1 sentence","hours_needed":${(required*1.5).toFixed(1)},"today":"single priority action","motivation":"1 encouraging sentence"}` }
    ], 300);
    const ai = parseJ(text);
    res.json({ success: true, forecast: { riskLevel, confidence: Math.round(conf), projDate: projDate.toISOString().split('T')[0], ...ai } });
  } catch(e) {
    res.json({ success: true, forecast: { riskLevel, confidence: Math.round(conf), projDate: projDate.toISOString().split('T')[0],
      recommendation: 'Stay consistent with daily practice.', pattern: `${tasksPerDay.toFixed(1)} tasks/day pace.`,
      hours_needed: (required*1.5).toFixed(1), today: 'Complete scheduled tasks first.', motivation: 'Every expert was once a beginner.' }});
  }
});

// ── Explain anything (Feynman mode) ──────────────────────────
app.post('/api/explain', lim, async (req, res) => {
  const { apiKey, concept, style, context } = req.body;
  const styles = {
    feynman:   'Explain like Richard Feynman — build intuition first, then formalize. Use physical intuition.',
    eli5:      'Explain like I am 5 years old. Use toys, everyday objects, and super simple analogies.',
    visual:    'Describe the concept visually. Use ASCII diagrams, comparisons, and spatial thinking.',
    story:     'Tell it as a story. Create characters and a narrative arc that teaches the concept.',
    technical: 'Give a precise, rigorous technical explanation with full mathematical detail.',
    compare:   'Explain by comparison and contrast with 3 related concepts the learner already knows.',
  };
  try {
    const reply = await chat(apiKey, [
      { role:'system', content:`You are a master educator. ${styles[style] || styles.feynman}` },
      { role:'user', content:`Explain: "${concept}"${context ? `\nContext/prior knowledge: ${context}` : ''}\n\nBe engaging, memorable, and accurate. Min 300 words.` }
    ], 800);
    res.json({ success: true, reply });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Generate flashcards ───────────────────────────────────────
app.post('/api/flashcards', lim, async (req, res) => {
  const { apiKey, topic, moduleTitle, goalTitle, count = 10 } = req.body;
  try {
    const text = await chat(apiKey, [
      { role:'system', content:'Flashcard creator. Return ONLY valid JSON array.' },
      { role:'user', content:`Create ${count} flashcards for: "${topic}" in "${goalTitle}"
Cover: key terms, formulas, concepts, applications.
JSON: [{"front":"Question or term","back":"Answer or definition","type":"definition|formula|concept|application","difficulty":1}]
Vary difficulty 1-5. Make fronts specific, backs comprehensive but concise.` }
    ], 1500);
    res.json({ success: true, cards: parseJ(text) });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Weakness analysis ─────────────────────────────────────────
app.post('/api/weakness', lim, async (req, res) => {
  const { apiKey, goalTitle, modules } = req.body;
  try {
    const data = modules.map(m => ({ title:m.title, completion:Math.round((m.completedHours/Math.max(m.estimatedHours,1))*100)+'%', rating:m.selfRating||'unrated', status:m.status, difficulty:m.difficulty }));
    const text = await chat(apiKey, [
      { role:'system', content:'Learning analytics expert. Return JSON only.' },
      { role:'user', content:`Analyze: ${goalTitle}\n${JSON.stringify(data)}\nReturn: {"weakest":"title","why":"reason","strongest":"title","assessment":"2 sentences","actions":[{"module":"title","issue":"issue","action":"this week action","priority":"High"}],"topics":["extra topic1","extra topic2"],"strategy":"recommendation"}` }
    ], 600);
    res.json({ success: true, analysis: parseJ(text) });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

// ── Global AI chat ────────────────────────────────────────────
app.post('/api/chat', lim, async (req, res) => {
  const { apiKey, message, goalContext, history } = req.body;
  try {
    const msgs = [
      { role:'system', content:`You are an expert tutor and learning coach. Help with any subject — from quantum physics to cooking.${goalContext ? ` User is studying: ${goalContext}.` : ''}
Use ## headers, **bold** terms, \`formulas\`, and - bullets. Max 350 words. Be direct and practical.` },
      ...(history||[]).slice(-8),
      { role:'user', content: message }
    ];
    const reply = await chat(apiKey, msgs, 700);
    res.json({ success: true, reply });
  } catch(e) { const r = err(e); res.status(r.code).json({ error: r.msg }); }
});

app.listen(PORT, () => {
  console.log(`\n🚀 LearnOS Backend — port ${PORT}`);
  console.log(`🆓 Groq / llama-3.3-70b-versatile\n`);
});
