# Siting Deploy Studio

Siting is an advanced deployment workspace inspired by Railway.com and Koyeb workflows.

It supports:

- Uploading full website files from the browser.
- Creating local deployment workspaces at `/deployments/{id}/`.
- Auto-generating deployment support files (`railway.json`, `Dockerfile`, `package.json`, `server.js`) when missing.
- Browsing external websites through the built-in proxy (`/proxy?url=...`) for quick compatibility checks.

## Run locally

```bash
npm start
```

Open `http://localhost:8000`.

## Deploy Studio API

- `GET /api/health` -> service health
- `GET /api/deployments` -> list deployments
- `POST /api/deployments` -> create deployment from uploaded files
- `GET /api/deployments/:id` -> deployment details
- `GET /deployments/:id/*` -> serve deployment files

## Data storage

- Generated deployments are stored in `.deployments/` (inside this folder).
- This directory is runtime data and should typically not be committed.

## Deploy this app on Railway.com

1. Push this `Siting` folder to GitHub.
2. In Railway.com, choose **Deploy from GitHub**.
3. Set **Root Directory** to `Siting` (if needed).
4. Railway.com uses `npm start` from `railway.json`.
5. Deploy.

## Deploy this app on Koyeb

1. Push this `Siting` folder to GitHub.
2. Create a **Web Service** in Koyeb from the repo.
3. Set root directory to `Siting`.
4. Set builder to **Dockerfile** (this folder includes one).
5. Deploy.

## Notes

- `server.js` listens on `process.env.PORT` for platform compatibility.
- Some external websites can still block iframe/proxy access due anti-bot or account security flows.
