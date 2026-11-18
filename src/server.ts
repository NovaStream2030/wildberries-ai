import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import {
  DEFAULT_MODEL,
  credentialsConfigured,
  loadConfig,
  loadCredentials,
  publicCredentials,
  saveCredentials,
  type AppConfig,
  type CredentialPatch,
} from "./config";
import { ApiError, errorResponse } from "./errors";
import { chatCompletion, textCompletion } from "./openai";
import { SessionStore } from "./prompt";
import { fetchWbReply } from "./wb";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

function allowedOrigins(cfg: AppConfig, server: Server<undefined>): Set<string> {
  return new Set([
    `http://127.0.0.1:${server.port}`,
    `http://localhost:${server.port}`,
    `http://[::1]:${server.port}`,
    ...cfg.allowedOrigins,
  ]);
}

function corsHeaders(
  req: Request,
  cfg: AppConfig,
  server: Server<undefined>,
): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins(cfg, server).has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,openai-organization,x-requested-with",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function assertOrigin(req: Request, cfg: AppConfig, server: Server<undefined>): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  // Non-browser clients (curl, OpenAI SDK, OMP) send no Origin. Browsers do,
  // so this blocks cross-site form/fetch CSRF even when CORS is not involved.
  if (origin && !allowedOrigins(cfg, server).has(origin)) {
    throw new ApiError(403, "origin_not_allowed", `Origin ${origin} is not allowed`);
  }
}

async function readJson(req: Request): Promise<unknown> {
  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    // Do not leave an unread body on a keep-alive connection: drain it and
    // let the response ask for a fresh connection.
    await req.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
}

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/favicon.svg": "favicon.svg",
};

function textResponse(body: string, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
      ...cors,
    },
  });
}

function isLoopback(req: Request, server: Server<undefined>): boolean {
  const address = server.requestIP(req)?.address ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

function authorizeWrite(req: Request, server: Server<undefined>, cfg: AppConfig): void {
  // When a token is configured it is required even on loopback: behind a
  // reverse proxy every request appears to come from 127.0.0.1.
  if (cfg.adminToken) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token !== cfg.adminToken) {
      throw new ApiError(401, "unauthorized", "Invalid ADMIN_TOKEN");
    }
    return;
  }
  if (!isLoopback(req, server)) {
    throw new ApiError(
      403,
      "forbidden",
      "Writes are allowed from loopback only. Set ADMIN_TOKEN to manage a remote instance.",
    );
  }
}

function assertHeaderSafe(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new ApiError(400, "invalid_credentials", `${field} must not contain CR/LF`);
  }
}

function parseCredentialPatch(raw: unknown): CredentialPatch {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const patch: CredentialPatch = {};
  if (body.clear === true) return { clear: true };

  if (body.jwt !== undefined) {
    if (typeof body.jwt !== "string") throw new ApiError(400, "invalid_jwt", "jwt must be a string");
    const jwt = body.jwt.replace(/^Bearer\s+/i, "").trim();
    if (jwt.length > 8192) throw new ApiError(400, "invalid_jwt", "jwt is too long");
    assertHeaderSafe(jwt, "jwt");
    patch.jwt = jwt;
  }
  if (body.userData !== undefined) {
    if (typeof body.userData !== "string") {
      throw new ApiError(400, "invalid_user_data", "userData must be a string");
    }
    const userData = body.userData.trim();
    if (userData.length > 16384) {
      throw new ApiError(400, "invalid_user_data", "userData is too long");
    }
    if (!/^[A-Za-z0-9_\-=.]+$/.test(userData)) {
      throw new ApiError(
        400,
        "invalid_user_data",
        "userData must be the URL-safe x-userdata value (A-Z, a-z, 0-9, -, _, =, .)",
      );
    }
    patch.userData = userData;
  }
  if (body.cookie !== undefined) {
    if (typeof body.cookie !== "string") {
      throw new ApiError(400, "invalid_cookie", "cookie must be a string");
    }
    const cookie = body.cookie.trim();
    if (cookie.length > 16384) throw new ApiError(400, "invalid_cookie", "cookie is too long");
    assertHeaderSafe(cookie, "cookie");
    patch.cookie = cookie;
  }
  if (body.userMetadata !== undefined) {
    if (body.userMetadata === null) {
      patch.userMetadata = null;
    } else if (typeof body.userMetadata === "object" && !Array.isArray(body.userMetadata)) {
      const meta: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.userMetadata)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          meta[key] = String(value);
        } else {
          throw new ApiError(
            400,
            "invalid_user_metadata",
            `userMetadata.${key} must be a string, number or boolean`,
          );
        }
      }
      if (Object.keys(meta).length > 64) {
        throw new ApiError(400, "invalid_user_metadata", "userMetadata has too many keys");
      }
      patch.userMetadata = meta;
    } else {
      throw new ApiError(
        400,
        "invalid_user_metadata",
        "userMetadata must be an object or null",
      );
    }
  }
  return patch;
}

export function createApp(cfg: AppConfig) {
  const sessions = new SessionStore(cfg.sessionTtlMs, cfg.maxSessions);

  async function handle(req: Request, server: Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req, cfg, server);

    assertOrigin(req, cfg, server);

    if (req.method === "OPTIONS") {
      if (req.headers.get("origin") && !cors["access-control-allow-origin"]) {
        return new Response(null, {
          status: 403,
          headers: { vary: "Origin", ...SECURITY_HEADERS },
        });
      }
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...cors },
      });
    }

    if (req.method === "GET" && STATIC[path]) {
      const file = Bun.file(join(PUBLIC_DIR, STATIC[path]));
      if (!(await file.exists())) return textResponse("Not found", 404, cors);
      const type =
        path.endsWith(".html") || path === "/"
          ? "text/html; charset=utf-8"
          : path.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : path.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "image/svg+xml";
      return new Response(file, {
        headers: {
          "content-type": type,
          "cache-control": "no-cache",
          ...SECURITY_HEADERS,
          ...cors,
        },
      });
    }

    if (req.method === "GET" && path === "/health") {
      const creds = loadCredentials(cfg);
      return Response.json(
        {
          ok: true,
          configured: credentialsConfigured(creds),
          upstream: cfg.upstreamUrl,
          model: DEFAULT_MODEL,
          sessions: sessions.size,
          uptime_seconds: Math.round(process.uptime()),
        },
        { headers: { ...cors, "cache-control": "no-store" } },
      );
    }

    if (req.method === "GET" && path === "/api/config") {
      const creds = loadCredentials(cfg);
      return Response.json(
        {
          ...publicCredentials(creds),
          model: DEFAULT_MODEL,
          upstream: cfg.upstreamUrl,
          adminTokenRequired: Boolean(cfg.adminToken),
        },
        { headers: { ...cors, "cache-control": "no-store" } },
      );
    }

    if (req.method === "POST" && path === "/api/config") {
      authorizeWrite(req, server, cfg);
      const patch = parseCredentialPatch(await readJson(req));
      const saved = saveCredentials(cfg, patch);
      return Response.json(
        { ok: true, ...publicCredentials(saved) },
        { headers: { ...cors, "cache-control": "no-store" } },
      );
    }

    if (req.method === "POST" && path === "/api/config/test") {
      authorizeWrite(req, server, cfg);
      const creds = loadCredentials(cfg);
      if (!credentialsConfigured(creds)) {
        throw new ApiError(503, "wb_not_configured", "WB credentials are not configured");
      }
      const reply = await fetchWbReply(
        "Привет! Ответь одним коротким предложением.",
        creds,
        cfg,
        AbortSignal.timeout(60_000),
      );
      return Response.json(
        {
          ok: true,
          text: reply.text,
          session_id: reply.sessionId ?? null,
          request_id: reply.requestId,
        },
        { headers: { ...cors, "cache-control": "no-store" } },
      );
    }

    if (req.method === "POST" && path === "/api/sessions/reset") {
      authorizeWrite(req, server, cfg);
      sessions.clear();
      return Response.json({ ok: true, sessions: 0 }, { headers: { ...cors, "cache-control": "no-store" } });
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      const created = 0;
      return Response.json(
        {
          object: "list",
          data: [
            { id: DEFAULT_MODEL, object: "model", created, owned_by: "wildberries" },
            { id: "wb", object: "model", created, owned_by: "wildberries" },
          ],
        },
        { headers: { ...cors, "cache-control": "no-store" } },
      );
    }

    if (
      req.method === "POST" &&
      (path === "/v1/chat/completions" || path === "/chat/completions")
    ) {
      const creds = loadCredentials(cfg);
      if (!credentialsConfigured(creds)) {
        throw new ApiError(
          503,
          "wb_not_configured",
          "WB credentials are not configured. Open the web UI and connect a logged-in WB session.",
        );
      }
      const raw = await readJson(req);
      const response = await chatCompletion(raw, creds, cfg, sessions, req.signal);
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) {
        response.headers.set(k, v);
      }
      return response;
    }

    if (req.method === "POST" && (path === "/v1/completions" || path === "/completions")) {
      const creds = loadCredentials(cfg);
      if (!credentialsConfigured(creds)) {
        throw new ApiError(
          503,
          "wb_not_configured",
          "WB credentials are not configured. Open the web UI and connect a logged-in WB session.",
        );
      }
      const raw = await readJson(req);
      const response = await textCompletion(raw, creds, cfg, sessions, req.signal);
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) {
        response.headers.set(k, v);
      }
      return response;
    }

    if (path.startsWith("/v1/") || path.startsWith("/api/")) {
      throw new ApiError(404, "not_found", `No route for ${req.method} ${path}`);
    }
    return textResponse("Not found", 404, cors);
  }

  return Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255,
    async fetch(req, server) {
      try {
        return await handle(req, server);
      } catch (err) {
        if (err instanceof ApiError && err.status === 499) {
          return new Response(null, { status: 499 });
        }
        const response = errorResponse(err);
        if (err instanceof ApiError && err.status === 413) {
          response.headers.set("connection", "close");
        }
        for (const [k, v] of Object.entries(corsHeaders(req, cfg, server))) {
          response.headers.set(k, v);
        }
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
          response.headers.set(k, v);
        }
        return response;
      }
    },
  });
}

if (import.meta.main) {
  const cfg = loadConfig();
  const server = createApp(cfg);
  const creds = loadCredentials(cfg);
  const status = credentialsConfigured(creds)
    ? `credentials: jwt=${creds.jwt ? "yes" : "no"} userdata=${creds.userData ? "yes" : "no"} cookie=${creds.cookie ? "yes" : "no"}`
    : "credentials: NOT CONFIGURED (open the UI to connect a WB session)";
  console.log(`WB AI OpenAI gateway: http://${cfg.host}:${server.port}`);
  console.log(`upstream: ${cfg.upstreamUrl}`);
  console.log(status);
  if (!existsSync(cfg.dataFile)) {
    console.log(`session file will be created at ${cfg.dataFile}`);
  }

  const shutdown = () => {
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
