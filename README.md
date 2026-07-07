# Meadow Vet Care — live MCP chatbot

A customer chatbot for a fictional Irish vet clinic that answers questions from the clinic's
**live** Google Sheet of 90+ services. It demonstrates the MCP idea: giving an LLM a live tool.

## How it works

```
Browser (index.html)  ──POST messages──▶  Cloudflare Worker
                                             │
                                             ├─ Claude (claude-sonnet-5) = the brain
                                             │     runs a tool-use loop
                                             │
                                             └─ search_services tool ──fetch CSV──▶ Google Sheet (live)
```

- **Front end** — `index.html`, a single self-contained page (animated WebGL meadow, glass chat,
  service cards). Hosted on GitHub Pages.
- **Brain + tool** — `worker/worker.js`, a Cloudflare Worker. Holds the Anthropic API key as a
  secret. On every message Claude decides to call `search_services`; the Worker fetches and
  filters the Google Sheet CSV **at that moment** and hands rows back to Claude to answer in
  natural language. Edit the sheet → answers change on the next message, no redeploy.
- **Real MCP server** — the same tool is exposed as a stateless MCP (Model Context Protocol)
  JSON-RPC server at `/mcp`, so any MCP client (Claude Desktop, the API's `mcp` connector, the
  MCP inspector) can connect and query the live services too.

## Data source

Public Google Sheet, exported live as CSV:
`https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/export?format=csv&gid=1277715587`

Columns: `service_id, category, species, price_eur, duration_min, requires_appointment,
availability, slots_this_week, special_offer, service_name, description`.

## Deploy

Worker (from `worker/`):

```bash
npx wrangler deploy
echo -n "sk-ant-..." | npx wrangler secret put ANTHROPIC_API_KEY
```

Front end: push to a GitHub Pages repo (this repo). The Worker's CORS allow-list must include the
Pages origin.

## Try it

- `GET  /`      → health: live service count
- `POST /`      → `{ "messages": [{ "role":"user", "content":"Do you have telehealth?" }] }`
- `POST /mcp`   → JSON-RPC: `initialize`, `tools/list`, `tools/call`

Not a substitute for veterinary advice.
