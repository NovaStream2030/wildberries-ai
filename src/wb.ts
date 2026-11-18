import { createHash, randomUUID } from "node:crypto";
import type { WbCredentials, AppConfig } from "./config";
import { ApiError } from "./errors";

export interface WbStreamEvent {
  type: "start" | "text" | "suggests" | "done" | "error" | "unknown";
  text?: string;
  suggests?: string[];
  sessionId?: string;
  error?: string;
  scenario?: string;
  topic?: string;
  state?: string;
}

export interface WbStream {
  status: number;
  requestId: string | null;
  statusNoId: string | null;
  events: AsyncGenerator<WbStreamEvent>;
  close: () => void;
}

const DEFAULT_METADATA: Record<string, string> = {
  appType: "1",
  curr: "rub",
  dest: "1259570991",
  spp: "30",
  hide_vflags: "4294967296",
  lb: "8440;8439;8441",
  mdg: "123",
  ldg: "5219;5227;5255;5256;4787;6459;6387;6207;6202;5827;2965;3096;3103;2491;3107",
  uf: "10",
  ab_testing: "false",
  uiv: "0",
  uclusters: "2",
  locale: "ru",
  lang: "ru",
  fpremiumuser: "false",
};

const FEATURES = {
  snippets: {
    supported_types: [
      "products_base",
      "product_button_to_checkout",
      "products_fav_base",
      "products_purchases_base",
      "products_orders_base",
      "products_you_watched_base",
      "products_basket_base",
      "hotels_base",
    ],
  },
  products: { supported_types: ["goods", "hotels"] },
  flags: { multi_products: true },
};

const CLIENT_DATA = { platform: "web", mode: "browser" };

function metadataFor(creds: WbCredentials): Record<string, string> {
  const deviceId =
    creds.userMetadata.device_id ||
    `site_${createHash("sha256").update(creds.userData || creds.jwt).digest("hex").slice(0, 32)}`;
  return {
    ...DEFAULT_METADATA,
    ...creds.userMetadata,
    device_id: deviceId,
    uv: creds.userData,
    uiv: creds.userMetadata.uiv || "0",
  };
}

export function buildUpstreamBody(
  text: string,
  sessionId: string | undefined,
  creds: WbCredentials,
): Record<string, unknown> {
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    timestamp: new Date().toISOString(),
    text,
    user_metadata: metadataFor(creds),
    features: FEATURES,
    client_data: CLIENT_DATA,
    idempotency_key: randomUUID(),
  };
}

function formatDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const code = record.code ?? record.error_code ?? record.type;
    const message = record.message ?? record.error ?? record.description;
    if (code || message) return [code, message].filter(Boolean).join(": ");
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function upstreamError(res: Response, body: string): ApiError {
  const status = res.status;
  const statusNoId = res.headers.get("status-no-id") ?? "";
  const requestId = res.headers.get("x-request-id") ?? "";
  const tail = [statusNoId && `status-no-id=${statusNoId}`, requestId && `request-id=${requestId}`, body.trim().slice(0, 500)]
    .filter(Boolean)
    .join(", ");

  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      "wb_unauthorized",
      "WB отклонил сессию: нужен свежий JWT и x-userdata авторизованного пользователя. " +
        "Откройте ИИ-ассистента на wildberries.ru, перехватите запрос (см. README) и обновите настройки",
      "upstream_error",
      tail || `HTTP ${status}`,
    );
  }
  if (status === 498) {
    return new ApiError(
      502,
      "wb_antibot",
      "WB требует пройти антибот-проверку. Запустите запрос из браузера, где открыт wildberries.ru, " +
        "и обновите сессионные данные",
      "upstream_error",
      tail,
    );
  }
  if (status === 429) {
    return new ApiError(429, "wb_rate_limited", "WB ограничил частоту запросов", "upstream_error", tail);
  }
  if (status === 404 || status === 410) {
    return new ApiError(
      404,
      "wb_session_expired",
      "WB-сессия истекла или не найдена",
      "upstream_error",
      tail,
    );
  }
  return new ApiError(
    502,
    "wb_upstream_error",
    `WB вернул HTTP ${status}`,
    "upstream_error",
    tail || undefined,
  );
}

interface RawSseEvent {
  event: string;
  data: string;
}

function parseSseBlock(block: string): RawSseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  touch: () => void,
): AsyncGenerator<RawSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("\r\n")) buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const ev = parseSseBlock(block);
        if (ev) yield ev;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const ev = parseSseBlock(buffer);
    if (ev) yield ev;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The upstream may already be closed.
    }
    reader.releaseLock();
  }
}

function translate(data: unknown): WbStreamEvent {
  if (!data || typeof data !== "object") return { type: "unknown" };
  const payload = data as Record<string, unknown>;
  const type = payload.type;
  const body = (payload.data ?? {}) as Record<string, unknown>;

  if (type === "system_info") {
    return {
      type: "start",
      sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
    };
  }
  if (type === "text") {
    return { type: "text", text: typeof body.text === "string" ? body.text : "" };
  }
  if (type === "suggests") {
    const suggests = Array.isArray(body.suggests)
      ? body.suggests.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    return { type: "suggests", suggests };
  }
  if (type === "scenario_info") {
    if (body.error_details) {
      return { type: "error", error: formatDetail(body.error_details) };
    }
    // WB uses state "ignored" for off-topic/refused turns that still carry
    // text. Only error_details is fatal; everything else closes the turn.
    const state = (body.state_manager as Record<string, unknown> | undefined)?.state;
    return {
      type: "done",
      scenario: typeof body.scenario === "string" ? body.scenario : undefined,
      topic: typeof body.topic_name === "string" ? body.topic_name : undefined,
      state: typeof state === "string" ? state : undefined,
    };
  }
  if (type === "error") {
    return { type: "error", error: formatDetail(body.error ?? body) };
  }
  return { type: "unknown" };
}

/**
 * Opens the WB SSE stream. The caller must always consume `events`; its
 * `finally` closes the upstream request and timers.
 */
export async function openWbStream(
  text: string,
  sessionId: string | undefined,
  creds: WbCredentials,
  cfg: AppConfig,
  signal?: AbortSignal,
): Promise<WbStream> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new ApiError(499, "client_closed", "Client closed the request");
    signal.addEventListener("abort", forwardAbort, { once: true });
  }

  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.requestTimeoutMs);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, cfg.idleTimeoutMs);
  };

  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-language": "ru-RU,ru;q=0.9",
    "content-type": "application/json",
    origin: "https://www.wildberries.ru",
    referer: "https://www.wildberries.ru/",
    "user-agent": cfg.userAgent,
    "x-accept-markdown": "true",
    "x-client": "web",
    "x-userdata": creds.userData,
  };
  if (creds.jwt) headers.authorization = `Bearer ${creds.jwt}`;
  if (creds.cookie) headers.cookie = creds.cookie;

  let response: Response;
  try {
    response = await fetch(cfg.upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(buildUpstreamBody(text, sessionId, creds)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    if (signal?.aborted) throw new ApiError(499, "client_closed", "Client closed the request");
    if (timedOut) {
      throw new ApiError(504, "wb_timeout", "WB не ответил за отведённое время", "upstream_error");
    }
    throw new ApiError(
      502,
      "wb_unreachable",
      "Не удалось подключиться к ai-proxy.wildberries.ru",
      "upstream_error",
      (err as Error).message,
    );
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    signal?.removeEventListener("abort", forwardAbort);
    throw upstreamError(response, body);
  }
  if (!response.body) {
    signal?.removeEventListener("abort", forwardAbort);
    throw new ApiError(502, "wb_empty_response", "WB вернул пустой ответ", "upstream_error");
  }

  touch();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };

  const requestId = response.headers.get("x-request-id");
  const statusNoId = response.headers.get("status-no-id");
  const raw = parseSse(response.body, touch);

  const events = (async function* () {
    try {
      for await (const ev of raw) {
        let data: unknown;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const translated = translate(data);
        if (translated.type === "unknown") continue;
        yield translated;
        if (translated.type === "done" || translated.type === "error") return;
      }
    } catch (err) {
      if (signal?.aborted) throw new ApiError(499, "client_closed", "Client closed the request");
      if (timedOut) {
        throw new ApiError(504, "wb_timeout", "WB перестал присылать данные", "upstream_error");
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        502,
        "wb_stream_error",
        "Ошибка чтения потока WB",
        "upstream_error",
        (err as Error).message,
      );
    } finally {
      close();
    }
  })();

  return { status: response.status, requestId, statusNoId, events, close };
}

export interface WbReply {
  text: string;
  suggests: string[];
  sessionId?: string;
  requestId: string | null;
  statusNoId: string | null;
}

/** Non-streaming helper used by /api/config/test and /v1/completions. */
export async function fetchWbReply(
  text: string,
  creds: WbCredentials,
  cfg: AppConfig,
  signal?: AbortSignal,
): Promise<WbReply> {
  const upstream = await openWbStream(text, undefined, creds, cfg, signal);
  let reply = "";
  let sessionId: string | undefined;
  let suggests: string[] = [];
  for await (const ev of upstream.events) {
    if (ev.type === "start") sessionId = ev.sessionId;
    else if (ev.type === "text") reply += ev.text ?? "";
    else if (ev.type === "suggests") suggests = ev.suggests ?? [];
    else if (ev.type === "error") {
      throw new ApiError(502, "wb_assistant_error", ev.error || "WB assistant error", "upstream_error");
    }
  }
  if (!reply.trim()) {
    throw new ApiError(502, "wb_empty_reply", "WB вернул пустой ответ", "upstream_error");
  }
  return {
    text: reply,
    suggests,
    sessionId,
    requestId: upstream.requestId,
    statusNoId: upstream.statusNoId,
  };
}
