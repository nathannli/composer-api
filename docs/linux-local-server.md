# Local Linux OpenAI-compatible server

Run API for Cursor as a headless OpenAI-compatible endpoint on Linux (Bun API + Cursor SDK bridge). Aimed at agents like **Hermes** that accept a custom `base_url`.

## Architecture

```text
Hermes / client
   │  Bearer: LOCAL_API_KEY (or Cursor key in direct mode)
   ▼
Bun API  :8788
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

Default API port is **8788** so it does not collide with **hermes-webui** on `:8787`. Override with `PORT` if needed. Bridge remains on **8792**.

## Quick start

Two ways to run this stack:

1. **Bare metal** — Node bridge + Bun API on the host (two terminals, or one systemd user unit)
2. **Docker Compose** — same two processes in containers (`bun run server:up`)

Requirements: Node ≥ 18 (for the SDK bridge — **do not run the bridge under Bun**),
[Bun](https://bun.sh) ≥ 1.3 (OpenAI facade; also used for Compose helper scripts), a Cursor user API key.
For Compose you also need Docker with the Compose plugin.

Bun’s HTTP/2 client hits `NGHTTP2_FRAME_SIZE_ERROR` with `@cursor/sdk`; always use
`node` / `bun run server:bridge` (which invokes Node) for the bridge.

Shared setup:

```bash
cp .env.example .env
# edit .env — at minimum:
#   CURSOR_API_KEY=...          # Cursor dashboard key
#   LOCAL_API_KEY=...           # optional gateway key clients send as Bearer
#   CURSOR_SDK_WORKING_DIRECTORY=/home/you/projects/my-app
#   CURSOR_SDK_BRIDGE_TOKEN=... # random shared secret bridge↔api
# Recommended for Hermes: COMPOSER_API_MODELS=composer-2.5,grok-4.5

npm install   # or: bun install
```

### Option 1: Bare metal

`bun run` loads the repository `.env` for both scripts, including quoted values. Two terminals:

```bash
# terminal 1 — bridge
bun run server:bridge

# terminal 2 — OpenAI facade
bun run server
```

Or install the systemd user unit (starts both processes, stops both on exit) — see [systemd](#systemd-optional-bare-metal).

### Option 2: Docker Compose

```bash
export CURSOR_API_KEY=YOUR_API_KEY
export LOCAL_API_KEY=$(openssl rand -hex 24)
export CURSOR_SDK_BRIDGE_TOKEN=$(openssl rand -hex 24)
export CURSOR_SDK_WORKSPACE_HOST=$HOME/projects/my-app
export CURSOR_SDK_WORKING_DIRECTORY=/workspace
# optional: COMPOSER_API_MODELS=composer-2.5,grok-4.5

bun run server:up          # docker compose up --build -d
bun run server:logs
# bun run server:down
```

- API published on host loopback at `127.0.0.1:${PORT:-8788}`
- Bridge is **not** published (compose network only)
- Host folder mounts at `/workspace` inside the bridge

To publish the API beyond loopback, edit the host address in `docker-compose.yml` and enable gateway mode with a nonempty `LOCAL_API_KEY`.

### Smoke

Same for either method:

```bash
curl -s http://127.0.0.1:8788/health | jq .
curl -s http://127.0.0.1:8788/v1/models | jq '.data[].id'
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "authorization: Bearer YOUR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker api service) |
| `PORT` | `8788` | API port |
| `CURSOR_SDK_BRIDGE_URL` | `http://127.0.0.1:8792/sdk` | Bridge endpoint |
| `CURSOR_SDK_BRIDGE_TOKEN` | empty | Shared secret API → bridge |
| `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS` | `180000` | Per-attempt SDK run timeout in the bridge |
| `CURSOR_SDK_BRIDGE_REQUEST_TIMEOUT_MS` | `900000` | End-to-end API → bridge HTTP deadline, including streamed bodies |
| `CURSOR_SDK_CONTEXT_WINDOW_REFRESH_MS` | `900000` | Minimum interval between checkpoint context-window refreshes per model |
| `SHUTDOWN_GRACE_MS` | `10000` | Graceful API drain period before in-flight requests are forced closed |
| `CURSOR_SDK_WORKING_DIRECTORY` | `process.cwd()` | Default agent cwd / tool root |
| `CURSOR_SDK_CONTEXT_WINDOWS_FILE` | `.cursor-sdk-context-windows.json` | Shared mode-600 cache learned from completed-run checkpoints |
| `COMPOSER_API_MODELS` | empty | Optional comma-separated model allowlist; filters discovery and rejects unlisted Chat/Responses requests |
| `CURSOR_API_KEY` | empty | Cursor secret kept on the server |
| `LOCAL_API_KEY` | empty | Optional gateway key for clients |

### Auth modes

Server-wide for any OpenAI-compatible client (curl, SDKs, Hermes, etc.):

1. **Direct** — leave `LOCAL_API_KEY` empty; clients send the Cursor API key as Bearer.
2. **Gateway** — set both `CURSOR_API_KEY` and `LOCAL_API_KEY`; clients send `LOCAL_API_KEY`, the server forwards `CURSOR_API_KEY` to Cursor.

## Hermes custom endpoint

Hermes uses OpenAI-compatible **chat completions**. Add a `custom_providers` entry (prefer `hermes config set` over hand-editing YAML):

```yaml
# ~/.hermes/config.yaml
custom_providers:
  - name: composer-api
    base_url: http://127.0.0.1:8788/v1
    key_env: CURSOR_API_KEY   # or LOCAL_API_KEY when gateway mode is on
    api_mode: chat_completions
    models:
      - id: composer-2.5
      - id: grok-4.5
```

Put the matching secret in `~/.hermes/.env` (e.g. `CURSOR_API_KEY=...`). Select with:

```text
/model @custom:composer-api:composer-2.5
```

### Model allowlist (recommended)

Hermes defaults to live discovery for custom OpenAI-compatible providers. If
`COMPOSER_API_MODELS` is unset, `/v1/models` returns the full bundled catalog
and Hermes will replace your short configured `models:` list after the first
chat. Restrict the API (and restart):

```bash
# in the repo .env loaded by systemd / docker
COMPOSER_API_MODELS=composer-2.5,grok-4.5
systemctl --user restart composer-api
```

When unset or blank, the full bundled catalog is advertised. When set, the same
allowlist also applies to `POST /v1/chat/completions` and `POST /v1/responses`;
unlisted model IDs return `404 model_not_found` before the SDK bridge is called.
Keep the allowlist in sync with the Hermes `models:` list.

### What Hermes needs (minimum)

| Endpoint | Required for Hermes chat |
|---|---|
| `GET /v1/models` | Yes (catalog / validation) |
| `POST /v1/chat/completions` (stream) | **Yes** |
| `POST /v1/responses` | No (other clients) |

Streaming chat is implemented. Keep the server and bridge running for the whole Hermes session.

## systemd (optional bare metal)

A single user unit starts **both** the Node bridge and Bun API via a launcher:

- Repo unit: `systemd-service-files/composer-api.service`
- Repo launcher: `systemd-service-files/composer-api` (Node bridge + Bun API; kills both on exit)

Install (adjust paths if your repo is elsewhere):

```bash
mkdir -p ~/.config/systemd/user ~/.local/bin
cp systemd-service-files/composer-api.service ~/.config/systemd/user/
install -m 0755 systemd-service-files/composer-api ~/.local/bin/composer-api
systemctl --user daemon-reload
systemctl --user enable --now composer-api
```

Repo unit shape:

```ini
[Unit]
Description=Composer API and Cursor SDK bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/composer-api
EnvironmentFile=-%h/composer-api/.env
ExecStart=%h/.local/bin/composer-api
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=control-group

[Install]
WantedBy=default.target
```

```bash
systemctl --user restart composer-api
systemctl --user status composer-api
journalctl --user -u composer-api -f
```

Put `COMPOSER_API_MODELS` (and other secrets) in the repo `.env` loaded by `EnvironmentFile`. The launcher uses the unit's `WorkingDirectory` by default; override it with `COMPOSER_API_REPO_DIR` if needed. Do not hardcode usernames; the unit uses `%h`.

## Security notes

- Prefer `HOST=127.0.0.1` and gateway auth (`LOCAL_API_KEY`).
- Do not publish the bridge port.
- Do not commit `.env` or Cursor keys.
- This is a **single-user local** facade, not a multi-tenant hosted API.

## npm / bun scripts

| Script | Action |
|---|---|
| `bun run server:bridge` | SDK bridge |
| `bun run server` | OpenAI API on `:8788` |
| `bun run server:up` | Compose up |
| `bun run server:down` | Compose down |
| `bun run server:logs` | Follow logs |
