# Changelog

## 1.0.0 — 2026-11-18

Initial public release.

- OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming)
  and `POST /v1/completions`.
- `GET /v1/models` with `wb-assistant`.
- WB upstream client with SSE parsing, timeouts, idle watchdog and clear
  upstream error mapping.
- Stateful WB sessions mapped from stateless OpenAI transcripts; automatic
  session replay after an expired WB session.
- `WB_PROMPT_MODE=auto|inline|last` to avoid sending huge coding-agent system
  prompts to WB.
- Web chat UI with streaming, stop, suggestions, history and a session capture
  helper.
- Credentials stored outside the repository by default; legacy
  `data/session.json` still read.
- Hardened browser surface: restricted CORS, CSP, body limit, loopback-only
  writes or `ADMIN_TOKEN`.
- OMP `models.yml` integration documented and verified.
- 29 tests with a fake WB SSE server.
- Cross-site Origin guard and JSON content-type enforcement.
