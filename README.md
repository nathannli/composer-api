# API for Cursor (Linux)

Linux fork of [API for Cursor](https://github.com/standardagents/composer-api): a headless OpenAI-compatible `/v1` server backed by Cursor models via `@cursor/sdk`. Bun API + Node SDK bridge only.

## Architecture

```text
Client (Hermes, curl, OpenAI SDKs)
   │  Bearer: CURSOR_API_KEY (direct) or LOCAL_API_KEY (gateway)
   ▼
Bun API  :8788
   GET  /health  /v1/models
   POST /v1/chat/completions
   POST /v1/responses
   │
   ▼
Node SDK bridge  :8792/sdk
   │
   ▼
@cursor/sdk + your Cursor account
```

Default bind is loopback (`HOST=127.0.0.1`). API port defaults to **8788** so it does not collide with hermes-webui on `:8787`. The bridge must run under **Node** (Bun's HTTP/2 client hits `NGHTTP2_FRAME_SIZE_ERROR` with `@cursor/sdk`).

Full detail: [docs/linux-local-server.md](docs/linux-local-server.md).

## Supported endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /health`

## Models

Bundled catalog includes Composer, GPT/Codex, Gemini, Grok, Kimi, and aliases. Restrict what is advertised and accepted with `COMPOSER_API_MODELS`.

Primary ids:

- `composer-2.5`
- `composer-2.5-fast`
- `grok-4.5`
- `grok-4.5-fast`

## Quick start

Two ways to run this stack:

1. **Bare metal** — Node bridge + Bun API on the host (two terminals, or one systemd user unit)
2. **Docker Compose** — same two processes in containers (`bun run server:up`)

Requirements: Node ≥ 18 (bridge), [Bun](https://bun.sh) ≥ 1.3 (API; also used for Compose helper scripts), Cursor user API key (Dashboard → Integrations). For Compose you also need Docker with the Compose plugin.

Shared setup:

```bash
cp .env.example .env
# Required: CURSOR_API_KEY, CURSOR_SDK_BRIDGE_TOKEN
# Recommended for Hermes: COMPOSER_API_MODELS=composer-2.5,grok-4.5
# Optional gateway: LOCAL_API_KEY (clients send this as Bearer)

npm install   # or: bun install
```

Do not commit `.env` or Cursor keys.

### Option 1: Bare metal

Two terminals:

```bash
# terminal 1 — Node bridge
bun run server:bridge   # :8792

# terminal 2 — Bun API
bun run server          # :8788 → http://127.0.0.1:8788/v1
```

Or install the systemd user unit (starts both processes, stops both on exit):

```bash
# install: systemd-service-files/composer-api.service → ~/.config/systemd/user/
# and launcher ~/.local/bin/composer-api
systemctl --user daemon-reload
systemctl --user enable --now composer-api
```

See [systemd](#systemd) for restart/status/journal.

### Option 2: Docker Compose

```bash
export CURSOR_API_KEY=YOUR_API_KEY
export LOCAL_API_KEY=$(openssl rand -hex 24)
export CURSOR_SDK_BRIDGE_TOKEN=$(openssl rand -hex 24)
export CURSOR_SDK_WORKSPACE_HOST=$HOME/projects/my-app
export CURSOR_SDK_WORKING_DIRECTORY=/workspace
# optional: COMPOSER_API_MODELS=composer-2.5,grok-4.5

bun run server:up    # docker compose up --build -d
bun run server:logs  # follow api + bridge
# bun run server:down
```

API on host `${PORT:-8788}`; bridge stays on the compose network only (not published). Host project mounts at `/workspace` inside the bridge.

### Smoke

Same for either method:

```bash
curl -s http://127.0.0.1:8788/health | jq .
curl -s http://127.0.0.1:8788/v1/models | jq '.data[].id'

curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"ping"}]}'
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "http://127.0.0.1:8788/v1"
});

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Write a TypeScript debounce." }]
});
```

## Model allowlist

Unset `COMPOSER_API_MODELS` advertises the full bundled catalog. Set it in `.env` so `/v1/models` and chat/responses only expose the models you want (Hermes live discovery will otherwise replace a short configured list after the first message):

```bash
COMPOSER_API_MODELS=composer-2.5,grok-4.5
systemctl --user restart composer-api
```

Unlisted models return `404 model_not_found` before the bridge is called.

## Client Example: Hermes

```yaml
# ~/.hermes/config.yaml — prefer hermes config set when possible
custom_providers:
  - name: composer-api
    base_url: http://127.0.0.1:8788/v1
    key_env: CURSOR_API_KEY   # or LOCAL_API_KEY when gateway mode is on
    api_mode: chat_completions
    models:
      - id: composer-2.5
      - id: grok-4.5
```

Put the matching secret in `~/.hermes/.env`. Select with:

```text
/model @custom:composer-api:composer-2.5
```

Keep `COMPOSER_API_MODELS` in sync with the Hermes `models:` list.

## Auth modes

Server-wide for any OpenAI-compatible client (curl, SDKs, Hermes, etc.):

1. **Direct** — leave `LOCAL_API_KEY` empty; clients send the Cursor API key as Bearer.
2. **Gateway** — set both `CURSOR_API_KEY` and `LOCAL_API_KEY`; clients send `LOCAL_API_KEY`, the server forwards `CURSOR_API_KEY` to Cursor.

## systemd

Repo unit: `systemd-service-files/composer-api.service`  
Repo launcher: `systemd-service-files/composer-api` (starts Node bridge + Bun API; stops both on exit)

```bash
mkdir -p ~/.config/systemd/user ~/.local/bin
cp systemd-service-files/composer-api.service ~/.config/systemd/user/
install -m 0755 systemd-service-files/composer-api ~/.local/bin/composer-api
systemctl --user daemon-reload
systemctl --user enable --now composer-api
```

```bash
systemctl --user restart composer-api
systemctl --user status composer-api
journalctl --user -u composer-api -f
```

The template assumes a checkout at `%h/composer-api` and loads its `.env`; adjust the unit paths if the repo lives elsewhere.


## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8788` | API port |
| `CURSOR_SDK_BRIDGE_URL` | `http://127.0.0.1:8792/sdk` | Bridge endpoint |
| `CURSOR_SDK_BRIDGE_TOKEN` | empty | Shared secret API → bridge |
| `CURSOR_SDK_WORKING_DIRECTORY` | `process.cwd()` | Default agent cwd / tool root |
| `CURSOR_SDK_CONTEXT_WINDOWS_FILE` | `.cursor-sdk-context-windows.json` | Learned context windows from checkpoints |
| `COMPOSER_API_MODELS` | empty | Comma-separated allowlist |
| `CURSOR_API_KEY` | empty | Cursor secret on the server |
| `LOCAL_API_KEY` | empty | Optional gateway key for clients |

## Compatibility notes

Supports text and image input, streaming and non-streaming output, JSON-output prompt constraints, and common SDK response shapes. Image inputs via Chat Completions `image_url` or Responses `input_image`; each resolved image must be ≤ 1MB.

Intentionally rejected (Cursor does not expose equivalents on this path):

- `n` greater than `1`
- `logprobs` / `top_logprobs`
- audio output
- OpenAI function/tool calls on the Responses API
- background Responses API jobs

Token usage is estimated from character counts. For Composer 2.5 / Fast and Grok 4.5 / Fast, pricing metadata is published in OpenAI-compatible per-token form for clients like Hermes.

## Development

```bash
npm install
bun run typecheck
bun run test
bun run build
```

Scripts:

| Script | Action |
|---|---|
| `bun run server:bridge` | Node SDK bridge `:8792` |
| `bun run server` | Bun OpenAI API `:8788` |
| `bun run server:up` | Compose up |
| `bun run server:down` | Compose down |
| `bun run server:logs` | Follow compose logs |

## Security

- Prefer `HOST=127.0.0.1` and gateway auth (`LOCAL_API_KEY`) when exposing beyond a single trusted machine.
- Do not publish the bridge port.
- Do not commit `.env` or Cursor keys.
- This is a single-user local facade, not a multi-tenant hosted API.

## Research sources

- Cursor SDK package: `@cursor/sdk@1.0.13`
- Cursor SDK TypeScript docs: https://cursor.com/docs/api/sdk/typescript
- Cursor Composer 2.5 changelog: https://cursor.com/changelog/composer-2-5
- Cursor Grok 4.5 docs: https://cursor.com/docs/models/grok-4-5
- OpenAI Chat Completions reference: https://developers.openai.com/api/docs/api-reference/chat
- OpenAI Responses reference: https://developers.openai.com/api/docs/api-reference/responses
