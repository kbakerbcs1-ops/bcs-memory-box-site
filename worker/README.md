# BCS Memory Box — Free Trial Worker

A Cloudflare Worker that powers the "Try It Free — Record a 90-Second Sample" button on www.bcsmemorybox.com.

## Architecture

Visitor records 90s audio in browser → POST /trial (audio + email) → AssemblyAI transcribes → Claude API cleans up → Resend emails the polished sample back → Visitor's inbox.

## Deploying

```bash
cd worker
npx wrangler login                              # one-time, opens browser to authorize
npx wrangler deploy                             # ships the worker to Cloudflare
npx wrangler secret put ASSEMBLYAI_API_KEY      # paste key from .bcs_deploy_config.json
npx wrangler secret put ANTHROPIC_API_KEY       # paste key from .bcs_deploy_config.json
npx wrangler secret put RESEND_API_KEY          # paste key from .bcs_deploy_config.json
```

## Testing

```bash
npx wrangler dev                                # runs locally on http://localhost:8787
# In another terminal:
curl -X POST http://localhost:8787 \
  -F "audio=@sample.m4a" \
  -F "email=test@example.com" \
  -F "name=Ken"
```

## Production logs

```bash
npx wrangler tail
```
