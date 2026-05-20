# BCS Memory Box — Free Trial Backend

A small Express server that powers the "Try It Free — Record a 90-Second Sample" button on www.bcsmemorybox.com. Deployed on Render.

## Architecture

Visitor records 90s audio in browser → POST /trial (audio + email) → AssemblyAI transcribes → Claude API cleans up → Resend emails the polished sample back → Visitor's inbox.

## Deployment

This service is deployed via Render's GitHub integration. The `render.yaml` blueprint in this directory configures everything.

When connecting the repo to Render for the first time:
1. Sign in to Render with GitHub.
2. Create a new Blueprint, point at this repo.
3. Render reads `render.yaml` and provisions the service.
4. Set the three environment variables in the Render dashboard (their values are in `~/Desktop/Memory Box/.bcs_deploy_config.json`):
   - `ASSEMBLYAI_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `RESEND_API_KEY`
5. Render builds and deploys automatically on every push to the `main` branch.

## Endpoints

- `GET /health` — health check (used by Render)
- `POST /trial` — main endpoint
  - Body: `multipart/form-data` with `audio` (file), `email` (string), optional `name` (string)
  - Response: JSON with `success: true` or `error`
