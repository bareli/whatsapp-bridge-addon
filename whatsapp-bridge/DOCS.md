# WhatsApp Bridge

> **Warning — unofficial WhatsApp client.** This add-on uses
> [`whatsapp-web.js`](https://wwebjs.dev/), which automates WhatsApp Web on
> your behalf. WhatsApp's Terms of Service do not authorize bot-style use of
> personal accounts. Your account may be banned, temporarily or permanently.
> **Use a secondary phone number, not your primary one.** You accept this
> risk by installing the add-on.

This add-on runs a small Node.js service that:

- Pairs with your phone via QR code (one-time scan).
- Exposes a local HTTP + WebSocket API on port `8080`.
- Persists the session under `/data` so reboots do not require re-pairing.

It is intended to be paired with the
[WhatsApp Bridge HACS package](https://github.com/bareli/whatsapp-bridge-hass),
which provides the Home Assistant integration, services, and Lovelace card.

## Installation

1. Add this repository to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Install **WhatsApp Bridge**.
3. Start the add-on. The first start downloads Chromium and may take several minutes.
4. Watch the logs for the line:
   `Generated API token: <token>. Save this in add-on options to keep it stable.`
5. Optionally paste that token into the **Configuration** tab so it survives reinstalls.
6. Install the HACS package and follow its setup.

## Configuration

| Option | Default | Description |
|---|---|---|
| `log_level` | `info` | One of `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |
| `api_token` | _(blank)_ | Bearer token for HTTP/WS API. Auto-generated on first boot if blank. |
| `qr_refresh_seconds` | `30` | Maximum age of a QR before regenerating. |
| `puppeteer_executable` | _(blank)_ | Override the Chromium binary path. |
| `proxy_url` | _(blank)_ | Optional HTTP/SOCKS proxy for outbound traffic. |

## Architecture

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Supervisor watchdog (no auth). |
| `GET /bootstrap` | One-shot token retrieval (only when `api_token` blank). |
| `GET /status` | Current state, phone number, battery. |
| `GET /qr.png` | QR code as PNG. |
| `GET /qr` | Raw QR string + timestamp. |
| `POST /send/text` | `{to, body, quoted_msg_id?}` |
| `POST /send/media` | multipart `to`, `caption?`, `file`, `as_document?`, `as_voice?` |
| `POST /send/location` | `{to, lat, lng, name?}` |
| `GET /contacts` | Phone-side WhatsApp contacts. |
| `POST /session/logout` | Force re-pair. |
| `POST /session/restart` | Recreate the underlying client. |
| `GET /ws` | WebSocket event stream (`state`, `qr`, `message`, `ack`). |

The session is stored under `/data/wwebjs_auth`, which is preserved by
Supervisor across add-on restarts and updates.
