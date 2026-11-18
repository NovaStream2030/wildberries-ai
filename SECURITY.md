# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | yes       |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

https://github.com/NovaStream2030/wildberries-ai/security/advisories/new

Do not open a public issue for a vulnerability that exposes credentials,
allows cross-origin use of a local gateway, or lets another user spend a WB
account's requests.

## Threat model

This project is a **local** bridge between an OpenAI-compatible client and the
Wildberries AI assistant. It acts with the WB session you connect:

- `jwt`, `x-userdata` and `cookie` are stored on disk, by default in
  `~/.config/wildberries-ai/session.json` (`$XDG_CONFIG_HOME` respected), mode
  `0600`. Older installs may keep `data/session.json`; it is git-ignored.
- Anyone who can reach the listening socket can send requests as that session.
  The default bind address is `127.0.0.1`; do not change it to a public
  interface without a reverse proxy, TLS and `ADMIN_TOKEN`.
- `POST /api/config`, `/api/config/test` and `/api/sessions/reset` are writes.
  They are loopback-only by default. If `ADMIN_TOKEN` is set, the bearer token
  is required for every write, including loopback (a reverse proxy makes remote
  clients look local). The web UI has an "Admin token" field.
- Browser CORS is restricted to the gateway's own origin plus explicit
  `ALLOWED_ORIGINS`. Do not set `ALLOWED_ORIGINS=*`: a malicious page could
  otherwise spend your WB session.
- Request bodies are capped at 2 MiB.

## If a token leaks

1. Sign out of Wildberries (or terminate the session that was captured).
2. Replace `jwt` / `x-userdata` in the UI, or delete the session file:
   `rm ~/.config/wildberries-ai/session.json` (and `data/session.json` if it
   exists).
3. Review WB account activity and active sessions.

## Scope

This is an unofficial client for a private endpoint. Vulnerabilities in
Wildberries services themselves are out of scope; report those to Wildberries.
