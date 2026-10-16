# ring-of-12-api

Node.js + Express backend for the Ring of 12 — the 12-archetype AI perspective tool with Agent Zero synthesis. It serves the twelve archetype perspectives combined through Agent Zero's truth verification.

This is a backend API, not a website — there is no GitHub Pages site.

## Live service

Deployed on Render via `render.yaml` (web service `ring-of-12-api`, Node runtime, `npm install` build, `node server.js` start, port 3000). Requires the `LLM_API_KEY` environment variable (the Emergent universal key; `EMERGENT_LLM_KEY` is kept only as a legacy name).

## What's here

- `server.js` — the Express server (entry point)
- `start.js` — alternate start script
- `astris-route.js` — the Astris route
- `package.json` — dependencies (`express`, `cors`), Node >= 18
- `render.yaml` — Render deployment configuration

Part of the [NextXus Federation](https://keywebco.github.io).
