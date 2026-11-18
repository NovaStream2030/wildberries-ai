import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_MODEL = "wb-assistant";
export const DEFAULT_UPSTREAM =
  "https://ai-proxy.wildberries.ru/ai-proxy/api/chat/v5/message";

export interface WbCredentials {
  jwt: string;
  userData: string;
  cookie: string;
  userMetadata: Record<string, string>;
  updatedAt: string;
}

export interface AppConfig {
  host: string;
  port: number;
  upstreamUrl: string;
  dataFile: string;
  adminToken: string;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  sessionTtlMs: number;
  maxSessions: number;
  userAgent: string;
  promptMode: "auto" | "inline" | "last";
  maxInlineChars: number;
  allowedOrigins: string[];
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envStr(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function defaultSessionFile(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg ? resolve(xdg) : join(homedir(), ".config");
  const next = join(base, "wildberries-ai", "session.json");
  // Older versions kept credentials inside the repo. Keep reading that file
  // when it exists so upgrades do not lose the connected WB session.
  const legacy = join(import.meta.dir, "..", "data", "session.json");
  if (!existsSync(next) && existsSync(legacy)) return legacy;
  return next;
}

export function loadConfig(): AppConfig {
  return {
    host: envStr("HOST", "127.0.0.1"),
    port: envInt("PORT", 8787),
    upstreamUrl: envStr("WB_UPSTREAM_URL", DEFAULT_UPSTREAM),
    dataFile: resolve(envStr("WB_DATA_FILE", defaultSessionFile())),
    adminToken: envStr("ADMIN_TOKEN"),
    requestTimeoutMs: envInt("WB_REQUEST_TIMEOUT_MS", 120_000),
    idleTimeoutMs: envInt("WB_IDLE_TIMEOUT_MS", 90_000),
    sessionTtlMs: envInt("WB_SESSION_TTL_MS", 6 * 60 * 60 * 1000),
    maxSessions: envInt("WB_MAX_SESSIONS", 2000),
    userAgent: envStr("WB_USER_AGENT", DEFAULT_UA),
    promptMode:
      envStr("WB_PROMPT_MODE") === "inline"
        ? "inline"
        : envStr("WB_PROMPT_MODE") === "last"
          ? "last"
          : "auto",
    maxInlineChars: envInt("WB_MAX_INLINE_CHARS", 4000),
    allowedOrigins: envStr("ALLOWED_ORIGINS")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

interface FileCredentials {
  jwt?: string;
  userData?: string;
  cookie?: string;
  userMetadata?: Record<string, string>;
  updatedAt?: string;
}

function parseMetadata(raw: string | undefined, source: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      console.warn(`[config] ${source} user metadata is not an object; ignored`);
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = String(v);
      }
    }
    return out;
  } catch {
    console.warn(`[config] ${source} user metadata is not valid JSON; ignored`);
    return undefined;
  }
}

function readFileCredentials(dataFile: string): FileCredentials {
  if (!existsSync(dataFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(dataFile, "utf8")) as FileCredentials;
    if (!parsed || typeof parsed !== "object") return {};
    return {
      jwt: typeof parsed.jwt === "string" ? parsed.jwt : undefined,
      userData: typeof parsed.userData === "string" ? parsed.userData : undefined,
      cookie: typeof parsed.cookie === "string" ? parsed.cookie : undefined,
      userMetadata:
        parsed.userMetadata && typeof parsed.userMetadata === "object"
          ? parsed.userMetadata
          : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch (err) {
    console.warn(`[config] cannot read ${dataFile}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Credentials come from data/session.json and are overridden by WB_* env vars.
 * The WB assistant is gated by a logged-in WB ID: the upstream needs both a
 * bearer JWT (or cookies) and the `x-userdata` user vector.
 */
export function loadCredentials(cfg: AppConfig): WbCredentials {
  const file = readFileCredentials(cfg.dataFile);
  const jwt = envStr("WB_JWT") || file.jwt || "";
  const userData = envStr("WB_USER_DATA") || file.userData || "";
  const cookie = envStr("WB_COOKIE") || file.cookie || "";
  const envMeta = parseMetadata(process.env.WB_USER_METADATA, "env");
  const metadata = envMeta ?? file.userMetadata ?? {};
  return {
    jwt: jwt.replace(/^Bearer\s+/i, ""),
    userData,
    cookie,
    userMetadata: metadata,
    updatedAt: file.updatedAt ?? "",
  };
}

export function credentialsConfigured(creds: WbCredentials): boolean {
  return (creds.jwt.length > 0 || creds.cookie.length > 0) && creds.userData.length > 0;
}

export function publicCredentials(creds: WbCredentials) {
  return {
    configured: credentialsConfigured(creds),
    hasJwt: creds.jwt.length > 0,
    hasUserData: creds.userData.length > 0,
    hasCookie: creds.cookie.length > 0,
    hasUserMetadata: Object.keys(creds.userMetadata).length > 0,
    updatedAt: creds.updatedAt || null,
    userDataLength: creds.userData.length,
  };
}

export interface CredentialPatch {
  jwt?: string;
  userData?: string;
  cookie?: string;
  userMetadata?: Record<string, string> | null;
  clear?: boolean;
}

export function saveCredentials(cfg: AppConfig, patch: CredentialPatch): WbCredentials {
  const current = readFileCredentials(cfg.dataFile);
  if (patch.clear) {
    const cleared: FileCredentials = { updatedAt: new Date().toISOString() };
    writeFile(cfg.dataFile, cleared);
    return loadCredentials(cfg);
  }

  const next: FileCredentials = {
    jwt: patch.jwt !== undefined ? patch.jwt.replace(/^Bearer\s+/i, "").trim() : current.jwt,
    userData: patch.userData !== undefined ? patch.userData.trim() : current.userData,
    cookie: patch.cookie !== undefined ? patch.cookie.trim() : current.cookie,
    userMetadata:
      patch.userMetadata !== undefined
        ? patch.userMetadata ?? undefined
        : current.userMetadata,
    updatedAt: new Date().toISOString(),
  };
  writeFile(cfg.dataFile, next);
  return loadCredentials(cfg);
}

function writeFile(dataFile: string, value: FileCredentials) {
  mkdirSync(dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, dataFile);
  chmodSync(dataFile, 0o600);
}
