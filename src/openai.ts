import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import type { ChatMessage, Plan, SessionStore } from "./prompt";
import { buildPlan, nextConversationKey } from "./prompt";
import type { AppConfig, WbCredentials } from "./config";
import type { WbStream, WbStreamEvent } from "./wb";
import { openWbStream } from "./wb";

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
}

export interface ParsedCompletionRequest {
  model: string;
  prompt: string;
  stream: boolean;
  includeUsage: boolean;
}

function contentToText(content: unknown, where: string): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        throw new ApiError(400, "invalid_content", `${where}: unsupported content part`);
      }
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else if (item.type === "image_url" || item.type === "input_image") {
        throw new ApiError(
          400,
          "unsupported_content",
          `${where}: WB AI assistant accepts text only; image parts are not supported`,
        );
      } else {
        throw new ApiError(
          400,
          "unsupported_content",
          `${where}: unsupported content part type "${String(item.type)}"`,
        );
      }
    }
    return parts.join("\n");
  }
  throw new ApiError(400, "invalid_content", `${where}: content must be a string or an array`);
}

export function parseChatRequest(raw: unknown): ParsedChatRequest {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "invalid_messages", "messages must be a non-empty array");
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new ApiError(400, "unsupported_n", "Only n=1 is supported", "invalid_request_error");
  }

  const messages: ChatMessage[] = body.messages.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ApiError(400, "invalid_messages", `messages[${index}] must be an object`);
    }
    const msg = item as Record<string, unknown>;
    const role = msg.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new ApiError(
        400,
        "invalid_role",
        `messages[${index}].role must be system, user or assistant`,
      );
    }
    return { role, content: contentToText(msg.content, `messages[${index}]`) };
  });

  if (!messages.some((m) => m.role === "user")) {
    throw new ApiError(400, "missing_user_message", "messages must contain a user message");
  }

  const stream = body.stream === true;
  const options = (body.stream_options ?? {}) as Record<string, unknown>;
  return {
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : "wb-assistant",
    messages,
    stream,
    includeUsage: options.include_usage === true,
  };
}

export function parseCompletionRequest(raw: unknown): ParsedCompletionRequest {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  let prompt = "";
  if (typeof body.prompt === "string") prompt = body.prompt;
  else if (Array.isArray(body.prompt) && body.prompt.every((p) => typeof p === "string")) {
    prompt = body.prompt.join("\n");
  } else {
    throw new ApiError(400, "invalid_prompt", "prompt must be a string or an array of strings");
  }
  if (!prompt.trim()) throw new ApiError(400, "empty_prompt", "prompt is empty");
  if (body.n !== undefined && body.n !== 1) {
    throw new ApiError(400, "unsupported_n", "Only n=1 is supported");
  }
  const options = (body.stream_options ?? {}) as Record<string, unknown>;
  return {
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : "wb-assistant",
    prompt,
    stream: body.stream === true,
    includeUsage: options.include_usage === true,
  };
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function chatChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  wb?: Record<string, unknown>,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(wb ? { wb } : {}),
  };
}

export function sse(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

interface UpstreamOutcome {
  reply: string;
  suggests: string[];
  sessionId?: string;
  scenario?: string;
  topic?: string;
  state?: string;
  requestId: string | null;
  statusNoId: string | null;
}

async function consumeUpstream(
  events: AsyncGenerator<WbStreamEvent>,
  onText?: (text: string) => void,
): Promise<UpstreamOutcome> {
  let reply = "";
  let suggests: string[] = [];
  let sessionId: string | undefined;
  let scenario: string | undefined;
  let topic: string | undefined;
  let state: string | undefined;
  let requestId: string | null = null;
  let statusNoId: string | null = null;
  for await (const ev of events) {
    if (ev.type === "start") {
      sessionId = ev.sessionId;
    } else if (ev.type === "text") {
      reply += ev.text ?? "";
      if (ev.text) onText?.(ev.text);
    } else if (ev.type === "suggests") {
      suggests = ev.suggests ?? suggests;
    } else if (ev.type === "done") {
      scenario = ev.scenario;
      topic = ev.topic;
      state = ev.state;
    } else if (ev.type === "error") {
      throw new ApiError(502, "wb_assistant_error", ev.error || "WB assistant error", "upstream_error");
    }
  }
  if (!reply.trim()) {
    throw new ApiError(502, "wb_empty_reply", "WB вернул пустой ответ", "upstream_error");
  }
  return { reply, suggests, sessionId, scenario, topic, state, requestId, statusNoId };
}

async function startUpstream(
  messages: ChatMessage[],
  model: string,
  creds: WbCredentials,
  cfg: AppConfig,
  sessions: SessionStore,
  signal: AbortSignal | undefined,
): Promise<{ plan: Plan; upstream: WbStream }> {
  const promptOptions = { mode: cfg.promptMode, maxInlineChars: cfg.maxInlineChars };
  try {
    const plan = buildPlan(messages, model, sessions, false, promptOptions);
    const upstream = await openWbStream(plan.text, plan.sessionId, creds, cfg, signal);
    return { plan, upstream };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "wb_session_expired") throw err;
    // WB forgot the session; replay the whole transcript into a fresh one.
    const plan = buildPlan(messages, model, sessions, true, promptOptions);
    const upstream = await openWbStream(plan.text, undefined, creds, cfg, signal);
    return { plan, upstream };
  }
}

function rememberSession(
  sessions: SessionStore,
  messages: ChatMessage[],
  model: string,
  outcome: UpstreamOutcome,
) {
  if (!outcome.sessionId) return;
  // Key by the transcript *after* this turn. Storing the current request key
  // would make every one-message conversation share the same empty prefix.
  sessions.set(nextConversationKey(messages, outcome.reply, model), outcome.sessionId);
}

export async function chatCompletion(
  raw: unknown,
  creds: WbCredentials,
  cfg: AppConfig,
  sessions: SessionStore,
  signal?: AbortSignal,
): Promise<Response> {
  const request = parseChatRequest(raw);
  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  let { plan, upstream } = await startUpstream(
    request.messages,
    request.model,
    creds,
    cfg,
    sessions,
    signal,
  );

  const requestId = upstream.requestId;
  const statusNoId = upstream.statusNoId;

  if (!request.stream) {
    const outcome = await consumeUpstream(upstream.events);
    outcome.requestId = requestId;
    outcome.statusNoId = statusNoId;
    rememberSession(sessions, request.messages, request.model, outcome);

    const promptTokens = estimateTokens(
      request.messages.map((m) => m.content).join("\n") + plan.text,
    );
    const completionTokens = estimateTokens(outcome.reply);
    return Response.json(
      {
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: outcome.reply },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        wb: {
          session_id: outcome.sessionId ?? null,
          suggests: outcome.suggests,
          scenario: outcome.scenario ?? null,
          topic: outcome.topic ?? null,
          state: outcome.state ?? null,
          request_id: requestId,
          status_no_id: statusNoId,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const encoder = new TextEncoder();
  let upstreamDone = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controllerClosed = false;

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      const send = (payload: unknown) => {
        if (controllerClosed) return;
        streamController.enqueue(encoder.encode(sse(payload)));
      };
      const close = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        clearInterval(heartbeat);
        try {
          streamController.close();
        } catch {
          // already closed
        }
      };
      const fail = (err: unknown) => {
        const api =
          err instanceof ApiError
            ? err
            : new ApiError(502, "wb_stream_error", String(err), "upstream_error");
        try {
          send({ error: { message: api.message, type: api.type, param: null, code: api.code } });
          send("[DONE]");
        } finally {
          close();
        }
      };

      heartbeat = setInterval(() => {
        if (controllerClosed) return;
        try {
          streamController.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // stream was closed by the client
        }
      }, 15_000);

      (async () => {
        try {
          send(
            chatChunk(id, created, request.model, {
              role: "assistant",
              content: "",
            }),
          );

          let reply = "";
          let suggests: string[] = [];
          let sessionId: string | undefined;
          let scenario: string | undefined;
          let topic: string | undefined;
          let state: string | undefined;

          for await (const ev of upstream.events) {
            if (ev.type === "start") {
              sessionId = ev.sessionId;
            } else if (ev.type === "text") {
              const text = ev.text ?? "";
              if (!text) continue;
              reply += text;
              send(chatChunk(id, created, request.model, { content: text }));
            } else if (ev.type === "suggests") {
              suggests = ev.suggests ?? suggests;
            } else if (ev.type === "done") {
              scenario = ev.scenario;
              topic = ev.topic;
              state = ev.state;
            } else if (ev.type === "error") {
              throw new ApiError(
                502,
                "wb_assistant_error",
                ev.error || "WB assistant error",
                "upstream_error",
              );
            }
          }
          upstreamDone = true;
          if (!reply.trim()) {
            throw new ApiError(502, "wb_empty_reply", "WB вернул пустой ответ", "upstream_error");
          }

          const completionTokens = estimateTokens(reply);
          if (request.includeUsage) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [],
              usage: {
                prompt_tokens: estimateTokens(plan.text),
                completion_tokens: completionTokens,
                total_tokens: estimateTokens(plan.text) + completionTokens,
              },
            });
          }
          send(
            chatChunk(id, created, request.model, {}, "stop", {
              session_id: sessionId ?? null,
              suggests,
              scenario: scenario ?? null,
              topic: topic ?? null,
              state: state ?? null,
              request_id: requestId,
              status_no_id: statusNoId,
            }),
          );
          send("[DONE]");
          close();
          rememberSession(sessions, request.messages, request.model, {
            reply,
            suggests,
            sessionId,
            scenario,
            topic,
            state,
            requestId,
            statusNoId,
          });
        } catch (err) {
          upstream.close();
          fail(err);
        }
      })();
    },
    cancel() {
      controllerClosed = true;
      clearInterval(heartbeat);
      if (!upstreamDone) upstream.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function textCompletion(
  raw: unknown,
  creds: WbCredentials,
  cfg: AppConfig,
  sessions: SessionStore,
  signal?: AbortSignal,
): Promise<Response> {
  const request = parseCompletionRequest(raw);
  const messages: ChatMessage[] = [{ role: "user", content: request.prompt }];
  const id = `cmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  let { plan, upstream } = await startUpstream(
    messages,
    request.model,
    creds,
    cfg,
    sessions,
    signal,
  );

  if (!request.stream) {
    const outcome = await consumeUpstream(upstream.events);
    rememberSession(sessions, messages, request.model, outcome);
    const promptTokens = estimateTokens(request.prompt);
    const completionTokens = estimateTokens(outcome.reply);
    return Response.json({
      id,
      object: "text_completion",
      created,
      model: request.model,
      choices: [
        { text: outcome.reply, index: 0, logprobs: null, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      wb: {
        session_id: outcome.sessionId ?? null,
        suggests: outcome.suggests,
        request_id: upstream.requestId,
        status_no_id: upstream.statusNoId,
      },
    });
  }

  const encoder = new TextEncoder();
  let controllerClosed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      const send = (payload: unknown) => {
        if (controllerClosed) return;
        streamController.enqueue(encoder.encode(sse(payload)));
      };
      const close = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        clearInterval(heartbeat);
        try {
          streamController.close();
        } catch {
          // already closed
        }
      };
      heartbeat = setInterval(() => {
        if (controllerClosed) return;
        try {
          streamController.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // ignore
        }
      }, 15_000);

      (async () => {
        try {
          let reply = "";
          let sessionId: string | undefined;
          let suggests: string[] = [];
          for await (const ev of upstream.events) {
            if (ev.type === "start") sessionId = ev.sessionId;
            else if (ev.type === "text" && ev.text) {
              reply += ev.text;
              send({
                id,
                object: "text_completion",
                created,
                model: request.model,
                choices: [
                  { text: ev.text, index: 0, logprobs: null, finish_reason: null },
                ],
              });
            } else if (ev.type === "suggests") {
              suggests = ev.suggests ?? suggests;
            } else if (ev.type === "error") {
              throw new ApiError(
                502,
                "wb_assistant_error",
                ev.error || "WB assistant error",
                "upstream_error",
              );
            }
          }
          if (!reply.trim()) {
            throw new ApiError(502, "wb_empty_reply", "WB вернул пустой ответ", "upstream_error");
          }
          if (request.includeUsage) {
            send({
              id,
              object: "text_completion",
              created,
              model: request.model,
              choices: [],
              usage: {
                prompt_tokens: estimateTokens(request.prompt),
                completion_tokens: estimateTokens(reply),
                total_tokens: estimateTokens(request.prompt) + estimateTokens(reply),
              },
            });
          }
          send({
            id,
            object: "text_completion",
            created,
            model: request.model,
            choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
            wb: { session_id: sessionId ?? null, suggests },
          });
          send("[DONE]");
          close();
          rememberSession(sessions, messages, request.model, {
            reply,
            suggests,
            sessionId,
            requestId: upstream.requestId,
            statusNoId: upstream.statusNoId,
          });
        } catch (err) {
          upstream.close();
          const api =
            err instanceof ApiError
              ? err
              : new ApiError(502, "wb_stream_error", String(err), "upstream_error");
          send({ error: { message: api.message, type: api.type, code: api.code } });
          send("[DONE]");
          close();
        }
      })();
    },
    cancel() {
      controllerClosed = true;
      clearInterval(heartbeat);
      upstream.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
