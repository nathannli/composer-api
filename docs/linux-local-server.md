# Local Linux OpenAI-compatible server

Run API for Cursor as a headless OpenAI-compatible endpoint on Linux (Bun API + Cursor SDK bridge). Aimed at agents like **Hermes** that accept a custom `base_url`.

## Architecture

```text
Hermes / client
   │  Bearer: LOCAL_API_KEY (or Cursor key in direct mode)
   ▼
Bun API  :8787
   GET  /health  /v1  /
   GET  /v1/models  /v1/models/{id}
   POST /v1/chat/completions
   POST /v1/responses  (+ get/delete/input_items)
   │
   ▼
SDK bridge  :8792/sdk  (internal)
   │
   ▼
@cursor/sdk + your Cursor account
```

Default bind is **loopback** (`HOST=127.0.0.1`). Only expose beyond localhost behind a reverse proxy you trust.

## Quick start (bare metal)

Requirements: Node ≥ 18 (for the SDK), [Bun](https://bun.sh) ≥ 1.3, a Cursor user API key.

```bash
cp .env.example .env
# edit .env — at minimum:
#   CURSOR_API_KEY=...          # Cursor dashboard key
#   LOCAL_API_KEY=...           # random secret Hermes will send
#   CURSOR_SDK_WORKING_DIRECTORY=/home/you/projects/my-app
#   CURSOR_SDK_BRIDGE_TOKEN=... # random shared secret bridge↔api

npm install   # or: bun install

# terminal 1 — bridge
export $(grep -v '^#' .env | xargs)   # or use your shell’s dotenv
bun run server:bridge

# terminal 2 — OpenAI facade
bun run server
```

Smoke:

```bash
curl -s http://127.0.0.1:8787/health | jq .
curl -s http://127.0.0.1:8787/v1/models | jq '.data[].id'
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $LOCAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

## Docker Compose

```bash
export CURSOR_API_KEY=...
export LOCAL_API_KEY=$(openssl rand -hex 24)
export CURSOR_SDK_BRIDGE_TOKEN=$(openssl rand -hex 24)
export CURSOR_SDK_WORKSPACE_HOST=$HOME/projects/my-app
export CURSOR_SDK_WORKING_DIRECTORY=/workspace

bun run server:up          # docker compose up --build -d
bun run server:logs
bun run server:down
```

- API published on host `${PORT:-8787}`
- Bridge is **not** published (compose network only)
- Host folder mounts at `/workspace` inside the bridge

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker api service) |
| `PORT` | `8787` | API port |
| `CURSOR_SDK_BRIDGE_URL` | `http://127.0.0.1:8792/sdk` | Bridge endpoint |
| `CURSOR_SDK_BRIDGE_TOKEN` | empty | Shared secret API → bridge |
| `CURSOR_SDK_WORKING_DIRECTORY` | `process.cwd()` | Default agent cwd / tool root |
| `CURSOR_API_KEY` | empty | Cursor secret kept on the server |
| `LOCAL_API_KEY` | empty | Optional gateway key for clients |

### Auth modes

1. **Gateway (recommended for Hermes)**  
   Set both `CURSOR_API_KEY` and `LOCAL_API_KEY`.  
   Clients send `Authorization: Bearer <LOCAL_API_KEY>`.  
   The server forwards `CURSOR_API_KEY` to Cursor.

2. **Direct**  
   Leave `LOCAL_API_KEY` empty.  
   Clients send the Cursor API key as Bearer (same as the macOS app / worker direct mode).

## Hermes custom endpoint

Hermes uses OpenAI-compatible **chat completions**. Point it at this server:

```bash
# secrets
hermes config set --env CURSOR_LOCAL_API_KEY "$LOCAL_API_KEY"

# model pointing at the local server (custom OpenAI-compatible)
hermes config set model.provider custom
hermes config set model.base_url http://127.0.0.1:8787/v1
hermes config set model.default composer-2.5
# api key: prefer env reference if your Hermes build supports key_env;
# otherwise set the gateway key the server expects:
hermes config set model.api_key "$LOCAL_API_KEY"
```

Optional alias:

```yaml
# conceptual shape — use hermes config set, don’t hand-edit if avoidable
model_aliases:
  cursor-composer:
    model: composer-2.5
    provider: custom
    base_url: http://127.0.0.1:8787/v1
```

Then `/model cursor-composer` or set it as the session default.

Useful model ids from `GET /v1/models`:

- `composer-2.5`
- `composer-2.5-fast`
- `grok-4.5`
- `grok-4.5-fast`
- plus other Cursor-routed ids advertised by the list

### What Hermes needs (minimum)

| Endpoint | Required for Hermes chat |
|---|---|
| `GET /v1/models` | Yes (catalog / validation) |
| `POST /v1/chat/completions` (stream) | **Yes** |
| `POST /v1/responses` | No (other clients) |

Streaming chat is implemented. Keep the server and bridge running for the whole Hermes session.

## systemd (optional bare metal)

Example user units (adjust paths):

`~/.config/systemd/user/cursor-sdk-bridge.service`

```ini
[Unit]
Description=Cursor SDK bridge
After=network.target

[Service]
WorkingDirectory=%h/data/personal/composer-api
EnvironmentFile=%h/data/personal/composer-api/.env
ExecStart=/usr/bin/bun run scripts/cursor-sdk-local-agent-bridge.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/cursor-api.service`

```ini
[Unit]
Description=API for Cursor local OpenAI server
After=cursor-sdk-bridge.service
Requires=cursor-sdk-bridge.service

[Service]
WorkingDirectory=%h/data/personal/composer-api
EnvironmentFile=%h/data/personal/composer-api/.env
ExecStart=/usr/bin/bun run server/index.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now cursor-sdk-bridge cursor-api
```

## Security notes

- Prefer `HOST=127.0.0.1` and gateway auth (`LOCAL_API_KEY`).
- Do not publish the bridge port.
- Do not commit `.env` or Cursor keys.
- This is a **single-user local** facade, not a multi-tenant hosted API.

## npm / bun scripts

| Script | Action |
|---|---|
| `bun run server:bridge` | SDK bridge |
| `bun run server` | OpenAI API on `:8787` |
| `bun run server:up` | Compose up |
| `bun run server:down` | Compose down |
| `bun run server:logs` | Follow logs |
