# Contributing

Thanks for taking a look. This is a small, dependency-free Bun + TypeScript
project.

## Setup

```bash
git clone https://github.com/NovaStream2030/wildberries-ai.git
cd wildberries-ai
bun install
bun run check   # tsc --noEmit && bun test
bun run dev     # http://127.0.0.1:8787
```

Requires Bun 1.1 or newer.

## Rules

- No runtime dependencies unless there is a strong reason. Prefer the standard
  library, `Bun.serve`, `fetch` and `node:crypto`.
- TypeScript stays strict; `bun run typecheck` must pass.
- Keep the OpenAI surface compatible: `stream`, `[DONE]`, `finish_reason`,
  `usage`, and OpenAI-shaped errors. Unknown upstream events must not break
  clients.
- Tests must not call the real Wildberries endpoint. Use a local fake SSE
  server, as `test/integration.test.ts` does.
- Never commit credentials, a HAR file, screenshots containing tokens, or
  `data/session.json`. The default credential path is outside the repository;
  the legacy path is git-ignored.
- Security-sensitive changes (CORS, credentials, request limits, admin auth)
  need a regression test.

## Pull requests

- Describe the user-visible behavior and how you verified it.
- Run `bun run check`.
- Keep diffs focused. If you change the upstream wire format, update
  `README.md` and the relevant tests.
