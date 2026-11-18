import { beforeEach, describe, expect, test } from "bun:test";
import { buildPlan, conversationKey, nextConversationKey, SessionStore } from "../src/prompt";
import type { ChatMessage } from "../src/prompt";

const model = "wb-assistant";
let sessions: SessionStore;

beforeEach(() => {
  sessions = new SessionStore(60_000, 10);
});

describe("buildPlan", () => {
  test("first turn sends only the user text", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "привет" }];
    const plan = buildPlan(messages, model, sessions);
    expect(plan.text).toBe("привет");
    expect(plan.sessionId).toBeUndefined();
    expect(plan.fresh).toBe(true);
    expect(plan.conversationKey).toBe(conversationKey([], model));
  });

  test("embeds system prompt and prior turns into a fresh session", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Отвечай кратко." },
      { role: "user", content: "найди кружку" },
      { role: "assistant", content: "Вот кружка." },
      { role: "user", content: "а подешевле?" },
    ];
    const plan = buildPlan(messages, model, sessions);
    expect(plan.text).toContain("Дополнительные инструкции пользователя");
    expect(plan.text).toContain("Отвечай кратко.");
    expect(plan.text).toContain("Пользователь: найди кружку");
    expect(plan.text).toContain("Ассистент: Вот кружка.");
    expect(plan.text.trimEnd().endsWith("Пользователь: а подешевле?")).toBe(true);
    expect(plan.sessionId).toBeUndefined();
  });

  test("reuses a WB session for the same transcript prefix", () => {
    const first: ChatMessage[] = [{ role: "user", content: "привет" }];
    const firstPlan = buildPlan(first, model, sessions);
    sessions.set(firstPlan.conversationKey, "wb-session-1");

    const plan = buildPlan(first, model, sessions);
    expect(plan.sessionId).toBe("wb-session-1");
    expect(plan.text).toBe("привет");
    expect(plan.fresh).toBe(false);
  });

  test("stores the session under the next transcript key", () => {
    const prior: ChatMessage[] = [
      { role: "user", content: "привет" },
      { role: "assistant", content: "здравствуйте" },
    ];
    expect(nextConversationKey(prior, "как дела?", model)).toBe(
      conversationKey([...prior, { role: "assistant", content: "как дела?" }], model),
    );

    sessions.set(conversationKey(prior, model), "wb-session-2");
    const plan = buildPlan([...prior, { role: "user", content: "как дела?" }], model, sessions);
    expect(plan.sessionId).toBe("wb-session-2");
  });

  test("auto mode drops a huge coding system prompt", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "x".repeat(5000) },
      { role: "user", content: "найди кружку" },
    ];
    const plan = buildPlan(messages, model, sessions, false, {
      mode: "auto",
      maxInlineChars: 4000,
    });
    expect(plan.text).toBe("найди кружку");
  });

  test("auto mode keeps a short system prompt", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Отвечай кратко." },
      { role: "user", content: "найди кружку" },
    ];
    const plan = buildPlan(messages, model, sessions, false, {
      mode: "auto",
      maxInlineChars: 4000,
    });
    expect(plan.text).toContain("Отвечай кратко.");
    expect(plan.text).toContain("Пользователь: найди кружку");
  });

  test("last mode never sends system or history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Отвечай кратко." },
      { role: "user", content: "старое" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "новое" },
    ];
    const plan = buildPlan(messages, model, sessions, false, { mode: "last", maxInlineChars: 4000 });
    expect(plan.text).toBe("новое");
  });

  test("forceFresh ignores a cached session", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "привет" }];
    sessions.set(conversationKey([], model), "wb-session-3");
    const plan = buildPlan(messages, model, sessions, true);
    expect(plan.sessionId).toBeUndefined();
    expect(plan.fresh).toBe(true);
  });

  test("rejects a request without a user message", () => {
    expect(() =>
      buildPlan([{ role: "system", content: "only system" }], model, sessions),
    ).toThrow("at least one message");
  });

  test("rejects an empty last user message", () => {
    expect(() =>
      buildPlan(
        [
          { role: "user", content: "old" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "   " },
        ],
        model,
        sessions,
      ),
    ).toThrow("last user message is empty");
  });
});

describe("SessionStore", () => {
  test("expires entries and evicts the oldest", () => {
    const store = new SessionStore(10, 2);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(store.size).toBe(2);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBe("3");
  });
});
