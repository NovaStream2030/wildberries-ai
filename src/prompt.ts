import { createHash } from "node:crypto";
import { ApiError } from "./errors";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptOptions {
  /** inline: embed system+history; last: send only the last user message; auto: inline when it fits. */
  mode: "auto" | "inline" | "last";
  maxInlineChars: number;
}

export const DEFAULT_PROMPT_OPTIONS: PromptOptions = { mode: "auto", maxInlineChars: 4000 };

export interface Plan {
  /** Message text sent to the WB assistant. */
  text: string;
  /** Stable key for the *current* turn: everything before the last user message. */
  conversationKey: string;
  /** WB session id when this conversation continues an earlier WB session. */
  sessionId?: string;
  /** True when the full transcript had to be embedded into a fresh session. */
  fresh: boolean;
}

const TRANSCRIPT_LIMIT = 24_000;

export class SessionStore {
  private readonly entries = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): string | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.sessionId;
  }

  set(key: string, sessionId: string): void {
    if (!key || !sessionId) return;
    this.entries.delete(key);
    this.entries.set(key, { sessionId, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function conversationKey(messages: ChatMessage[], model: string): string {
  const normalized = messages
    .map((m) => `${m.role}\u0000${m.content}`)
    .join("\u0001");
  return createHash("sha256").update(`${model}\u0002${normalized}`).digest("hex");
}

export function nextConversationKey(
  messages: ChatMessage[],
  assistantReply: string,
  model: string,
): string {
  return conversationKey([...messages, { role: "assistant", content: assistantReply }], model);
}

function collectSystem(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === "system" && m.content.trim())
    .map((m) => m.content.trim());
}

function renderTranscript(messages: ChatMessage[], system: string[]): string {
  const lines: string[] = [];
  if (system.length > 0) {
    lines.push(
      "Дополнительные инструкции пользователя (следуй им, если они не противоречат правилам Wildberries):",
      system.join("\n\n"),
      "",
    );
  }

  const dialogue = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim(),
  );
  if (dialogue.length > 0) {
    lines.push("История диалога:");
    for (const m of dialogue) {
      lines.push(`${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.content.trim()}`);
    }
    lines.push("");
  }

  let text = lines.join("\n").trim();
  if (text.length > TRANSCRIPT_LIMIT) {
    text = `${text.slice(0, 4000)}\n\n[…часть истории опущена…]\n\n${text.slice(-TRANSCRIPT_LIMIT + 4000)}`;
  }
  return text;
}

function lastUserMessage(messages: ChatMessage[]): { index: number; content: string } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return { index: i, content: messages[i].content.trim() };
    }
  }
  throw new ApiError(
    400,
    "missing_user_message",
    "The request must contain at least one message with role \"user\"",
  );
}

/**
 * WB keeps conversation state server-side per `session_id`, while OpenAI clients
 * resend the whole transcript. We key a WB session by the transcript prefix.
 * On a cache miss the transcript and system prompts are embedded into one text
 * field, because the upstream accepts a single `text`, not a message array.
 */
export function buildPlan(
  messages: ChatMessage[],
  model: string,
  sessions: SessionStore,
  forceFresh = false,
  options: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): Plan {
  const last = lastUserMessage(messages);
  if (!last.content) {
    throw new ApiError(400, "empty_user_message", "The last user message is empty");
  }

  const prior = messages.slice(0, last.index);
  const key = conversationKey(prior, model);
  const sessionId = forceFresh ? undefined : sessions.get(key);
  if (sessionId) {
    return { text: last.content, conversationKey: key, sessionId, fresh: false };
  }

  const system = collectSystem(messages);
  const transcript = renderTranscript(prior, system);
  const full = transcript ? `${transcript}\n\nПользователь: ${last.content}` : last.content;
  // OMP and other coding clients prepend huge system prompts; WB treats those
  // as off-topic and may refuse. "auto" keeps short instructions, drops a
  // transcript that would dominate the request.
  const inline = options.mode === "inline" || (options.mode === "auto" && full.length <= options.maxInlineChars);
  return { text: inline ? full : last.content, conversationKey: key, fresh: true };
}
