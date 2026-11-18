const LS_CHATS = "wbai.chats.v1";
const LS_PROMPT = "wbai.systemPrompt.v1";
const SS_ADMIN = "wbai.adminToken";
const MAX_CHATS = 30;

const $ = (id) => document.getElementById(id);

const els = {
  sidebar: $("sidebar"),
  chatList: $("chatList"),
  newChat: $("newChat"),
  menuBtn: $("menuBtn"),
  openSettings: $("openSettings"),
  chatTitle: $("chatTitle"),
  status: $("status"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  messages: $("messages"),
  composer: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  settings: $("settings"),
  settingsForm: $("settingsForm"),
  closeSettings: $("closeSettings"),
  settingsStatus: $("settingsStatus"),
  jwt: $("jwt"),
  adminToken: $("adminToken"),
  userData: $("userData"),
  cookie: $("cookie"),
  userMetadata: $("userMetadata"),
  systemPrompt: $("systemPrompt"),
  saveSettings: $("saveSettings"),
  testSettings: $("testSettings"),
  clearSettings: $("clearSettings"),
  testResult: $("testResult"),
  captureSnippet: $("captureSnippet"),
  copySnippet: $("copySnippet"),
  toast: $("toast"),
};

const state = {
  config: null,
  chats: loadChats(),
  activeId: null,
  streaming: null,
  systemPrompt: localStorage.getItem(LS_PROMPT) || "",
};

const EXAMPLES = [
  { text: "Найди подарок до 2000 ₽", hint: "подборка товаров" },
  { text: "Что сейчас в тренде?", hint: "тренды маркетплейса" },
  { text: "Помоги выбрать кроссовки для бега", hint: "консультация" },
  { text: "Расскажи о себе", hint: "возможности ассистента" },
];

function loadChats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_CHATS) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      .slice(0, MAX_CHATS);
  } catch {
    return [];
  }
}

function saveChats() {
  localStorage.setItem(LS_CHATS, JSON.stringify(state.chats.slice(0, MAX_CHATS)));
}

function newChatObject() {
  return {
    id: crypto.randomUUID(),
    title: "Новый чат",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

function activeChat() {
  let chat = state.chats.find((c) => c.id === state.activeId);
  if (!chat) {
    chat = newChatObject();
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }
  return chat;
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem(SS_ADMIN);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

function showToast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast show ${kind}`.trim();
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.className = "toast";
  }, 4200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineFormat(escaped) {
  const links = [];
  let text = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => {
      const i = links.push(`<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`) - 1;
      return `\u0000L${i}\u0000`;
    },
  );
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, lead, url) => {
      const i = links.push(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`) - 1;
      return `${lead}\u0000L${i}\u0000`;
    },
  );
  text = text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\s][^_\n]*)_/g, "$1<em>$2</em>");
  return text.replace(/\u0000L(\d+)\u0000/g, (_m, i) => links[Number(i)] || "");
}

function renderMarkdown(source) {
  const codeBlocks = [];
  let text = String(source).replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.push(
      `<pre><code${lang ? ` data-lang="${escapeHtml(lang.trim())}"` : ""}>${escapeHtml(code)}</code></pre>`,
    ) - 1;
    return `\n\u0000C${i}\u0000\n`;
  });

  text = escapeHtml(text);
  const lines = text.split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineFormat(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineFormat(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const code = line.match(/^\u0000C(\d+)\u0000$/);
    if (code) {
      flushParagraph();
      flushList();
      out.push(codeBlocks[Number(code[1])] || "");
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    if (list) flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join("");
}

function setStatus(kind, text, title = "") {
  els.statusDot.className = `dot ${kind}`.trim();
  els.statusText.textContent = text;
  els.status.title = title || text;
}

async function refreshConfig() {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
    if (state.config.configured) {
      setStatus("ok", "WB подключена", `JWT: ${state.config.hasJwt ? "да" : "нет"}, x-userdata: ${state.config.hasUserData ? "да" : "нет"}`);
    } else {
      setStatus("bad", "WB не подключена", "Откройте «Настройки WB» и добавьте сессию");
    }
  } catch (err) {
    state.config = null;
    setStatus("bad", "сервер недоступен", String(err));
  }
  renderMessages();
}

function renderChatList() {
  const chats = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  els.chatList.replaceChildren();
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === state.activeId ? " active" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "chat-select";
    select.textContent = chat.title || "Новый чат";
    select.title = chat.title || "Новый чат";
    select.addEventListener("click", () => {
      if (state.streaming) return showToast("Дождитесь ответа или нажмите «Стоп»");
      state.activeId = chat.id;
      renderChatList();
      renderMessages();
      els.sidebar.classList.remove("open");
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-delete";
    del.textContent = "✕";
    del.title = "Удалить чат";
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.streaming && state.streaming.chatId === chat.id) return showToast("Дождитесь ответа");
      state.chats = state.chats.filter((c) => c.id !== chat.id);
      if (state.activeId === chat.id) {
        state.activeId = state.chats[0]?.id || null;
      }
      saveChats();
      renderChatList();
      renderMessages();
    });
    item.append(select, del);
    els.chatList.append(item);
  }
}

function messageNode(message, index) {
  const wrap = document.createElement("article");
  wrap.className = `msg ${message.role}${message.error ? " error" : ""}`;
  wrap.dataset.index = String(index);

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = message.role === "user" ? "Вы" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const content = document.createElement("div");
  content.className = "text";
  if (message.role === "assistant") {
    content.innerHTML = message.content ? renderMarkdown(message.content) : "";
    if (state.streaming?.assistant === message) content.classList.add("typing");
  } else {
    content.textContent = message.content;
    content.style.whiteSpace = "pre-wrap";
  }
  bubble.append(content);

  if (message.suggests?.length) {
    const suggests = document.createElement("div");
    suggests.className = "suggests";
    for (const suggestion of message.suggests) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "suggest";
      chip.textContent = suggestion;
      chip.addEventListener("click", () => {
        if (state.streaming) return;
        sendMessage(suggestion);
      });
      suggests.append(chip);
    }
    bubble.append(suggests);
  }

  wrap.append(avatar, bubble);
  return wrap;
}

function setupBanner() {
  const banner = document.createElement("div");
  banner.className = "setup-banner";
  const p = document.createElement("p");
  p.innerHTML =
    "<strong>Нужна сессия WB.</strong> ИИ-ассистент Wildberries доступен только авторизованным пользователям. " +
    "Добавьте JWT и x-userdata из браузера, где открыт wildberries.ru.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = "Подключить";
  btn.addEventListener("click", openSettings);
  banner.append(p, btn);
  return banner;
}

function emptyState() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.innerHTML = `
    <div class="empty-mark">WB</div>
    <h1>Чем помочь?</h1>
    <p>Тот же ИИ-ассистент Wildberries, но через OpenAI-совместимый API. Спросите про товары, тренды или доставку.</p>
  `;
  const prompts = document.createElement("div");
  prompts.className = "prompts";
  for (const example of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prompt";
    button.innerHTML = `${escapeHtml(example.text)}<small>${escapeHtml(example.hint)}</small>`;
    button.addEventListener("click", () => {
      if (state.streaming) return;
      sendMessage(example.text);
    });
    prompts.append(button);
  }
  empty.append(prompts);
  return empty;
}

function renderMessages(keepScroll = false) {
  const chat = activeChat();
  const nearBottom =
    els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140;
  els.chatTitle.textContent = chat.title || "Новый чат";
  els.messages.replaceChildren();

  if (!state.config?.configured) els.messages.append(setupBanner());

  if (!chat.messages.length) {
    els.messages.append(emptyState());
  } else {
    chat.messages.forEach((message, index) => {
      const node = messageNode(message, index);
      if (state.streaming && state.streaming.pendingIndex === index) node.dataset.pending = "1";
      els.messages.append(node);
    });
  }

  if (!keepScroll && nearBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

function updatePendingText() {
  const node = els.messages.querySelector('[data-pending="1"] .text');
  if (!node) return;
  const chat = activeChat();
  const message = chat.messages.find((m) => m === state.streaming?.assistant);
  node.textContent = message?.content || "";
  const nearBottom =
    els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 180;
  if (nearBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(busy) {
  els.send.disabled = busy;
  els.stop.classList.toggle("hidden", !busy);
  els.send.classList.toggle("hidden", busy);
  els.input.placeholder = busy ? "Ассистент печатает…" : "Спросите что-нибудь у WB AI…";
}

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(180, els.input.scrollHeight)}px`;
}

async function readSse(response, assistant) {
  if (!response.body) throw new Error("Сервер не вернул поток");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const handleBlock = (block) => {
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
    }
    const payload = data.trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) throw new Error(json.error.message || "Ошибка WB");
    const choice = json.choices?.[0];
    if (choice?.delta?.content) {
      assistant.content += choice.delta.content;
      updatePendingText();
    }
    if (json.wb?.suggests?.length) assistant.suggests = json.wb.suggests;
    if (json.wb?.session_id) assistant.sessionId = json.wb.session_id;
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleBlock(block);
      if (finished) break;
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) handleBlock(buffer);
}

async function sendMessage(rawText) {
  const text = String(rawText ?? els.input.value).trim();
  if (!text || state.streaming) return;

  const chat = activeChat();
  if (!chat.messages.length) chat.title = text.slice(0, 46) + (text.length > 46 ? "…" : "");
  chat.messages.push({ role: "user", content: text });
  chat.updatedAt = Date.now();
  const assistant = { role: "assistant", content: "", suggests: [] };
  chat.messages.push(assistant);
  const pendingIndex = chat.messages.length - 1;

  els.input.value = "";
  autoResize();
  const controller = new AbortController();
  state.streaming = { controller, chatId: chat.id, assistant, pendingIndex };
  saveChats();
  renderChatList();
  renderMessages();

  const apiMessages = [];
  if (state.systemPrompt.trim()) {
    apiMessages.push({ role: "system", content: state.systemPrompt.trim() });
  }
  for (const message of chat.messages) {
    if (message === assistant) continue;
    if ((message.role === "user" || message.role === "assistant") && message.content) {
      apiMessages.push({ role: message.role, content: message.content });
    }
  }

  setBusy(true);

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "wb-assistant", messages: apiMessages, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message || `HTTP ${response.status}`);
    }
    await readSse(response, assistant);
    if (!assistant.content.trim()) {
      throw new Error("WB вернул пустой ответ");
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      assistant.content += assistant.content ? "\n\n_[остановлено]_" : "_[остановлено]_";
    } else {
      assistant.error = true;
      assistant.content = assistant.content || `Не удалось получить ответ: ${err.message}`;
      showToast(err.message, "error");
    }
  } finally {
    state.streaming = null;
    setBusy(false);
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
    els.input.focus();
  }
}

function openSettings() {
  els.settingsStatus.className = "callout";
  const adminNote = state.config?.adminTokenRequired ? " · требуется admin token" : "";
  els.settingsStatus.textContent = state.config?.configured
    ? `Сессия подключена${state.config.hasJwt ? " · JWT" : ""}${state.config.hasUserData ? " · x-userdata" : ""}${state.config.hasCookie ? " · cookie" : ""}${adminNote}`
    : `Сессия WB не подключена.${adminNote}`;
  if (state.config?.configured) els.settingsStatus.classList.add("ok");
  els.jwt.value = "";
  els.adminToken.value = sessionStorage.getItem(SS_ADMIN) || "";
  els.userData.value = "";
  els.cookie.value = "";
  els.userMetadata.value = "";
  els.systemPrompt.value = state.systemPrompt;
  els.testResult.className = "test-result";
  els.testResult.textContent = "";
  els.captureSnippet.textContent = captureSnippet();
  els.settings.showModal();
}

function captureSnippet() {
  return `(() => {
  if (window.__wbaiHooked) return console.log("Хук уже установлен");
  window.__wbaiHooked = true;
  const orig = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (url && url.includes("/ai-proxy/api/chat/v5/message")) {
        const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        let body = null;
        try { body = init?.body ? JSON.parse(init.body) : null; } catch {}
        const out = {
          jwt: (h.get("authorization") || "").replace(/^Bearer\\s+/i, ""),
          userData: h.get("x-userdata") || body?.user_metadata?.uv || "",
          userMetadata: body?.user_metadata || undefined
        };
        console.log("[WB AI] capture", out);
        try { copy(JSON.stringify(out, null, 2)); console.log("Скопировано в буфер обмена"); } catch {}
        window.fetch = orig;
        window.__wbaiHooked = false;
      }
    } catch (e) { console.warn(e); }
    return orig.apply(this, arguments);
  };
  console.log("[WB AI] Откройте ИИ-ассистента и отправьте любое сообщение.");
})();`;
}

async function saveSettings() {
  const patch = {};
  const jwt = els.jwt.value.trim();
  const userData = els.userData.value.trim();
  const cookie = els.cookie.value.trim();
  if (jwt) patch.jwt = jwt;
  if (userData) patch.userData = userData;
  if (cookie) patch.cookie = cookie;
  if (els.userMetadata.value.trim()) {
    try {
      patch.userMetadata = JSON.parse(els.userMetadata.value);
    } catch {
      showToast("user_metadata — невалидный JSON", "error");
      return;
    }
  }
  state.systemPrompt = els.systemPrompt.value;
  localStorage.setItem(LS_PROMPT, state.systemPrompt);
  if (els.adminToken.value.trim()) {
    sessionStorage.setItem(SS_ADMIN, els.adminToken.value.trim());
  } else {
    sessionStorage.removeItem(SS_ADMIN);
  }

  if (!Object.keys(patch).length) {
    showToast("Системный промпт сохранён");
    renderMessages();
    return;
  }

  els.saveSettings.disabled = true;
  try {
    const res = await apiFetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    await refreshConfig();
    els.settingsStatus.className = "callout ok";
    els.settingsStatus.textContent = "Сохранено. Нажмите «Проверить», чтобы сделать тестовый запрос.";
    els.jwt.value = "";
    showToast("Настройки сохранены");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    els.saveSettings.disabled = false;
  }
}

async function testSettings() {
  els.testSettings.disabled = true;
  els.testResult.className = "test-result show";
  els.testResult.textContent = "Проверяем WB…";
  try {
    const res = await apiFetch("/api/config/test", { method: "POST" });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    els.testResult.className = "test-result show ok";
    els.testResult.textContent = `WB ответил:\n${body.text}`;
  } catch (err) {
    els.testResult.className = "test-result show bad";
    els.testResult.textContent = `Ошибка: ${err.message}`;
  } finally {
    els.testSettings.disabled = false;
  }
}

async function clearSettings() {
  if (!confirm("Удалить сохранённые JWT, x-userdata и cookie?")) return;
  try {
    const res = await apiFetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || `HTTP ${res.status}`);
    }
    await refreshConfig();
    els.settingsStatus.className = "callout bad";
    els.settingsStatus.textContent = "Данные удалены.";
    showToast("Сессионные данные удалены");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function bindEvents() {
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });

  els.input.addEventListener("input", autoResize);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  els.stop.addEventListener("click", () => {
    state.streaming?.controller.abort();
  });

  els.newChat.addEventListener("click", () => {
    if (state.streaming) return showToast("Дождитесь ответа или нажмите «Стоп»");
    const chat = newChatObject();
    state.chats.unshift(chat);
    state.activeId = chat.id;
    saveChats();
    renderChatList();
    renderMessages();
    els.sidebar.classList.remove("open");
    els.input.focus();
  });

  els.openSettings.addEventListener("click", openSettings);
  els.menuBtn.addEventListener("click", () => els.sidebar.classList.toggle("open"));
  els.closeSettings.addEventListener("click", (event) => {
    event.preventDefault();
    els.settings.close();
  });
  els.settingsForm.addEventListener("submit", (event) => {
    if (event.submitter !== els.closeSettings) event.preventDefault();
  });
  els.saveSettings.addEventListener("click", saveSettings);
  els.testSettings.addEventListener("click", testSettings);
  els.clearSettings.addEventListener("click", clearSettings);
  els.copySnippet.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.captureSnippet.textContent);
      showToast("Сниппет скопирован");
    } catch {
      showToast("Не удалось скопировать. Выделите текст вручную.", "error");
    }
  });

  document.addEventListener("click", (event) => {
    if (window.innerWidth > 760) return;
    if (!els.sidebar.classList.contains("open")) return;
    if (els.sidebar.contains(event.target) || els.menuBtn.contains(event.target)) return;
    els.sidebar.classList.remove("open");
  });
}

function init() {
  if (!state.chats.length) {
    const chat = newChatObject();
    state.chats.push(chat);
    state.activeId = chat.id;
  } else {
    state.activeId = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }
  state.systemPrompt = localStorage.getItem(LS_PROMPT) || "";
  bindEvents();
  renderChatList();
  renderMessages();
  autoResize();
  refreshConfig();
  els.input.focus();
}

init();
