import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { loadConfig, type AppConfig } from "../src/config";
import { createApp } from "../src/server";

interface UpstreamBody {
  text: string;
  session_id?: string;
  user_metadata: { uv: string; device_id?: string };
  client_data: { platform: string; mode: string };
}

interface UpstreamCall {
  body: UpstreamBody;
  authorization: string | null;
  userData: string | null;
  cookie: string | null;
}

interface ChatResponse {
  object: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  wb: { suggests: string[]; session_id: string | null };
  usage: { total_tokens: number };
}

interface ModelsResponse {
  object: string;
  data: { id: string }[];
}

const VALID_JWT = "test-jwt";
const VALID_UV = "test-uv";

let tempDir: string;
let dataFile: string;
let upstream: Server<undefined>;
let app: Server<undefined>;
let cfg: AppConfig;
const calls: UpstreamCall[] = [];

function writeCredentials(jwt: string, userData: string) {
  writeFileSync(
    dataFile,
    JSON.stringify({
      jwt,
      userData,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}

async function post(path: string, body: unknown, signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${app.port}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function streamedBody(): Promise<{ text: string; deltas: string }> {
  return post("/v1/chat/completions", {
    model: "wb-assistant",
    stream: true,
    messages: [{ role: "user", content: "стрим-тест" }],
  }).then(async (res) => {
    expect(res.status).toBe(200);
    const text = await res.text();
    let deltas = "";
    for (const block of text.split("\n\n")) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      const json = JSON.parse(data);
      deltas += json.choices?.[0]?.delta?.content ?? "";
    }
    return { text, deltas };
  });
}

beforeAll(() => {
  delete process.env.WB_JWT;
  delete process.env.WB_USER_DATA;
  delete process.env.WB_COOKIE;
  delete process.env.WB_USER_METADATA;

  tempDir = mkdtempSync(join(tmpdir(), "wbai-test-"));
  dataFile = join(tempDir, "session.json");
  writeCredentials(VALID_JWT, VALID_UV);

  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as UpstreamBody;
      const call: UpstreamCall = {
        body,
        authorization: req.headers.get("authorization"),
        userData: req.headers.get("x-userdata"),
        cookie: req.headers.get("cookie"),
      };
      calls.push(call);

      if (call.authorization !== `Bearer ${VALID_JWT}` || call.userData !== VALID_UV) {
        return new Response("", {
          status: 401,
          headers: { "status-no-id": "PG-TEST-401", "x-request-id": "req-auth-fail" },
        });
      }

      const sessionId = typeof body.session_id === "string" ? body.session_id : "wb-session-1";
      const state = body.text.includes("ignored-state") ? "ignored" : "success";
      const events = [
        `id: 1\nevent: start\ndata: ${JSON.stringify({
          type: "system_info",
          data: { session_id: sessionId, timestamp_start_execution: new Date().toISOString() },
        })}`,
        `id: 2\nevent: chunk\ndata: ${JSON.stringify({
          type: "text",
          data: { block_position: "start", text: "Привет" },
        })}`,
        `id: 3\nevent: chunk\ndata: ${JSON.stringify({
          type: "text",
          data: { block_position: "end", text: ", мир!" },
        })}`,
        `id: 4\nevent: chunk\ndata: ${JSON.stringify({
          type: "suggests",
          data: { suggests: ["Что умеешь?", "Найди товар"] },
        })}`,
        `id: 5\nevent: done\ndata: ${JSON.stringify({
          type: "scenario_info",
          data: {
            scenario: "chat",
            topic_name: "test",
            state_manager: { state },
            error_details: null,
          },
        })}`,
      ];
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`${event}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "x-request-id": "req-test",
          "status-no-id": "PG-TEST-200",
        },
      });
    },
  });

  cfg = {
    ...loadConfig(),
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstream.port}/ai-proxy/api/chat/v5/message`,
    dataFile,
    sessionTtlMs: 60_000,
    maxSessions: 50,
  };
  app = createApp(cfg);
});

afterAll(() => {
  app?.stop(true);
  upstream?.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeCredentials(VALID_JWT, VALID_UV);
  calls.length = 0;
});

describe("OpenAI-compatible API", () => {
  test("lists models", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toContain("wb-assistant");
  });

  test("returns a non-streaming chat completion", async () => {
    const res = await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [{ role: "user", content: "привет" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "Привет, мир!" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.wb.suggests).toEqual(["Что умеешь?", "Найди товар"]);
    expect(body.wb.session_id).toBe("wb-session-1");
    expect(typeof body.usage.total_tokens).toBe("number");

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(`Bearer ${VALID_JWT}`);
    expect(calls[0].userData).toBe(VALID_UV);
    expect(calls[0].body.text).toBe("привет");
    expect(calls[0].body.user_metadata.uv).toBe(VALID_UV);
    expect(calls[0].body.client_data).toEqual({ platform: "web", mode: "browser" });
    expect(calls[0].body.session_id).toBeUndefined();
  });

  test("reuses the WB session on the next turn", async () => {
    const first = await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [{ role: "user", content: "сессия-1" }],
    });
    const firstBody = (await first.json()) as ChatResponse;

    const second = await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [
        { role: "user", content: "сессия-1" },
        { role: "assistant", content: firstBody.choices[0].message.content },
        { role: "user", content: "а ты кто?" },
      ],
    });
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.session_id).toBe("wb-session-1");
    expect(calls[1].body.text).toBe("а ты кто?");
  });

  test("does not leak one fresh conversation into another", async () => {
    await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [{ role: "user", content: "первый независимый" }],
    });
    await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [{ role: "user", content: "второй независимый" }],
    });
    expect(calls[1].body.session_id).toBeUndefined();
    expect(calls[1].body.text).toBe("второй независимый");
  });

  test("embeds system prompt and history into a fresh session", async () => {
    const res = await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [
        { role: "system", content: "Отвечай как пират." },
        { role: "user", content: "привет" },
        { role: "assistant", content: "Арр!" },
        { role: "user", content: "как дела?" },
      ],
    });
    expect(res.status).toBe(200);
    expect(calls[0].body.session_id).toBeUndefined();
    expect(calls[0].body.text).toContain("Отвечай как пират.");
    expect(calls[0].body.text).toContain("Ассистент: Арр!");
    expect(calls[0].body.text.trimEnd().endsWith("Пользователь: как дела?")).toBe(true);
  });

  test("streams OpenAI-schema SSE chunks and a done marker", async () => {
    const { text, deltas } = await streamedBody();
    expect(deltas).toBe("Привет, мир!");
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"suggests":["Что умеешь?","Найди товар"]');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("treats WB state ignored as a normal completed turn", async () => {
    const res = await post("/v1/chat/completions", {
      model: "wb-assistant",
      messages: [{ role: "user", content: "ignored-state" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse & { wb: { state: string } };
    expect(body.choices[0].message.content).toBe("Привет, мир!");
    expect(body.wb.state).toBe("ignored");
  });

  test("supports the legacy completions endpoint", async () => {
    const res = await post("/v1/completions", {
      model: "wb-assistant",
      prompt: "привет",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("text_completion");
    expect(body.choices[0].text).toBe("Привет, мир!");
  });

  test("rejects unsupported image content", async () => {
    const res = await post("/v1/chat/completions", {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_content");
  });

  test("maps an upstream 401 to a clear error", async () => {
    writeCredentials("wrong-jwt", VALID_UV);
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "привет" }],
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("wb_unauthorized");
    expect(body.error.message).toContain("JWT");
  });

  test("returns 503 when no credentials are configured", async () => {
    writeFileSync(dataFile, "{}", { mode: 0o600 });
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "привет" }],
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("wb_not_configured");
  });

  test("tests credentials through /api/config/test", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/config/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe("Привет, мир!");
  });

  test("never exposes secrets in /api/config", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/config`);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.hasJwt).toBe(true);
    expect(body.hasUserData).toBe(true);
    expect(JSON.stringify(body)).not.toContain(VALID_JWT);
    expect(JSON.stringify(body)).not.toContain(VALID_UV);
  });

  test("blocks cross-origin browser access and allows the local UI origin", async () => {
    const base = `http://127.0.0.1:${app.port}`;
    const evil = await fetch(`${base}/v1/models`, {
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(200);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    await evil.text();

    const evilPreflight = await fetch(`${base}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(evilPreflight.status).toBe(403);

    const localPreflight = await fetch(`${base}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { origin: base, "access-control-request-method": "POST" },
    });
    expect(localPreflight.status).toBe(204);
    expect(localPreflight.headers.get("access-control-allow-origin")).toBe(base);

    const evilPost = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ messages: [{ role: "user", content: "привет" }] }),
    });
    expect(evilPost.status).toBe(403);
    await evilPost.text();
  });

  test("rejects non-JSON request bodies", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: `http://127.0.0.1:${app.port}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "привет" }] }),
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_media_type");
  });

  test("rejects an oversized request body", async () => {
    const bigFile = join(tempDir, "big.json");
    writeFileSync(bigFile, JSON.stringify({ jwt: VALID_JWT, userData: VALID_UV }), {
      mode: 0o600,
    });
    const big = createApp({ ...cfg, port: 0, dataFile: bigFile });
    try {
      const res = await fetch(`http://127.0.0.1:${big.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${big.port}`,
        },
        body: JSON.stringify({
          model: "wb-assistant",
          messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 10) }],
        }),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("payload_too_large");
    } finally {
      big.stop(true);
    }
  });

  test("requires ADMIN_TOKEN for writes when configured", async () => {
    const securedFile = join(tempDir, "secured.json");
    writeFileSync(securedFile, JSON.stringify({ jwt: VALID_JWT, userData: VALID_UV }), {
      mode: 0o600,
    });
    const secured = createApp({ ...cfg, port: 0, dataFile: securedFile, adminToken: "secret" });
    try {
      const base = `http://127.0.0.1:${secured.port}/api/config`;
      const origin = `http://127.0.0.1:${secured.port}`;
      const denied = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ jwt: "next", userData: "next" }),
      });
      expect(denied.status).toBe(401);
      await denied.text();

      const allowed = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          authorization: "Bearer secret",
        },
        body: JSON.stringify({ jwt: "next", userData: "next" }),
      });
      expect(allowed.status).toBe(200);
      await allowed.text();
    } finally {
      secured.stop(true);
    }
  });

  test("serves the web UI and health check", async () => {
    const ui = await fetch(`http://127.0.0.1:${app.port}/`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("WB AI");
    const health = await fetch(`http://127.0.0.1:${app.port}/health`);
    const body = await health.json();
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
  });
});
