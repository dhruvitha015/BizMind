# RevenueBrain
1. `cp .env.example .env` and fill in GROQ_API_KEY and HINDSIGHT_API_KEY (Hindsight Cloud, or point HINDSIGHT_URL at a self-hosted instance).
2. `npm install && npm start`, then open http://localhost:3000
3. Dashboard -> "Load demo data" (stores Acme, NovaTech, BrightLabs history in Hindsight), then try the Before / After tab.
The header dots show live Hindsight and Groq connectivity (`GET /api/health`).
Memory (interactions, beliefs) lives in Hindsight. `data.json` only indexes customers, timeline and belief snapshots for fast rendering.
