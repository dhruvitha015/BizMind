import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const { GROQ_API_KEY, HINDSIGHT_API_KEY, GROQ_MODEL = 'openai/gpt-oss-120b', HINDSIGHT_URL = 'https://api.hindsight.vectorize.io', HINDSIGHT_BANK = 'revenuebrain', PORT = 3000 } = process.env;
const app = express(); app.use(express.json());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---- App data (lightweight index only: customers, timeline, belief snapshots). Memory itself lives in Hindsight.
const DB = 'data.json';
let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { customers: [], interactions: [], beliefs: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 1));
const uid = () => Math.random().toString(36).slice(2, 9);

// ---- Hindsight
const hs = async (path, method, body) => {
  const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${HINDSIGHT_BANK}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HINDSIGHT_API_KEY}` }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hindsight ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const retain = (content, context, tags) => hs('/memories', 'POST', { items: [{ content, context, tags, timestamp: new Date().toISOString() }] });
const recall = async (query, tags) => {
  const r = await hs('/memories/recall', 'POST', { query, budget: 'mid', ...(tags && { tags, tags_match: 'any' }) });
  return (r.results || []).map(m => ({ id: m.id, text: m.text, type: m.type, date: m.occurred_start || m.mentioned_at }));
};

// ---- Groq
const llm = async (messages, json = false) => {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` }, body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.2, ...(json && { response_format: { type: 'json_object' } }) }) });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices[0].message.content;
};
const parse = s => JSON.parse(s.replace(/```json|```/g, '').trim());

// ---- Core: log interaction -> extract -> retain -> relearn beliefs
async function logInteraction(cid, { type, text, outcome }) {
  const c = db.customers.find(x => x.id === cid); if (!c) throw new Error('Unknown customer');
  const ex = parse(await llm([{ role: 'system', content: 'Extract sales facts. Return JSON: {"summary":str,"objections":[str],"buying_signals":[str],"pain_points":[str],"decision_makers":[str],"preferences":[str]}. Only use what the text says.' }, { role: 'user', content: text }], true));
  const it = { id: uid(), cid, type, text, outcome: outcome || 'none', date: new Date().toISOString(), extracted: ex };
  const memo = `[${c.name}] ${type} on ${it.date.slice(0, 10)}: ${text}\nObjections: ${ex.objections.join('; ') || 'none'}. Buying signals: ${ex.buying_signals.join('; ') || 'none'}. Pain points: ${ex.pain_points.join('; ') || 'none'}. Decision makers: ${ex.decision_makers.join('; ') || 'n/a'}. Outcome: ${it.outcome}.`;
  await retain(memo, `sales interaction with ${c.name}`, [`customer:${cid}`, 'interaction']);
  db.interactions.push(it); if (outcome === 'won' || outcome === 'lost') c.deal = outcome; save();
  const beliefs = await relearn(c); return { interaction: it, beliefs };
}

async function relearn(c) {
  const mems = await recall(`Everything about ${c.name}: objections, what worked, what failed, outcomes`, [`customer:${c.id}`]);
  const prev = db.beliefs[c.id] || [];
  const out = parse(await llm([{ role: 'system', content: `You update sales beliefs from evidence. Return JSON {"beliefs":[{"key":str,"text":str,"confidence":0-100,"evidence":[str],"next_action":str}]}. Reuse "key" of previous beliefs when they still apply. Raise confidence when new evidence agrees, lower it when it contradicts. Max 4 beliefs. Base everything on memories only; evidence strings must be short paraphrases of memories.` }, { role: 'user', content: `Customer: ${c.name}\nPrevious beliefs: ${JSON.stringify(prev.map(b => ({ key: b.key, text: b.text, confidence: b.confidence })))}\nMemories:\n${mems.map(m => '- ' + m.text).join('\n')}` }], true));
  const now = new Date().toISOString();
  db.beliefs[c.id] = out.beliefs.map(b => { const p = prev.find(x => x.key === b.key); return { ...b, history: [...(p?.history || []), { t: now, c: b.confidence }] }; });
  save();
  await retain(`LEARNED BELIEFS for ${c.name}: ` + db.beliefs[c.id].map(b => `${b.text} (confidence ${b.confidence}%)`).join(' | '), `derived insight about ${c.name}`, [`customer:${c.id}`, 'belief']).catch(() => {});
  return db.beliefs[c.id];
}

// ---- Routes
const wrap = f => async (q, s) => { try { s.json(await f(q)); } catch (e) { console.error(e); s.status(500).json({ error: e.message }); } };
app.get('/api/health', wrap(async () => {
  const h = await hs('/memories/recall', 'POST', { query: 'ping', budget: 'low' }).then(() => 'ok', e => e.message);
  const g = await llm([{ role: 'user', content: 'ok' }]).then(() => 'ok', e => e.message);
  return { hindsight: h, groq: g, model: GROQ_MODEL };
}));
app.get('/api/customers', wrap(async () => db.customers.map(c => ({ ...c, interactions: db.interactions.filter(i => i.cid === c.id).length, topBelief: db.beliefs[c.id]?.[0] }))));
app.post('/api/customers', wrap(async q => { const c = { id: uid(), name: q.body.name, industry: q.body.industry || '', deal: 'pending', value: q.body.value || 0 }; db.customers.push(c); save(); return c; }));
app.get('/api/customers/:id', wrap(async q => { const c = db.customers.find(x => x.id === q.params.id); if (!c) throw new Error('Unknown customer'); return { customer: c, interactions: db.interactions.filter(i => i.cid === c.id).sort((a, b) => b.date.localeCompare(a.date)), beliefs: db.beliefs[c.id] || [] }; }));
app.post('/api/customers/:id/interactions', wrap(q => logInteraction(q.params.id, q.body)));
app.get('/api/memory/search', wrap(async q => recall(String(q.query.q || ''), q.query.cid ? [`customer:${q.query.cid}`] : undefined)));
app.get('/api/dashboard', wrap(async () => ({
  customers: db.customers.length,
  activeItems: db.customers.filter(c => c.deal === 'pending').length,
  recentBeliefs: db.customers.flatMap(c => (db.beliefs[c.id] || []).map(b => ({ text: b.text, confidence: b.confidence, name: c.name, evidenceCount: b.evidence?.length || 0 })))
    .sort((a, b) => b.confidence - a.confidence).slice(0, 3)
})));

const RULES = 'Answer in JSON: {"remembered":[str],"inferred":[str],"unknown":[str],"answer":str,"confidence":0-100}. "remembered" = facts stated in the memories. "inferred" = your reasoning from them. "unknown" = things asked about but absent from memory; NEVER invent customer facts.';
app.post('/api/ask', wrap(async q => {
  const { customerId, question } = q.body; const c = db.customers.find(x => x.id === customerId);
  const mems = await recall(question + (c ? ` ${c.name}` : ''), c ? [`customer:${c.id}`] : undefined);
  const r = parse(await llm([{ role: 'system', content: `You are RevenueBrain, a sales memory agent. ${RULES}` }, { role: 'user', content: `${c ? 'Customer: ' + c.name + '\n' : 'General/team question.\n'}Memories retrieved from Hindsight:\n${mems.map(m => '- ' + m.text).join('\n') || '(none)'}\n\nQuestion: ${question}` }], true));
  return { ...r, memories: mems };
}));
app.post('/api/demo/compare', wrap(async q => {
  const c = db.customers.find(x => x.id === q.body.customerId); const question = q.body.question || 'What should I do next with this customer?';
  const before = await llm([{ role: 'system', content: 'You are a generic sales assistant with no memory of this customer. Give brief generic advice.' }, { role: 'user', content: `${question} (customer: ${c.name})` }]);
  const after = await (async () => { const mems = await recall(question + ' ' + c.name, [`customer:${c.id}`]); return { ...parse(await llm([{ role: 'system', content: `You are RevenueBrain. ${RULES}` }, { role: 'user', content: `Customer: ${c.name}\nMemories:\n${mems.map(m => '- ' + m.text).join('\n')}\n\nQuestion: ${question}` }], true)), memories: mems }; })();
  return { before, after, beliefs: db.beliefs[c.id] || [] };
}));

const SEED = {
  Acme: { industry: 'Logistics SaaS', value: 48000, log: [
    ['call', 'Discovery call. Dana (VP Ops) said pricing is too high vs competitor. Needs to replace spreadsheets before Q3.'],
    ['email', 'Dana asked again for a discount. We offered 15% off; she went quiet for two weeks.', 'lost'],
    ['meeting', 'Demo to ops team. CTO Raj worried the 6-month implementation would disrupt peak season. Price barely came up.'],
    ['call', 'Proposed phased implementation: one warehouse first, 4 weeks. Dana and Raj both positive, asked for a pilot SOW.']] },
  NovaTech: { industry: 'Fintech', value: 30000, log: [
    ['call', 'CFO Mia cares about security compliance (SOC2). Asked for audit report.'],
    ['email', 'Sent SOC2 report. Mia replied within an hour and requested a proposal.']] },
  BrightLabs: { industry: 'EdTech', value: 18000, log: [
    ['demo', 'Founder Sam loved the demo but said budget is frozen until next quarter.', 'lost'],
    ['email', 'Follow-up: Sam said he will revisit once funding closes; asked to stay in touch.']] } };
app.post('/api/demo/seed', wrap(async () => {
  for (const [name, d] of Object.entries(SEED)) { if (db.customers.some(c => c.name === name)) continue; const c = { id: uid(), name, industry: d.industry, deal: 'pending', value: d.value }; db.customers.push(c); save(); for (const [type, text, outcome] of d.log) await logInteraction(c.id, { type, text, outcome }); if (name === 'Acme') c.deal = 'pending'; }
  save(); return { ok: true };
}));
app.post('/api/demo/new-evidence', wrap(async q => logInteraction(q.body.customerId, { type: 'call', text: 'Pilot at first warehouse kicked off. Raj said the phased plan removed his main worry; Dana signed the full contract without asking for a discount.', outcome: 'won' })));

app.listen(PORT, '0.0.0.0', () => console.log(`BizMind listening on 0.0.0.0:${PORT}`));
