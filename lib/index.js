/**
 * Google Antigravity / Cloud Code Assist adapter for DeepSeek Harness.
 *
 * This plugin is intentionally shaped like a DSH Web plugin: Cordis loads this
 * module, `apply()` registers a harness LlmAdapter, and OAuth credentials live
 * under DSH home. It does not require an external Antigravity CLI.
 */
import { createHash, randomBytes } from "node:crypto";
import { LocalAccountPool } from "./account-pool.js";
import { AccountScheduler } from "./account-scheduler.js";
import { writeAntigravityFailure } from "./diagnostics.js";
import { buildPoolAvailability } from "./pool-health.js";
import { RuntimeStatus, describeRuntimeFailure } from "./runtime-status.js";
import { createServer } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId as CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

export const PROVIDER = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const name = "dsh-antigravity";
export const inject = ["llm"];

const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const QUOTA_COOLDOWN_MS = 30000;
const DISCOVERY_TIMEOUT_MS = 8000;
const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://cloudcode-pa.googleapis.com",
];

const REDIRECT_PATH = "/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const DEFAULT_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.';

const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
const GEMINI_ROLE = {
  user: "user",
  model: "model",
};
const TOOL_CALLING_MODE = {
  none: "NONE",
  any: "ANY",
  auto: "AUTO",
  validated: "VALIDATED",
};

const ROUTING = {
  "claude-opus-4-6": {
    off: "claude-opus-4-6-thinking",
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
      xhigh: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6-thinking",
    routing: {
      minimal: "claude-sonnet-4-6-thinking",
      low: "claude-sonnet-4-6-thinking",
      medium: "claude-sonnet-4-6-thinking",
      high: "claude-sonnet-4-6-thinking",
      xhigh: "claude-sonnet-4-6-thinking",
    },
    defaultRequestId: "claude-sonnet-4-6-thinking",
  },
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-tiered",
    routing: {
      minimal: "gemini-3.8-flash-tiered",
      low: "gemini-3.8-flash-tiered",
      medium: "gemini-3.8-flash-tiered",
      high: "gemini-3.8-flash-tiered",
      xhigh: "gemini-3.8-flash-tiered",
    },
    defaultRequestId: "gemini-3.8-flash-tiered",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-tiered",
    routing: {
      minimal: "gemini-3.7-flash-tiered",
      low: "gemini-3.7-flash-tiered",
      medium: "gemini-3.7-flash-tiered",
      high: "gemini-3.7-flash-tiered",
      xhigh: "gemini-3.7-flash-tiered",
    },
    defaultRequestId: "gemini-3.7-flash-tiered",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-high",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-pro-agent",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-pro-agent",
  },
  "gemini-3.1-flash-image": {
    off: "gemini-3.1-flash-image",
    routing: {
      minimal: "gemini-3.1-flash-image",
      low: "gemini-3.1-flash-image",
      medium: "gemini-3.1-flash-image",
      high: "gemini-3.1-flash-image",
      xhigh: "gemini-3.1-flash-image",
    },
    defaultRequestId: "gemini-3.1-flash-image",
  },
  "gemini-3-flash": {
    off: "gemini-3-flash",
    routing: {
      minimal: "gemini-3-flash",
      low: "gemini-3-flash",
      medium: "gemini-3-flash",
      high: "gemini-3-flash",
      xhigh: "gemini-3-flash",
    },
    defaultRequestId: "gemini-3-flash",
  },
  "gemini-2.5-pro": {
    off: "gemini-2.5-pro",
    routing: {
      minimal: "gemini-2.5-pro",
      low: "gemini-2.5-pro",
      medium: "gemini-2.5-pro",
      high: "gemini-2.5-pro",
      xhigh: "gemini-2.5-pro",
    },
    defaultRequestId: "gemini-2.5-pro",
  },
  "gemini-2.5-flash": {
    off: "gemini-2.5-flash",
    routing: {
      minimal: "gemini-2.5-flash",
      low: "gemini-2.5-flash",
      medium: "gemini-2.5-flash",
      high: "gemini-2.5-flash",
      xhigh: "gemini-2.5-flash",
    },
    defaultRequestId: "gemini-2.5-flash",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
      xhigh: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

const RUNTIME_MAX_OUTPUT_TOKENS = {
  "gemini-3.8-flash": 65536,
  "gemini-3.8-flash-tiered": 65536,
  "gemini-3.8-flash-low": 65536,
  "gemini-3.8-flash-medium": 65536,
  "gemini-3.8-flash-high": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};

const MODELS = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["off", "low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    inputModalities: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ["medium"],
  },
];

const diagnostics = {
  endpoint: "",
  status: undefined,
  projectId: "",
  resolvedRuntimeModel: "",
  availableModels: "",
  matchedModelDebug: "",
  error: "",
  errorPhase: "",
  errorKind: "",
  errorCode: "",
  errorAt: 0,
};

const projectCache = new Map();
const modelCache = new Map();
const inFlightModelLookups = new Map();
const accountQuotas = new Map();
// Account-scoped flag only; never retain unsanitized errors or credentials for routing.
const accountQuotaErrors = new Set();
const quotaEpochs = new Map();
let activeQuotaAccountId = "legacy";
let webLoginFlow = undefined;

function invalidateAccountQuota(id = activeQuotaAccountId) {
  accountQuotas.delete(id);
  accountQuotaErrors.delete(id);
  quotaEpochs.set(id, (quotaEpochs.get(id) || 0) + 1);
}

let toolCallCounter = 0;

export function credentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "antigravity-settings.json");
}

const DEFAULT_ENABLED_MODEL_IDS = MODELS.map((model) => model.id);

function antigravityEnv(namePart) {
  return process.env[`ANTIGRAVITY_${namePart}`] || process.env[`NOAGY_${namePart}`];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeText(text) {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nowRequestId() {
  return `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  // Keep only allowlisted structural fields from causes (never headers, request bodies or tokens).
  const codes = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 3) return;
    for (const key of ["code", "syscall"]) {
      if (typeof value[key] === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(value[key])) codes.add(`${key}=${value[key]}`);
    }
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const nested of value.errors.slice(0, 4)) visit(nested, depth + 1);
  };
  visit(error);
  return redactSecrets(`${raw}${codes.size ? ` [${[...codes].join(", ")}]` : ""}`).slice(0, 1200);
}

function setLastEndpoint(endpoint) {
  diagnostics.endpoint = endpoint || "";
}

function setLastStatus(status) {
  diagnostics.status = status;
}

function setLastProjectId(projectId) {
  diagnostics.projectId = projectId || "";
}

function setLastResolvedRuntimeModel(modelId) {
  diagnostics.resolvedRuntimeModel = modelId || "";
}

function setLastAvailableModels(text) {
  diagnostics.availableModels = text || "";
}

function setLastMatchedModelDebug(text) {
  diagnostics.matchedModelDebug = text || "";
}

// Structural failure metadata only: phase, classifier kind and error code. Never messages or causes.
function recordFailureMetadata(error, phase) {
  const detail = describeRuntimeFailure(error, phase, false);
  diagnostics.errorPhase = phase || detail.phase || "";
  diagnostics.errorKind = detail.kind;
  diagnostics.errorCode = detail.code || (typeof error?.code === "string" ? error.code : "");
  diagnostics.errorAt = Date.now();
}

function setLastError(error, phase) {
  if (error !== undefined && error !== null) recordFailureMetadata(error, phase);
  diagnostics.error = safeError(error || "");
}

export function getAntigravityDiagnostics() {
  return { ...diagnostics };
}

function assertSafeApiBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" ||
    host.endsWith(".googleapis.com") ||
    host.endsWith(".sandbox.googleapis.com");
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function endpointCandidates() {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")) {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

function callbackPort() {
  const raw = antigravityEnv("CALLBACK_PORT");
  if (!raw) return 51121;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ANTIGRAVITY_CALLBACK_PORT: ${raw}`);
  }
  return parsed;
}

function redirectUri() {
  return `http://localhost:${callbackPort()}${REDIRECT_PATH}`;
}

function clientId() {
  return antigravityEnv("CLIENT_ID") || DEFAULT_CLIENT_ID;
}

function clientSecret() {
  return antigravityEnv("CLIENT_SECRET") || DEFAULT_CLIENT_SECRET;
}

function defaultUserAgent() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/1.15.8 ${os}/${arch}`;
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: PLATFORM,
      pluginType: "GEMINI",
    }),
  };
}

function attributionHeaderBag() {
  try {
    return attributionHeaders() || {};
  } catch {
    return {};
  }
}

function jsonOrTextError(text) {
  const parsed = safeJsonParse(text);
  if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  return text;
}

function jsonHeaders(token) {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

function extractProjectId(data) {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token) {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      return extractProjectId(await response.json());
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssistUncached(token) {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      const project = extractProjectId(await response.json());
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssist(token) {
  const cached = projectCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    projectCache.delete(token);
    projectCache.set(token, cached);
    return cached.projectId;
  }
  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

function resolveProjectId(options) {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    options.warmedProject ||
    options.credentialProjectId ||
    defaultProjectId(options.email || "antigravity-default")
  );
}

function collectModelLabels(value, out = []) {
  if (!value || out.length > 50) return out;
  if (typeof value === "string") {
    if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelLabels(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) {
      collectModelLabels(value[key], out);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") collectModelLabels(nested, out);
    }
  }
  return out;
}

function summarizeModelCandidate(value) {
  if (!isRecord(value)) return String(value ?? "none");
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
  }
  return JSON.stringify(out).slice(0, 1200);
}

function isUsableRuntimeModelId(id) {
  return /^(gemini-|claude-|gpt-oss-)/i.test(id) && !/\s/.test(id) && !/^MODEL_/i.test(id);
}

function buildModelMatchRegex(requestedId) {
  const requested = requestedId.toLowerCase();
  if (requested === "gemini-3.8-flash-low") return /gemini[- ]3\.8[- ]flash \(low\)/i;
  if (requested === "gemini-3.8-flash-medium") return /gemini[- ]3\.8[- ]flash \(medium\)/i;
  if (requested === "gemini-3.8-flash-high") return /gemini[- ]3\.8[- ]flash \(high\)/i;
  if (requested === "gemini-3.7-flash-low") return /gemini[- ]3\.7[- ]flash \(low\)/i;
  if (requested === "gemini-3.7-flash-medium") return /gemini[- ]3\.7[- ]flash \(medium\)/i;
  if (requested === "gemini-3.7-flash-high") return /gemini[- ]3\.7[- ]flash \(high\)/i;
  if (requested === "gemini-3.6-flash-low") return /gemini[- ]3\.6[- ]flash \(low\)/i;
  if (requested === "gemini-3.6-flash-medium") return /gemini[- ]3\.6[- ]flash \(medium\)/i;
  if (requested === "gemini-3.6-flash-high") return /gemini[- ]3\.6[- ]flash \(high\)/i;
  if (requested === "gemini-3.5-flash-extra-low") return /gemini[- ]3\.5[- ]flash \(low\)/i;
  if (requested === "gemini-3.5-flash-low" || requested === "gemini-3.5-flash-medium") {
    return /gemini[- ]3\.5[- ]flash \(medium\)/i;
  }
  if (requested === "gemini-3.5-flash-high" || requested === "gemini-3-flash-agent") {
    return /gemini[- ]3\.5[- ]flash \(high\)/i;
  }
  if (requested.includes("claude-opus-4-6")) return /claude.*opus.*4\.6/i;
  if (requested.includes("claude-sonnet-4-6")) return /claude.*sonnet.*4\.6/i;
  if (requested.includes("gpt-oss-120b")) return /gpt.*oss.*120b/i;
  if (requested === "gemini-3.1-pro-low") return /gemini[- ]3\.1[- ]pro \(low\)/i;
  if (requested === "gemini-3.1-pro-high" || requested === "gemini-pro-agent") {
    return /gemini[- ]3\.1[- ]pro \(high\)/i;
  }
  const escaped = escapeRegExp(requested).replace(/\\-/g, "[- ]");
  return new RegExp(escaped, "i");
}

function dynamicModelFromInfo(modelId, info) {
  if (!isRecord(info)) return { id: modelId };
  setLastMatchedModelDebug(summarizeModelCandidate({ modelId, ...info }));
  const experiments = Array.isArray(info.modelExperiments)
    ? info.modelExperiments.filter((item) => typeof item === "string")
    : undefined;
  return {
    id: modelId,
    experiments,
    apiProvider: asString(info.apiProvider),
    modelProvider: asString(info.modelProvider),
  };
}

function findDynamicModel(value, requestedId) {
  if (!value) return undefined;
  if (isRecord(value) && isRecord(value.models)) {
    const modelsMap = value.models;
    if (isUsableRuntimeModelId(requestedId) && requestedId in modelsMap) {
      return dynamicModelFromInfo(requestedId, modelsMap[requestedId]);
    }
    const targetRegex = buildModelMatchRegex(requestedId);
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (!isUsableRuntimeModelId(modelId)) continue;
      if (targetRegex.test(modelId)) return dynamicModelFromInfo(modelId, info);
      if (isRecord(info)) {
        const label = info.label ?? info.displayName ?? info.name;
        if (typeof label === "string" && targetRegex.test(label)) {
          return dynamicModelFromInfo(modelId, info);
        }
      }
    }
    return undefined;
  }
  const targetRegex = buildModelMatchRegex(requestedId);
  if (typeof value === "string") {
    return targetRegex.test(value) && isUsableRuntimeModelId(value) ? { id: value } : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

async function fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel) {
  const bodies = [{ project: projectId }];
  const attempts = endpointCandidates().flatMap((endpoint) =>
    bodies.map((body) => ({ endpoint, body })),
  );
  const settled = await Promise.all(
    attempts.map(async ({ endpoint, body }) => {
      try {
        const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: antigravityHeaders(token),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) return { endpoint, status: response.status, data: undefined };
        return { endpoint, status: response.status, data: await response.json() };
      } catch (error) {
        setLastError(error);
        return { endpoint, status: undefined, data: undefined };
      }
    }),
  );
  let lastLabels = "";
  for (const { endpoint, status, data } of settled) {
    if (status !== undefined) setLastStatus(status);
    if (data === undefined) continue;
    setLastEndpoint(endpoint);
    const labels = [...new Set(collectModelLabels(data))].slice(0, 16);
    if (labels.length) lastLabels = labels.join(",");
    const found = findDynamicModel(data, requestedRuntimeModel);
    if (found) {
      if (lastLabels) setLastAvailableModels(lastLabels);
      return found;
    }
  }
  if (lastLabels) setLastAvailableModels(lastLabels);
  return undefined;
}

async function fetchAvailableRuntimeModel(token, projectId, requestedRuntimeModel) {
  const cacheKey = `${token}::${projectId}::${requestedRuntimeModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inFlight = inFlightModelLookups.get(cacheKey);
  if (inFlight) return inFlight;
  const promise = fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel).then(
    (result) => {
      modelCache.set(cacheKey, { result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return result;
    },
  );
  inFlightModelLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightModelLookups.delete(cacheKey);
    if (modelCache.size > 64) {
      const now = Date.now();
      for (const [key, entry] of modelCache) {
        if (entry.expiresAt <= now) modelCache.delete(key);
      }
    }
  }
}

function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining) {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining, width = 20) {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return resetTime;
  const delta = timestamp - Date.now();
  if (delta <= 0) return "now";
  const totalMinutes = Math.round(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function postJson(path, token, body, signal = AbortSignal.timeout(15000)) {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
        signal,
      });
      setLastEndpoint(endpoint);
      setLastStatus(response.status);
      const text = await response.text();
      const data = safeJsonParse(text) ?? { raw: text };
      if (!response.ok) {
        lastErrorText =
          isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
            ? data.error.message
            : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`${path} failed (${String(response.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: response.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

async function fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal = AbortSignal.timeout(15000)) {
  try {
    const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal,
    });
    const text = await response.text();
    const data = safeJsonParse(text) ?? { raw: text };
    if (!response.ok) {
      const lastErrorText =
        isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
          ? data.error.message
          : text;
      setLastError(lastErrorText);
      return undefined;
    }
    return { endpoint, status: response.status, data };
  } catch (error) {
    setLastError(error);
    return undefined;
  }
}

async function fetchMergedAvailableModels(token, projectId, signal) {
  const results = await Promise.all(
    endpointCandidates().map((endpoint) => fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal)),
  );
  const mergedModels = {};
  let defaultAgentModelId;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    if (isRecord(result.data) && isRecord(result.data.models)) {
      Object.assign(mergedModels, result.data.models);
    }
    if (isRecord(result.data) && typeof result.data.defaultAgentModelId === "string") {
      defaultAgentModelId = result.data.defaultAgentModelId;
    }
  }

  if (!lastEndpoint) throw new Error("/v1internal:fetchAvailableModels failed: no endpoint available");
  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: { models: mergedModels, defaultAgentModelId },
  };
}

function parseQuotaSummary(data) {
  const summary = isRecord(data) ? data : {};
  const groups = [];
  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    if (!isRecord(group)) continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket)) continue;
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const models = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const quotaInfo = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function extractModelVersion(model) {
  const name = String(model?.name || "");
  const id = String(model?.id || model?.modelId || "");
  const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || id.match(/\b(\d+(?:\.\d+)+)\b/);
  if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || name.match(/\b(\d+(?:\.\d+)+)\b/);
  if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  return [0];
}

function compareVersionsDesc(v1, v2) {
  const len = Math.max(v1.length, v2.length);
  for (let i = 0; i < len; i++) {
    const num1 = v1[i] !== undefined ? v1[i] : 0;
    const num2 = v2[i] !== undefined ? v2[i] : 0;
    if (num1 !== num2) return num2 - num1;
  }
  return 0;
}

function getFamilyOrder(model) {
  const text = `${model?.id || ""} ${model?.name || ""}`.toLowerCase();
  if (text.includes("gemini")) return 1;
  if (text.includes("claude")) return 2;
  if (text.includes("gpt")) return 3;
  return 4;
}

function getVariantScore(model) {
  const text = `${model?.name || ""} ${model?.id || ""}`.toLowerCase();
  if (text.includes("ultra")) return 1;
  if (text.includes("pro") && !text.includes("lite")) return 2;
  if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
  if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
  if (text.includes("image")) return 5;
  if (text.includes("lite") && !text.includes("thinking")) return 6;
  if (text.includes("lite") && text.includes("thinking")) return 7;
  return 10;
}

export function compareAntigravityModels(a, b) {
  const famA = getFamilyOrder(a);
  const famB = getFamilyOrder(b);
  if (famA !== famB) return famA - famB;

  const verA = extractModelVersion(a);
  const verB = extractModelVersion(b);
  const verComp = compareVersionsDesc(verA, verB);
  if (verComp !== 0) return verComp;

  const variantA = getVariantScore(a);
  const variantB = getVariantScore(b);
  if (variantA !== variantB) return variantA - variantB;

  return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
}

export function compareAntigravityModelOptions(a, b) {
  const aEnabled = Boolean(a?.enabled);
  const bEnabled = Boolean(b?.enabled);
  if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
  return compareAntigravityModels(a, b);
}

function modelNameFromId(id) {
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bOss\b/g, "OSS");
}

function inferModelShape(modelId, info = {}) {
  const id = String(modelId);
  const staticModel = modelById(id);
  if (staticModel) return staticModel;
  const lower = id.toLowerCase();
  const maxTokens = getMaxOutputTokens(id, id);
  const inputModalities = info.supportsImages || /gemini|claude/i.test(id) ? ["text", "image"] : ["text"];
  const reasoningEfforts = lower.includes("gpt-oss")
    ? ["medium"]
    : lower.includes("claude")
      ? ["high"]
      : lower.includes("pro")
        ? ["low", "high"]
        : lower.includes("gemini")
          ? ["low", "medium", "high"]
          : [];
  let name = info.displayName || info.label || info.modelName || modelNameFromId(id);
  if (id === "gemini-3.8-flash-tiered") {
    name = "Gemini 3.8 Flash";
  }
  if (id === "gemini-3.7-flash-tiered") {
    name = "Gemini 3.7 Flash";
  }
  const idVer = extractModelVersion({ id });
  const nameVer = extractModelVersion({ name });
  if (
    idVer[0] !== 0 &&
    nameVer[0] !== 0 &&
    (idVer[0] !== nameVer[0] || (idVer[1] !== undefined && nameVer[1] !== undefined && idVer[1] !== nameVer[1]))
  ) {
    name = modelNameFromId(id);
  }
  return {
    id,
    name,
    inputModalities,
    contextWindow: lower.includes("claude") ? 200000 : lower.includes("gpt-oss") ? 131072 : 1048576,
    maxTokens,
    reasoningEfforts,
  };
}

function baseModelMatcher(baseId) {
  switch (baseId) {
    case "gemini-3.8-flash":
      return (text) => /gemini[- ]3\.8[- ]flash/i.test(text);
    case "gemini-3.7-flash":
      return (text) => /gemini[- ]3\.7[- ]flash/i.test(text);
    case "gemini-3.6-flash":
      return (text) => /gemini[- ]3\.6[- ]flash/i.test(text);
    case "gemini-3.5-flash":
      return (text) => /gemini[- ]3\.5[- ]flash|gemini[- ]3[- ]flash[- ]agent/i.test(text);
    case "gemini-3.1-pro":
      return (text) => /gemini[- ]3\.1[- ]pro|gemini[- ]pro[- ]agent/i.test(text);
    case "gemini-3.1-flash-image":
      return (text) => /gemini[- ]3\.1[- ]flash[- ]image/i.test(text);
    case "gemini-3-flash":
      return (text) => /^gemini[- ]3[- ]flash$/i.test(text);
    case "gemini-2.5-pro":
      return (text) => /gemini[- ]2\.5[- ]pro/i.test(text);
    case "gemini-2.5-flash":
      return (text) => /gemini[- ]2\.5[- ]flash|gemini[- ]3\.1[- ]flash[- ]lite/i.test(text);
    case "claude-sonnet-4-6":
      return (text) => /claude[- ]sonnet/i.test(text);
    case "claude-opus-4-6":
      return (text) => /claude[- ]opus/i.test(text);
    case "gpt-oss-120b":
      return (text) => /gpt[- ]oss/i.test(text);
    default:
      return (text) => String(text || "").toLowerCase().includes(baseId.toLowerCase());
  }
}

function parseCatalogModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const rawModels = [];
  for (const [modelId, infoRaw] of Object.entries(modelsObj)) {
    if (!isUsableRuntimeModelId(modelId)) continue;
    if (!isRecord(infoRaw)) continue;
    if (infoRaw.isInternal || String(modelId).startsWith("chat_") || String(modelId).startsWith("tab_")) continue;
    const quotaInfo = isRecord(infoRaw.quotaInfo) ? infoRaw.quotaInfo : {};
    const inferred = inferModelShape(modelId, infoRaw);
    rawModels.push({
      id: modelId,
      name: inferred.name,
      inputModalities: inferred.inputModalities,
      contextWindow: inferred.contextWindow,
      maxTokens: inferred.maxTokens,
      reasoningEfforts: inferred.reasoningEfforts,
      available: true,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider:
        typeof infoRaw.modelProvider === "string"
          ? infoRaw.modelProvider
          : typeof infoRaw.apiProvider === "string"
            ? infoRaw.apiProvider
            : undefined,
    });
  }

  const matchedRawIds = new Set();
  const consolidated = [];

  for (const base of MODELS) {
    const matcher = baseModelMatcher(base.id);
    const matching = rawModels.filter((r) => matcher(r.id) || matcher(r.name));
    if (matching.length > 0) {
      for (const m of matching) matchedRawIds.add(m.id);
      const quotaItem = matching.find((m) => typeof m.remainingFraction === "number") || matching[0];
      consolidated.push({
        id: base.id,
        name: base.name,
        inputModalities: base.inputModalities,
        contextWindow: base.contextWindow,
        maxTokens: base.maxTokens,
        reasoningEfforts: base.reasoningEfforts,
        available: true,
        remainingFraction: quotaItem?.remainingFraction,
        resetTime: quotaItem?.resetTime,
        modelProvider: quotaItem?.modelProvider,
      });
    } else {
      consolidated.push({
        id: base.id,
        name: base.name,
        inputModalities: base.inputModalities,
        contextWindow: base.contextWindow,
        maxTokens: base.maxTokens,
        reasoningEfforts: base.reasoningEfforts,
        available: true,
      });
    }
  }

  for (const raw of rawModels) {
    if (!matchedRawIds.has(raw.id)) {
      consolidated.push(raw);
    }
  }

  consolidated.sort(compareAntigravityModels);
  return consolidated;
}

function parseTier(value) {
  if (!isRecord(value)) return undefined;
  if (!value.id && !value.name) return undefined;
  return {
    id: value.id ? String(value.id) : undefined,
    name: value.name ? String(value.name) : undefined,
    description: value.description ? String(value.description) : undefined,
  };
}

export async function fetchAccountQuota(store = new FileCredentialStore(), modelSettings, signal = AbortSignal.timeout(20000)) {
  if (typeof store.capture === "function") store = await store.capture();
  if (!store) throw new Error("No Antigravity account selected. Add or select an account.");
  const accountId = store.accountId || "legacy";
  const epoch = quotaEpochs.get(accountId) || 0;
  try {
  const { token, projectId: credentialProjectId } = await ensureApiKey(store);
  const assistResult = await postJson("/v1internal:loadCodeAssist", token, {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }, signal).catch(() => null);

  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    credentialProjectId,
    warmedProject: discoveredProject ?? null,
  });
  setLastProjectId(projectId);

  const [available, summary] = await Promise.all([
    fetchMergedAvailableModels(token, projectId, signal),
    postJson("/v1internal:retrieveUserQuotaSummary", token, { project: projectId }, signal),
  ]);
  const { groups, description } = parseQuotaSummary(summary.data);
  const { models, defaultAgentModelId } = parseModels(available.data);
  const catalogModels = parseCatalogModels(available.data);
  const assistData = isRecord(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  const quota = {
    accountId,
    projectId,
    endpoint: summary.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    models,
    catalogModels,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };

  if ((quotaEpochs.get(accountId) || 0) !== epoch) throw new Error("Account changed while quota was being refreshed; refresh again.");
  accountQuotas.set(accountId, quota);
  accountQuotaErrors.delete(accountId);
  // Account quota reads must not rewrite global model selections/catalogs after an asynchronous switch.

  return quota;
  } catch (error) {
    if ((quotaEpochs.get(accountId) || 0) === epoch) accountQuotaErrors.add(accountId);
    throw error;
  }
}

export function getCachedQuota(accountId = activeQuotaAccountId) {
  return accountQuotas.get(accountId);
}

export function formatQuotaSummary(quota) {
  const lines = [];
  lines.push("Antigravity quota");
  if (quota.planLabel) lines.push(`plan=${quota.planLabel}`);
  lines.push(`project=${quota.projectId}`);
  lines.push(`fetched=${new Date(quota.fetchedAt).toLocaleString()}`);

  if (!quota.groups.length) {
    lines.push("");
    lines.push("No quota groups returned.");
  } else {
    for (const group of quota.groups) {
      lines.push("");
      lines.push(group.displayName);
      for (const bucket of group.buckets) {
        const remaining = remainingPercent(bucket.remainingFraction);
        lines.push(
          `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${remaining ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
        );
      }
    }
  }

  const rows = quota.models.filter((model) => !/tab_|chat_/i.test(model.modelId)).slice(0, 24);
  if (rows.length) {
    lines.push("");
    lines.push("Models");
    const maxId = Math.max(...rows.map((model) => model.modelId.length), 8);
    for (const model of rows) {
      const remaining = remainingPercent(model.remainingFraction);
      const flags = [
        model.recommended ? "recommended" : "",
        model.supportsThinking ? "thinking" : "",
        model.supportsImages ? "images" : "",
      ]
        .filter(Boolean)
        .join(",");
      const display = model.displayName && model.displayName !== model.modelId ? `  ${model.displayName}` : "";
      lines.push(
        `${model.modelId.padEnd(maxId)}  rem ${remaining === undefined ? "  ?" : String(remaining).padStart(5)}%  reset ${formatReset(model.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${display}`,
      );
    }
    lines.push("");
    lines.push("Note: remaining % is pool-shared, not a private per-model budget.");
  }
  return lines.join("\n").trimEnd();
}

function getMaxOutputTokens(modelId, runtimeModel) {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
  if (runtimeModel) {
    if (runtimeModel.startsWith("claude-")) return 64000;
    if (runtimeModel.startsWith("gpt-oss-")) return 32768;
    if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
      return 65535;
    }
    if (runtimeModel.startsWith("gemini-")) return 65536;
  }
  return 8192;
}

function getAntigravityRequestModelId(modelId, effort) {
  const route = ROUTING[modelId];
  if (!route) return modelId;
  if (effort === undefined || effort === "off") {
    return route.off ?? route.routing?.high ?? route.defaultRequestId ?? modelId;
  }
  if (effort === "xhigh") {
    return (
      route.routing?.xhigh ??
      route.routing?.high ??
      route.routing?.medium ??
      route.routing?.low ??
      route.off ??
      route.defaultRequestId ??
      modelId
    );
  }
  return (
    route.routing?.[effort] ??
    route.routing?.high ??
    route.routing?.medium ??
    route.routing?.low ??
    route.off ??
    route.defaultRequestId ??
    modelId
  );
}

function getFallbackRuntimeModel(runtimeModel, effort) {
  if (runtimeModel === "gemini-3.8-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.7-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.8-flash-")) {
    return runtimeModel.replace("gemini-3.8-flash-", "gemini-3.7-flash-");
  }
  if (runtimeModel === "gemini-3.8-flash") return "gemini-3.7-flash-tiered";
  if (runtimeModel === "gemini-3.8-flash-tiered" || runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") return "gemini-3.6-flash-low";
  return undefined;
}

function modelById(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function reasoningInfo(model) {
  // Saved model catalogs predate explicit-off support. Project the capability
  // at read time instead of rewriting the user's persisted model settings.
  const efforts = model.id === "gemini-2.5-flash"
    ? ["off", ...model.reasoningEfforts.filter((level) => level !== "off")]
    : model.reasoningEfforts;
  if (!efforts.length) return {};
  return {
    reasoning: {
      efforts: efforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}

function resolveReasoning(model, effort) {
  if (effort === undefined || effort === "off") return effort;
  if (model.reasoningEfforts && model.reasoningEfforts.includes(effort)) return effort;
  // If user selected an unsupported effort level, fallback to "high" (or available highest)
  if (model.reasoningEfforts && model.reasoningEfforts.includes("high")) return "high";
  return (model.reasoningEfforts && model.reasoningEfforts[0]) || "high";
}

function hasImages(messages) {
  return messages.some((message) => {
    try {
      return contentHasImage(message.content);
    } catch {
      return false;
    }
  });
}

function sanitizeToolCallId(id, fallbackName) {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId, runtimeModel) {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function parseArguments(raw) {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") return {};
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return isRecord(parsed) ? parsed : {};
}

function imageBlockToPart(block) {
  if (!isRecord(block) || block.type !== "image") return undefined;
  let data = asString(block.data) || asString(block.base64);
  const source = isRecord(block.source) ? block.source : undefined;
  if (!data && source) data = asString(source.data) || asString(source.base64);
  let mimeType =
    asString(block.mimeType) ||
    asString(block.mediaType) ||
    (source ? asString(source.mimeType) || asString(source.mediaType) : undefined) ||
    "image/png";
  if (data?.startsWith("data:")) {
    const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
    if (match) {
      mimeType = match[1] || mimeType;
      data = match[2] || "";
    }
  }
  return data ? { inlineData: { mimeType, data } } : undefined;
}

function contentToUserParts(content) {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text") {
      parts.push({ text: sanitizeText(block.text) });
    } else if (isRecord(block) && block.type === "image") {
      const imagePart = imageBlockToPart(block);
      if (imagePart) parts.push(imagePart);
    }
  }
  return parts;
}

function toolResultText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return sanitizeText(block.text);
      if (block.type === "tool-result") return toolResultText(block.content);
      return "";
    })
    .join("");
}

function replayBlockFor(message, index) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}

function assistantParts(message, model, runtimeModel, toolNames, sanitizedToolIds) {
  const parts = [];
  if (!Array.isArray(message.content)) return parts;
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block)) continue;
    const replay = replayBlockFor(message, index);
    if (block.type === "text" && String(block.text || "").trim()) {
      parts.push({ text: sanitizeText(block.text) });
    } else if (block.type === "reasoning" && String(block.text || "").trim()) {
      if (replay?.type === "reasoning" && replay.thinkingSignature) {
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
          thoughtSignature: replay.thinkingSignature,
        });
      } else {
        parts.push({ text: sanitizeText(block.text) });
      }
    } else if (block.type === "tool-call") {
      const toolId = String(block.id || "");
      const sanitized = sanitizeToolCallId(toolId, block.name);
      toolNames.set(toolId, block.name);
      toolNames.set(sanitized, block.name);
      if (sanitizedToolIds) sanitizedToolIds.set(toolId, sanitized);
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...(toolCallIdNeeded(model.id, runtimeModel)
            ? { id: sanitized }
            : {}),
        },
        ...(replay?.type === "tool-call" && replay.thoughtSignature
          ? { thoughtSignature: replay.thoughtSignature }
          : {}),
      });
    }
  }
  return parts;
}

function pushToolResult(contents, result, toolNames, sanitizedToolIds, model, runtimeModel) {
  const toolCallId = String(result.toolCallId || "");
  const toolName = toolNames.get(toolCallId) || "unknown";
  const sanitizedId = (sanitizedToolIds && sanitizedToolIds.get(toolCallId)) || sanitizeToolCallId(toolCallId, toolName);
  const responseText = toolResultText(result.content) || (result.isError ? "Tool failed" : "");
  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError ? { error: responseText } : { output: responseText },
      ...(toolCallIdNeeded(model.id, runtimeModel)
        ? { id: sanitizedId }
        : {}),
    },
  };
  const last = contents[contents.length - 1];
  if (last?.role === GEMINI_ROLE.user && last.parts.some((entry) => "functionResponse" in entry)) {
    last.parts.push(part);
  } else {
    contents.push({ role: GEMINI_ROLE.user, parts: [part] });
  }
}

function convertMessages(options, model, runtimeModel) {
  const contents = [];
  const toolNames = new Map();
  const sanitizedToolIds = new Map();

  function appendRoleParts(role, parts) {
    if (!parts || !parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts: [...parts] });
    }
  }

  for (const message of options.messages) {
    if (message.role === "assistant") {
      const parts = assistantParts(message, model, runtimeModel, toolNames, sanitizedToolIds);
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts });
      continue;
    }

    if (message.role === "tool") {
      pushToolResult(contents, message, toolNames, sanitizedToolIds, model, runtimeModel);
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const nonResultContent = content.filter((block) => !isRecord(block) || block.type !== "tool-result");
    const userParts = contentToUserParts(nonResultContent);
    if (message.role === "system") {
      if (userParts.length) appendRoleParts(GEMINI_ROLE.user, userParts);
      continue;
    }
    if (userParts.length) appendRoleParts(GEMINI_ROLE.user, userParts);
    for (const block of content) {
      if (isRecord(block) && block.type === "tool-result") {
        pushToolResult(contents, block, toolNames, sanitizedToolIds, model, runtimeModel);
      }
    }
  }

  // Claude / Vertex strict tool_use validation:
  // Ensure every functionCall in a model message has a corresponding functionResponse in the immediately following user message.
  if (toolCallIdNeeded(model.id, runtimeModel)) {
    for (let i = 0; i < contents.length; i++) {
      if (contents[i].role === GEMINI_ROLE.model) {
        const expectedIds = new Set();
        const callNameMap = new Map();
        for (const part of contents[i].parts || []) {
          if (part.functionCall?.id) {
            expectedIds.add(part.functionCall.id);
            callNameMap.set(part.functionCall.id, part.functionCall.name);
          }
        }
        if (expectedIds.size > 0) {
          const next = contents[i + 1];
          if (next && next.role === GEMINI_ROLE.user) {
            const answeredIds = new Set();
            for (const part of next.parts || []) {
              if (part.functionResponse?.id) {
                answeredIds.add(part.functionResponse.id);
              }
            }
            for (const id of expectedIds) {
              if (!answeredIds.has(id)) {
                next.parts.unshift({
                  functionResponse: {
                    name: callNameMap.get(id) || "unknown",
                    response: { output: "(completed)" },
                    id,
                  },
                });
              }
            }
          } else {
            const syntheticParts = [];
            for (const id of expectedIds) {
              syntheticParts.push({
                functionResponse: {
                  name: callNameMap.get(id) || "unknown",
                  response: { output: "(completed)" },
                  id,
                },
              });
            }
            contents.splice(i + 1, 0, { role: GEMINI_ROLE.user, parts: syntheticParts });
          }
        }
      }
    }
  }

  return contents;
}

function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((entry) => typeof entry === "string" && entry !== "null");
}

function normalizeCustomToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(toolChoice) {
  if (toolChoice === "none") return TOOL_CALLING_MODE.none;
  if (toolChoice === "any" || toolChoice === "required") return TOOL_CALLING_MODE.any;
  return TOOL_CALLING_MODE.auto;
}

function buildRequest(options, model, projectId, runtimeModel, effort) {
  const request = {
    contents: convertMessages(options, model, runtimeModel),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        ...(options.system ? [{ text: sanitizeText(options.system) }] : []),
      ],
    },
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  // Explicit opt-out for Gemini 2.5 Flash. Other calls/models keep their
  // existing defaults; an alias override must not silently turn thinking on.
  if (model.id === "gemini-2.5-flash" && effort === "off") {
    if (runtimeModel !== "gemini-2.5-flash") {
      throw new LlmError("Gemini 2.5 Flash thinking-off requires its exact runtime model", "UNSUPPORTED_REASONING_EFFORT");
    }
    generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
  }
  if (runtimeModel === "gemini-3.8-flash-tiered" || runtimeModel === "gemini-3.7-flash-tiered") {
    const selected = effort || "off";
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
    };
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const usesLegacyToolSchema = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const tools = convertTools(options.tools, usesLegacyToolSchema);
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } }
        : { functionCallingConfig: { mode: TOOL_CALLING_MODE.validated } };
    } else if (options.toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } };
    }
  }
  if (options.sessionId) request.sessionId = String(options.sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: nowRequestId(),
  };
}

function mapUsage(usage) {
  const inputTokens = Math.max(0, (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0));
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedContentTokenCount > 0 ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
  };
}

function classifyAntigravityError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
  return "ANTIGRAVITY_ERROR";
}

function friendlyAntigravityError(status, text) {
  const message = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      return "Antigravity login expired or credentials are invalid. Next: run /antigravity-login, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(message)) {
      return `Antigravity request format was rejected by the backend (${message}). Next: switch to a simpler model or update the plugin.`;
    }
    return `Bad request from Antigravity. Backend said: ${message}`;
  }
  if (status === 401) return "Antigravity authentication failed. Next: run /antigravity-login, then retry.";
  if (status === 403) return `Antigravity denied this request. Backend said: ${message}`;
  if (status === 404) return `Antigravity could not find the requested model/resource. Backend said: ${message}`;
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) return "Antigravity reported a conflict. Next: retry once or start a new chat session.";
  if (status === 429) {
    const wait = message.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/quota/i.test(message)) return `Quota reached.${wait ? ` Please wait ${wait}.` : ""}`;
    return `Rate limited by Antigravity.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) return "Antigravity had an internal server error. Next: retry or switch models.";
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry.";
  if (status === 503) return /No capacity available/i.test(message)
    ? "This model has no capacity right now. Next: retry later or switch models."
    : "Antigravity is temporarily unavailable. Next: retry or switch models.";
  if (status === 504) return "Antigravity timed out upstream. Next: retry.";
  return message || "Antigravity request failed";
}

function formatRequestDiagnostics(extra) {
  return `endpoint=${diagnostics.endpoint || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${diagnostics.matchedModelDebug || "none"}, available=${diagnostics.availableModels || "unknown"}`;
}

async function saveRequestFailure(fields) {
  try {
    return await writeAntigravityFailure(dshHomePath("storages", "antigravity-diagnostics"), fields);
  } catch (error) {
    // A failed diagnostic write must never replace or retry the original provider error.
    console.error(`[antigravity] diagnostic write failed: ${safeError(error)}`);
    return undefined;
  }
}

function finishReasonOf(rawReason, hasToolCall, hasContent, errorMessage) {
  if (errorMessage && isContextWindowExceededError(errorMessage)) {
    return { kind: "error", failure: { message: errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  if (!hasContent) {
    return {
      kind: "error",
      failure: { message: "Antigravity returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
    };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "MAX_TOKENS") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "STOP") return { kind: "stop" };
  return {
    kind: "error",
    failure: { message: `Antigravity finished with reason ${rawReason}`, code: "ANTIGRAVITY_FINISH_REASON" },
  };
}

function replayStateOf(model, runtimeModel, replayBlocks) {
  return {
    kind: "antigravity",
    version: 1,
    provider: PROVIDER,
    model: model.id,
    runtimeModel,
    blocks: replayBlocks,
  };
}

function processStreamLine(line, state) {
  if (!line.startsWith("data:")) return [];
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return [];
  const chunk = safeJsonParse(json);
  if (!isRecord(chunk)) return [];
  if (isRecord(chunk.error)) {
    const message = chunk.error.message || JSON.stringify(chunk.error);
    throw new LlmError(String(message), classifyAntigravityError(String(message)));
  }
  const responseData = isRecord(chunk.response) ? chunk.response : chunk;
  const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
  const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const out = [];

  const closeCurrentBlock = () => {
    if (!state.currentBlock) return;
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      out.push({
        type: "block-end",
        index,
        block: { type: "text", text: state.currentBlock.text },
      });
    } else {
      out.push({
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      });
    }
    state.currentBlock = null;
  };

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.text !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        closeCurrentBlock();
        state.currentBlock = {
          type: blockType,
          text: "",
          thinkingSignature: undefined,
          textSignature: undefined,
        };
        state.blocks.push(state.currentBlock);
        state.replayBlocks.push({ type: blockType });
        out.push({ type: "block-start", index: state.blocks.length - 1, blockType });
      }
      const delta = sanitizeText(part.text);
      state.currentBlock.text += delta;
      state.hasContent = true;
      if (isThinking && part.thoughtSignature) {
        state.currentBlock.thinkingSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = part.thoughtSignature;
      } else if (!isThinking && part.thoughtSignature) {
        state.currentBlock.textSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = part.thoughtSignature;
      }
      out.push({
        type: isThinking ? "reasoning-delta" : "text-delta",
        index: state.blocks.length - 1,
        text: delta,
      });
    }
    if (isRecord(part.functionCall)) {
      closeCurrentBlock();
      const toolName = asString(part.functionCall.name) || "";
      const toolId = sanitizeToolCallId(part.functionCall.id || "", toolName);
      const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
      const argsText = JSON.stringify(args);
      const index = state.blocks.length;
      const block = { type: "tool-call", id: CallId(toolId), name: toolName, arguments: argsText };
      state.blocks.push(block);
      state.replayBlocks.push({
        type: "tool-call",
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
      state.hasContent = true;
      state.hasToolCall = true;
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id: CallId(toolId),
        ...(toolName ? { name: toolName } : {}),
        argumentsDelta: argsText,
      });
      out.push({ type: "block-end", index, block });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (isRecord(responseData.usageMetadata)) state.usage = responseData.usageMetadata;
  return out;
}

async function* streamResponseToChunks(response, model, runtimeModel, state) {
  if (!response.body) throw new LlmError("Antigravity response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line) => processStreamLine(line.replace(/\r$/, ""), state);
  const emitBufferedLines = function* () {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* emitLine(line);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });
    yield* emitBufferedLines();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* emitLine(buffer.trimEnd());
    buffer = "";
  }

  if (state.currentBlock) {
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      yield { type: "block-end", index, block: { type: "text", text: state.currentBlock.text } };
    } else {
      yield {
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      };
    }
    state.currentBlock = null;
  }

  if (!state.hasContent) return;
  yield { type: "usage", usage: mapUsage(state.usage || {}) };
  yield {
    type: "finish",
    reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
    replayState: replayStateOf(model, runtimeModel, state.replayBlocks),
  };
}

function createStreamState() {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: null,
    finishReason: undefined,
    usage: undefined,
    hasContent: false,
    hasToolCall: false,
  };
}

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text) {
  const redacted = redactSecrets(text).trim();
  const parsed = safeJsonParse(redacted);
  if (isRecord(parsed)) {
    const parts = [parsed.error, parsed.error_description].filter(
      (part) => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function getUserEmail(token) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    return asString(data.email);
  } catch {
    return undefined;
  }
}

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    const callbackUrl = redirectUri();
    const server = createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, oauthCallbackHeaders("text/plain; charset=utf-8"));
        response.end("Method Not Allowed");
        return;
      }
      const url = new URL(request.url || "", callbackUrl);
      if (url.pathname !== REDIRECT_PATH) {
        response.writeHead(404, oauthCallbackHeaders());
        response.end("Antigravity OAuth callback route not found.");
        return;
      }
      const providerError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (providerError) {
        const safe = escapeHtml(providerError.slice(0, 200));
        response.writeHead(400, oauthCallbackHeaders());
        response.end(`Antigravity authentication failed: ${safe}`);
        finish(() => rejectCode(new Error(`OAuth error: ${providerError.slice(0, 200)}`)));
        return;
      }
      if (!code || !state) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: missing code or state.");
        finish(() => rejectCode(new Error("Missing code or state in OAuth callback")));
        return;
      }
      if (state !== expectedState) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: invalid state.");
        finish(() => rejectCode(new Error("OAuth state mismatch")));
        return;
      }
      response.writeHead(200, oauthCallbackHeaders());
      response.end("Antigravity authentication complete. You can close this window and return to DSH.");
      finish(() => resolveCode({ code, state }));
    });
    server.on("error", reject);
    server.listen(callbackPort(), resolveCallbackHost(), () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
        server.close();
      }, OAUTH_CALLBACK_TIMEOUT_MS);
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

export function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
  } catch {
    // Best effort only.
  }
}

export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
  };
}

export function terminalInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type !== "auth_url") return;
      console.log(event.instructions || "Open the following URL to sign in:");
      console.log(event.url);
      openBrowser(event.url);
    },
  };
}

export async function loginAntigravity(interaction = browserInteraction()) {
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  try {
    const callbackUrl = redirectUri();
    const authParams = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: callbackUrl,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent select_account",
    });
    interaction.notify?.({
      type: "auth_url",
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete Google sign-in. DSH will capture the local callback.",
    });

    const { code, state: returnedState } = await waitForCode();
    if (returnedState !== state) throw new Error("OAuth state mismatch");
    if (interaction.signal?.aborted) throw new Error("OAuth login aborted");

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }).toString(),
      signal: interaction.signal,
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
      );
    }
    const tokenData = await tokenResponse.json();
    if (!tokenData.refresh_token) {
      throw new Error("No refresh token received. Re-run /antigravity-login and allow offline access.");
    }
    const [email, discoveredProject] = await Promise.all([
      getUserEmail(tokenData.access_token),
      loadCodeAssist(tokenData.access_token),
    ]);
    return {
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
      email,
    };
  } finally {
    server.close();
  }
}

function credentialSummary(credentials) {
  if (!credentials) return { authenticated: false };
  return {
    authenticated: true,
    email: credentialEmail(credentials),
    projectId: credentialProjectId(credentials),
    expires: credentials.expires,
  };
}

async function exchangeOAuthCode(code, verifier, callbackUrl) {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
    );
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.refresh_token) {
    throw new Error("No refresh token received. Re-run login and allow offline access.");
  }
  const [email, discoveredProject] = await Promise.all([
    getUserEmail(tokenData.access_token),
    loadCodeAssist(tokenData.access_token),
  ]);
  if (!email) throw new Error("Could not verify the Google account email. Retry login; existing accounts were not changed.");
  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
    email,
  };
}

export async function beginWebLogin(store) {
  if (webLoginFlow?.status === "pending") {
    return {
      status: webLoginFlow.status,
      authUrl: webLoginFlow.authUrl,
      startedAt: webLoginFlow.startedAt,
    };
  }

  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  const callbackUrl = redirectUri();
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent select_account",
  });
  const flow = {
    status: "pending",
    authUrl: `${AUTH_URL}?${authParams.toString()}`,
    startedAt: Date.now(),
    error: "",
  };
  webLoginFlow = flow;

  void (async () => {
    try {
      const { code, state: returnedState } = await waitForCode();
      if (returnedState !== state) throw new Error("OAuth state mismatch");
      const credentials = await exchangeOAuthCode(code, verifier, callbackUrl);
      await store.write(credentials);
      flow.status = "complete";
      flow.email = credentialEmail(credentials);
      flow.completedAt = Date.now();
      invalidateAccountQuota();
    } catch (error) {
      flow.status = "error";
      flow.error = safeError(error);
      flow.completedAt = Date.now();
    } finally {
      server.close();
    }
  })();

  return {
    status: flow.status,
    authUrl: flow.authUrl,
    startedAt: flow.startedAt,
  };
}

export function getWebLoginStatus() {
  if (!webLoginFlow) return { status: "idle" };
  return {
    status: webLoginFlow.status,
    startedAt: webLoginFlow.startedAt,
    completedAt: webLoginFlow.completedAt,
    email: webLoginFlow.email,
    error: webLoginFlow.error,
  };
}

function credentialProjectId(credentials) {
  return asString(credentials?.projectId);
}

function credentialEmail(credentials) {
  return asString(credentials?.email);
}

function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshAntigravityToken(credentials) {
  if (!credentials?.refresh) throw new Error("Missing Antigravity refresh token. Run /antigravity-login.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = await response.json();
  const existingProjectId = credentialProjectId(credentials);
  const discoveredProject = existingProjectId ? undefined : await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      existingProjectId || discoveredProject || defaultProjectId(email || "antigravity-default"),
  };
}

export function getApiKey(credentials) {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

export class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = credentialPath()) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(credentials) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async delete() {
    await this.#chain.catch(() => {});
    try {
      await unlink(this.#file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function normalizeModelSettings(raw) {
  const enabledModelIds = Array.isArray(raw?.enabledModelIds)
    ? raw.enabledModelIds.filter((id) => typeof id === "string" && id.length > 0 && !/\s/.test(id))
    : DEFAULT_ENABLED_MODEL_IDS;
  return {
    enabledModelIds: [...new Set(enabledModelIds)],
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    catalogModels: Array.isArray(raw?.catalogModels)
      ? raw.catalogModels.filter((model) => isRecord(model) && typeof model.id === "string" && model.id.length > 0)
      : [],
  };
}

export class FileModelSettingsStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = modelSettingsPath()) {
    this.#file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return normalizeModelSettings(isRecord(parsed) ? parsed : undefined);
    } catch (error) {
      if (error && error.code === "ENOENT") return normalizeModelSettings(undefined);
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeModelSettings(settings);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
    return this.read();
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) return this.write(updated);
      return current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  setEnabledModelIds(enabledModelIds) {
    return this.modify((current) => ({ ...current, enabledModelIds }));
  }

  setCatalogModels(catalogModels, options = {}) {
    return this.modify((current) => ({
      ...current,
      catalogModels,
      ...(Array.isArray(options.enabledModelIds) ? { enabledModelIds: options.enabledModelIds } : {}),
    }));
  }
}

function enabledModelSet(settings) {
  return new Set(normalizeModelSettings(settings).enabledModelIds);
}

function catalogModelsOf(settings) {
  const normalized = normalizeModelSettings(settings);
  return normalized.catalogModels.length ? normalized.catalogModels : MODELS;
}

function configuredModels(settings) {
  const enabled = enabledModelSet(settings);
  return catalogModelsOf(settings).filter((model) => enabled.has(model.id)).sort(compareAntigravityModels);
}

function modelFromSettings(settings, modelId) {
  return catalogModelsOf(settings).find((model) => model.id === modelId) || modelById(modelId) || inferModelShape(modelId);
}

export async function loginAndSave(store, interaction = browserInteraction()) {
  const credentials = await loginAntigravity(interaction);
  await store.write(credentials);
  return credentials;
}

async function ensureApiKey(store) {
  let credentials = await store.read();
  if (!credentials) {
    throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
  }
  if (needsRefresh(credentials)) {
    credentials = await store.modify(async (current) => {
      if (!current) throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
      if (!needsRefresh(current)) return current;
      return refreshAntigravityToken(current);
    });
  }
  let warmedProject = null;
  if (!credentialProjectId(credentials) && !antigravityEnv("PROJECT_ID")) {
    warmedProject = await loadCodeAssist(credentials.access);
    if (warmedProject) {
      await store.modify(async (current) => (current && current.access === credentials.access && !current.projectId ? { ...current, projectId: warmedProject } : undefined));
    }
  }
  const projectId = resolveProjectId({
    credentialProjectId: credentialProjectId(credentials),
    email: credentialEmail(credentials),
    warmedProject,
  });
  setLastProjectId(projectId);
  return { token: credentials.access, projectId, email: credentialEmail(credentials) };
}

async function resolveRuntimeCandidates(token, projectId, model, effort) {
  const baseRuntimeModel =
    antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);
  const dynamic = await fetchAvailableRuntimeModel(token, projectId, baseRuntimeModel);
  const initialRuntimeModel =
    dynamic?.id && isUsableRuntimeModelId(dynamic.id) ? dynamic.id : baseRuntimeModel;
  const runtimeCandidates = [initialRuntimeModel];
  const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
  if (fallback && fallback !== initialRuntimeModel) runtimeCandidates.push(fallback);
  return runtimeCandidates;
}

async function fetchStreamResponse(endpoint, headers, body, signal) {
  try {
    return await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    const failure = new LlmError(`Antigravity stream-connect (${new URL(endpoint).host}): ${safeError(error)}`, "TRANSPORT", { cause: error });
    setLastError(failure, "stream-connect");
    // A failed fetch does not prove the server did not accept the request. Do not replay it here.
    throw failure;
  }
}

async function* requestAntigravityChunks(options, model, signal, store) {
  if (hasImages(options.messages) && !model.inputModalities.includes("image")) {
    throw new LlmError(`antigravity model "${model.id}" does not support image content`, "UNSUPPORTED_CONTENT");
  }

  const { token, projectId } = await ensureApiKey(store);
  const effort = resolveReasoning(model, options.reasoningEffort);
  const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);
  const requestHeaders = {
    ...antigravityHeaders(token),
    ...attributionHeaderBag(),
    ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  let response;
  let lastText = "";
  let runtimeModel = runtimeCandidates[0];
  let lastPayload;
  const attempts = [];

  for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
    if (emptyAttempt > 0) {
      const delay = 500 * 2 ** (emptyAttempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    for (let candidateIndex = 0; candidateIndex < runtimeCandidates.length; candidateIndex++) {
      runtimeModel = runtimeCandidates[candidateIndex];
      setLastResolvedRuntimeModel(runtimeModel);
      lastPayload = buildRequest(options, model, projectId, runtimeModel, effort);
      const body = JSON.stringify(lastPayload);

      for (const endpoint of endpointCandidates()) {
        setLastEndpoint(endpoint);
        const startedAt = Date.now();
        try {
          response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
        } catch (error) {
          attempts.push({ model: runtimeModel, endpoint, elapsedMs: Date.now() - startedAt });
          if (!signal?.aborted) {
            const diagnostic = await saveRequestFailure({ phase: "stream-connect", payload: lastPayload, endpoint,
              transportError: safeError(error), attempts });
            if (diagnostic) error.message += ` [诊断日志: ${diagnostic.path}]`;
          }
          throw error;
        }
        attempts.push({ model: runtimeModel, endpoint, status: response.status, elapsedMs: Date.now() - startedAt });
        setLastStatus(response.status);
        if (response.ok) break;
        try {
          lastText = await response.text();
        } catch (error) {
          const diagnostic = await saveRequestFailure({ phase: "http-body-read", payload: lastPayload,
            endpoint, status: response.status, transportError: safeError(error), attempts });
          throw new LlmError(`Antigravity error-body read failed (${response.status}): ${safeError(error)}${diagnostic ? ` [诊断日志: ${diagnostic.path}]` : ""}`,
            "TRANSPORT", { cause: error });
        }
        if (response.status === 429 && (/Individual quota reached/i.test(lastText) || /RESOURCE_EXHAUSTED/i.test(lastText) || /quota/i.test(lastText))) break;
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
      }

      if (response?.ok) break;
      if (response?.status === 404 && candidateIndex + 1 < runtimeCandidates.length) continue;
      break;
    }

    if (!response || !response.ok) {
      const friendly = friendlyAntigravityError(response?.status, lastText);
      const diagnostic = await saveRequestFailure({ phase: "http-error", payload: lastPayload,
        endpoint: attempts.at(-1)?.endpoint, status: response?.status, serverText: lastText, attempts });
      throw new LlmError(
        `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}${diagnostic ? ` [诊断日志: ${diagnostic.path}]` : ""}`,
        classifyAntigravityError(friendly),
      );
    }

    const state = createStreamState();
    let emitted = false;
    try {
      for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state)) {
        emitted = true;
        if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
          const diagnostic = await saveRequestFailure({ phase: "stream-finish-error", payload: lastPayload,
            endpoint: attempts.at(-1)?.endpoint, status: response.status,
            transportError: chunk.reason.failure?.message || chunk.reason.failure?.code || "stream finish error", attempts });
          if (diagnostic && chunk.reason.failure) {
            chunk.reason.failure.message = `${chunk.reason.failure.message || "Antigravity stream failed"} [诊断日志: ${diagnostic.path}]`;
          }
        }
        yield chunk;
      }
    } catch (error) {
      if (!signal?.aborted) {
        const diagnostic = await saveRequestFailure({ phase: "stream-read", payload: lastPayload,
          endpoint: attempts.at(-1)?.endpoint, status: response.status, transportError: safeError(error), attempts });
        if (diagnostic && error instanceof Error) error.message += ` [诊断日志: ${diagnostic.path}]`;
      }
      throw error;
    }
    if (state.hasContent || emitted) return;
  }

  const diagnostic = await saveRequestFailure({ phase: "empty-response", payload: lastPayload,
    endpoint: attempts.at(-1)?.endpoint, status: response?.status, attempts });
  throw new LlmError(`Antigravity API returned an empty response${diagnostic ? ` [诊断日志: ${diagnostic.path}]` : ""}`, EMPTY_RESPONSE_CODE);
}

export class AntigravityAdapter extends LlmAdapter {
  #store;
  #modelSettings;
  #runtime;

  constructor(store = new FileCredentialStore(), modelSettings = new FileModelSettingsStore()) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
    this.#runtime = store.runtime || new RuntimeStatus();
  }

  providerRetryPolicy() {
    // This adapter owns a bounded pre-output quota failover. Do not multiply it by Host retries.
    return { mode: "normal", maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0.1 };
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const settings = await this.#modelSettings.read();
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    }));
  }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) return Promise.reject(new LlmError("antigravity model resolution aborted", "ABORTED"));
    const settings = await this.#modelSettings.read();
    const model = modelFromSettings(settings, modelId);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    };
  }

  async *stream(options) {
    const requestId = this.#runtime.start(options.model, 3);
    let completed = false;
    let releaseRoute;
    try {
      if (options.signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
      const model = modelFromSettings(await this.#modelSettings.read(), options.model);
      let candidates;
      if (typeof this.#store.candidateStoresForModel === "function") candidates = await this.#store.candidateStoresForModel(model, options);
      else {
        const fixed = typeof this.#store.capture === "function" ? await this.#store.capture() : this.#store;
        candidates = fixed ? [fixed] : [];
      }
      // Each eligible account is attempted at most once, and no more than three per call.
      releaseRoute = candidates[0]?.releaseRoute;
      candidates = candidates.slice(0, 3);
      this.#runtime.limit(requestId, candidates.length);
      if (!candidates.length) throw new LlmError("没有可尝试的 Antigravity 账户：请检查登录状态、额度与冷却时间。", "ANTIGRAVITY_NO_ACCOUNT");
      let switchedFrom;
      for (let index = 0; index < candidates.length; index++) {
        if (options.signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
        const requestStore = candidates[index];
        releaseRoute = requestStore.releaseRoute || this.#store.reserveRoute?.(model, requestStore, options);
        const reason = switchedFrom ? "上次尝试触发额度或限流限制，输出前改用此账户" : requestStore.routeReason || "使用已选账户";
        this.#runtime.attempt(requestId, requestStore.accountId, reason, index + 1, switchedFrom);
        const consumer = new AbortController();
        const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
        const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);
        const iterator = requestAntigravityChunks(options, model, watchdog.signal, requestStore)[Symbol.asyncIterator]();
        let started = false, exhausted = false, terminalFailed = false;
        try {
          while (true) {
            const result = await watchdog.next(iterator);
            if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) throw new LlmError("Antigravity stream idle timeout", "TIMEOUT");
            if (result.done) {
              exhausted = true;
              if (!terminalFailed) {
                this.#store.recordRoute?.(model, requestStore.accountId, requestStore.routeSelection, options);
                this.#runtime.succeed(requestId);
              }
              completed = true;
              return;
            }
            const chunk = result.value;
            if (chunk?.type === "finish" && ["error", "aborted"].includes(chunk.reason?.kind)) {
              terminalFailed = true;
              const failure = chunk.reason.kind === "aborted" ? { code: "ABORTED" } : chunk.reason.failure || { message: "Request failed" };
              this.#runtime.fail(requestId, failure, "stream-read", started);
              // A terminal failure is not a success, even if the generator subsequently returns normally.
              completed = true;
            } else if (!started) {
              this.#runtime.output(requestId);
            }
            started = true;
            yield chunk;
            if (terminalFailed) return;
          }
        } catch (error) {
          const failure = options.signal?.aborted ? new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error })
            : timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined ? new LlmError("Antigravity stream idle timeout", "TIMEOUT", { cause: error })
            : error instanceof LlmError ? error : new LlmError(`Antigravity ${started ? "stream-read" : "request-prepare"}: ${safeError(error)}`, classifyAntigravityError(safeError(error)), { cause: error });
          const phase = started ? "stream-read" : /stream-connect/.test(failure.message) ? "stream-connect" : "request-prepare";
          const detail = describeRuntimeFailure(failure, phase, started);
          const retry = detail.safeToRetry && index + 1 < candidates.length && !options.signal?.aborted;
          this.#runtime.fail(requestId, failure, phase, started, retry);
          setLastError(failure, phase);
          if (detail.kind === "quota" || detail.kind === "rate-limit") this.#store.recordQuotaFailure?.(model, requestStore.accountId, requestStore.routeSelection, options);
          if (retry) { switchedFrom = requestStore.accountId; continue; }
          completed = true;
          // Distinct non-retryable code prevents a Host middleware replay after partial output.
          if (started && detail.kind !== "aborted") throw new LlmError(failure.message, "ANTIGRAVITY_PARTIAL_STREAM", { cause: failure });
          throw failure;
        } finally {
          // Release before potentially asynchronous transport cleanup, on every exit path.
          releaseRoute?.();
          releaseRoute = undefined;
          consumer.abort("antigravity stream consumer stopped");
          if (!exhausted) { try { await iterator.return(undefined); } catch { /* cleanup only */ } }
          watchdog[Symbol.dispose]();
        }
      }
    } catch (error) {
      if (!completed) {
        this.#runtime.fail(requestId, error, "account-selection", false);
        setLastError(error, "account-selection");
      }
      completed = true;
      throw error;
    } finally {
      // Also covers cancellation immediately after async candidate selection/setup errors.
      releaseRoute?.();
      if (!completed) this.#runtime.cancel(requestId);
    }
  }
}

// Structural failure summary for clients. No messages, causes, headers or tokens.
function lastDiagnosticsSummary() {
  const current = diagnostics;
  if (!current.error && !current.errorPhase) return undefined;
  return {
    phase: current.errorPhase || undefined,
    kind: current.errorKind || undefined,
    code: current.errorCode || undefined,
    at: current.errorAt || undefined,
  };
}

function doctorText() {
  const current = getAntigravityDiagnostics();
  return [
    `provider=${PROVIDER}`,
    `lastResolvedRuntimeModel=${current.resolvedRuntimeModel || "none"}`,
    `availableModels=${current.availableModels || "none"}`,
    `matchedModel=${current.matchedModelDebug || "none"}`,
    `lastEndpoint=${current.endpoint || "none"}`,
    `lastStatus=${current.status ?? "none"}`,
    `lastProjectId=${current.projectId || "none"}`,
    `lastErrorPhase=${current.errorPhase || "none"}`,
    `lastErrorKind=${current.errorKind || "none"}`,
    `lastErrorCode=${current.errorCode || "none"}`,
    `lastErrorAt=${current.errorAt ? new Date(current.errorAt).toISOString() : "none"}`,
    `lastError=${current.error ? redactSecrets(current.error) : "none"}`,
    `credentialPath=${credentialPath()}`,
    "transport=native-cloud-code-assist-sse",
    "runtimeCli=not-used",
    "commands=/antigravity-login /antigravity-quota /antigravity-doctor /antigravity-logout",
  ].join("\n");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method-not-allowed" });
}

function quotaCardRows(quota) {
  const modelRows = (quota.models || [])
    .filter((model) => !/tab_|chat_/i.test(model.modelId))
    .map((model) => ({
      id: model.modelId,
      label: model.displayName || model.modelId,
      remainingPercent: remainingPercent(model.remainingFraction),
      remainingFraction: model.remainingFraction,
      resetLabel: formatReset(model.resetTime),
      resetTime: model.resetTime,
      provider: model.modelProvider,
      recommended: model.recommended,
      supportsThinking: model.supportsThinking,
      supportsImages: model.supportsImages,
    }));
  const bucketRows = (quota.groups || []).flatMap((group) =>
    (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      group: group.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  );
  const groups = (quota.groups || []).map((group) => ({
    displayName: group.displayName,
    description: group.description,
    buckets: (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  }));
  return { modelRows, bucketRows, groups, groupDescription: quota.groupDescription };
}

function publicModelMatchNeedles(modelId) {
  switch (modelId) {
    case "gemini-3.8-flash":
      return ["gemini-3.8-flash", "gemini 3.8 flash"];
    case "gemini-3.7-flash":
      return ["gemini-3.7-flash", "gemini 3.7 flash"];
    case "gemini-3.6-flash":
      return ["gemini-3.6-flash", "gemini 3.6 flash"];
    case "gemini-3.5-flash":
      return ["gemini-3.5-flash", "gemini 3.5 flash", "gemini-3-flash-agent"];
    case "gemini-3.1-pro":
      return ["gemini-3.1-pro", "gemini 3.1 pro", "gemini-pro-agent"];
    case "claude-sonnet-4-6":
      return ["claude-sonnet-4-6", "claude sonnet 4.6"];
    case "claude-opus-4-6":
      return ["claude-opus-4-6", "claude opus 4.6"];
    case "gpt-oss-120b":
      return ["gpt-oss-120b", "gpt oss 120b"];
    default:
      return [modelId];
  }
}

function rowsForPublicModel(model, quota) {
  if (!quota) return [];
  const { modelRows } = quotaCardRows(quota);
  const needles = publicModelMatchNeedles(model.id);
  return modelRows.filter((row) => {
    const haystack = `${row.id || ""} ${row.label || ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

function publicModelQuotaSummary(model, quota) {
  // Only attribute quota actually matched to this model. A shared vendor name is not proof of a shared limit.
  const rows = rowsForPublicModel(model, quota);
  if (!rows.length) return {};
  const withRemaining = rows.filter((row) => typeof row.remainingFraction === "number");
  const best = (withRemaining.length ? withRemaining : rows).reduce((left, right) => {
    const leftValue = typeof left.remainingFraction === "number" ? left.remainingFraction : -1;
    const rightValue = typeof right.remainingFraction === "number" ? right.remainingFraction : -1;
    return rightValue > leftValue ? right : left;
  });
  return {
    available: true,
    remainingFraction: best.remainingFraction,
    remainingPercent: best.remainingPercent,
    resetLabel: best.resetLabel,
    resetTime: best.resetTime,
  };
}

function modelOptionsPayload(settings, quota) {
  const enabled = enabledModelSet(settings);
  const allModels = [...catalogModelsOf(settings)].sort(compareAntigravityModels);
  const catalogQuotaMap = new Map();
  if (quota?.catalogModels) {
    for (const cm of quota.catalogModels) {
      catalogQuotaMap.set(cm.id, cm);
    }
  }
  const options = allModels.map((model) => {
    const catalogQuota = catalogQuotaMap.get(model.id);
    const fallbackQuota = publicModelQuotaSummary(model, quota);
    const quotaInfo = catalogQuota?.remainingFraction !== undefined
      ? {
          available: true,
          remainingFraction: catalogQuota.remainingFraction,
          remainingPercent: remainingPercent(catalogQuota.remainingFraction),
          resetLabel: catalogQuota.resetTime ? formatReset(catalogQuota.resetTime) : undefined,
          resetTime: catalogQuota.resetTime,
        }
      : fallbackQuota;
    return {
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      reasoningEfforts: model.reasoningEfforts,
      enabled: enabled.has(model.id),
      ...quotaInfo,
    };
  });
  options.sort(compareAntigravityModelOptions);
  return {
    enabledModelIds: [...enabled],
    options,
  };
}

// An equal-account index, not tokens/credits. Unknown or stale values never become zero.
export function aggregatePoolQuota(accounts, now = Date.now()) {
  const eligible = accounts.filter(account => account.hasCredential !== false);
  const definitions = new Map([
    ["bucket:3p-weekly", { label: "Claude / GPT 周限额 · Weekly", kind: "bucket" }],
    ["bucket:3p-5h", { label: "Claude / GPT 5 小时 · 5h", kind: "bucket" }],
  ]);
  const values = eligible.map(account => {
    const map = new Map();
    const add = (id, label, kind, row) => {
      definitions.set(id, { label, kind });
      // Duplicate upstream aliases must not count as multiple accounts.
      if (map.has(id)) return;
      const percent = Number.isFinite(row.remainingPercent) ? row.remainingPercent
        : Number.isFinite(row.remainingFraction) ? row.remainingFraction * 100 : undefined;
      const reset = Date.parse(row.resetTime);
      const expired = Number.isFinite(reset) && reset <= now;
      map.set(id, !account.stale && !account.error && !expired && Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent)) : undefined);
    };
    for (const row of account.bucketRows || []) add(`bucket:${row.id}`, row.id === "3p-weekly"
      ? "Claude / GPT 周限额 · Weekly" : row.id === "3p-5h" ? "Claude / GPT 5 小时 · 5h" : `${row.group || "共享额度"} · ${row.label || row.id}`, "bucket", row);
    for (const row of account.models?.options || []) add(`model:${row.id}`, row.name || row.id, "model", row);
    return map;
  });
  const rows = [...definitions].map(([id, definition]) => {
    const known = values.map(map => map.get(id)).filter(Number.isFinite);
    const totalPercent = known.length ? Math.round(known.reduce((sum, value) => sum + value, 0) * 10) / 10 : null;
    return { id, ...definition, totalPercent, capacityPercent: eligible.length * 100,
      knownCount: known.length, accountCount: eligible.length,
      positiveCount: known.filter(value => value > 0).length,
      complete: eligible.length > 0 && known.length === eligible.length,
      averagePercent: known.length ? totalPercent / known.length : null };
  });
  return { fetchedAt: now, accountCount: eligible.length, accounts, rows, availability: buildPoolAvailability(accounts, now), diagnostics: lastDiagnosticsSummary(), basis: "equal-account",
    note: "每个已登录账户按 100% 等权统计，不代表实际 token 总量；不同套餐容量未校准。周额度与 5 小时额度分别计算，任一用尽均可能限制使用。未知或过期数据不计入已知合计；各账户独立重置。" };
}

const poolQuotaStates = new WeakMap();
export async function fetchPoolQuota(pool, modelSettings, force = false, routingStore) {
  let state = poolQuotaStates.get(pool);
  if (!state) { state = new Map(); poolQuotaStates.set(pool, state); }
  const roster = await pool.list();
  const settings = await modelSettings.read();
  await Promise.all(roster.accounts.filter(account => account.hasCredential !== false).map(async account => {
    let entry = state.get(account.id);
    if (!entry) { entry = { attemptedAt: 0 }; state.set(account.id, entry); }
    const cached = getCachedQuota(account.id);
    const fresh = cached && Date.now() - cached.fetchedAt < 60000;
    if (!entry.flight && (force || (!fresh && Date.now() - entry.attemptedAt >= 60000))) {
      entry.attemptedAt = Date.now();
      entry.flight = fetchAccountQuota(pool.storeFor(account.id)).then(() => { entry.error = undefined; })
        .catch(error => { entry.error = safeError(error); })
        .finally(() => { entry.flight = undefined; });
    }
    if (entry.flight) await entry.flight;
  }));
  // Re-read membership: a removed account must never survive an in-flight refresh in the response.
  const current = await pool.list();
  const liveIds = new Set(current.accounts.map(account => account.id));
  for (const id of state.keys()) if (!liveIds.has(id)) state.delete(id);
  const accounts = current.accounts.map(account => {
    const quota = getCachedQuota(account.id);
    const error = state.get(account.id)?.error;
    return { id: account.id, label: account.label, email: account.email,
      active: account.id === current.activeAccountId, hasCredential: account.hasCredential,
      cooldowns: routingStore?.cooldownsFor?.(account.id) || {},
      fetchedAt: quota?.fetchedAt || 0, stale: account.hasCredential === false || !quota || !!error || Date.now() - quota.fetchedAt >= 120000,
      ...(error ? { error } : {}),
      ...(quota ? quotaCardRows(quota) : { groups: [], bucketRows: [], modelRows: [] }),
      models: modelOptionsPayload(settings, quota) };
  });
  return aggregatePoolQuota(accounts);
}

async function webStatus(store, modelSettings, pool) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
  const pinned = typeof store.capture === "function" ? await store.capture() : store;
  const credentials = await pinned?.read();
  const accountId = pinned?.accountId || null;
  const quota = getCachedQuota(accountId || "legacy");
  const settings = await modelSettings.read();
  const roster = pool ? await pool.list() : undefined;
  if (roster && roster.activeAccountId !== accountId) continue;
  return {
    ...credentialSummary(credentials),
    accountId,
    accounts: roster,
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, quota),
    diagnostics: lastDiagnosticsSummary(),
    quota:
      quota === undefined
        ? undefined
        : {
            accountId: quota.accountId,
            projectId: quota.projectId,
            planLabel: quota.planLabel,
            fetchedAt: quota.fetchedAt,
            ...quotaCardRows(quota),
          },
  };
  }
  throw new Error("Account selection is changing; refresh status again.");
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = safeJsonParse(text);
  if (!isRecord(parsed)) throw new Error("invalid JSON request body");
  return parsed;
}

function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}

function registerWebApi(ctx, store, modelSettings, pool) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/antigravity/api",
          handler: async (request, response) => {
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/antigravity\/api\/?/, "");
            try {
              if (request.method === "POST") {
                const origin = request.headers.origin;
                const host = request.headers.host;
                if (request.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
                  return sendJson(response, 403, { ok: false, error: "Cross-origin account changes are not allowed" });
                }
              }
              if (path === "accounts") {
                if (request.method === "GET") return sendJson(response, 200, { ok: true, value: await pool.list() });
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                if (typeof body.id !== "string" || !body.id) return sendJson(response, 400, { ok: false, error: "An account id is required" });
                const roster = await pool.list();
                if (!roster.accounts.some(a => a.id === body.id)) return sendJson(response, 404, { ok: false, error: "Account not found" });
                if (body.action === "select") {
                  if (getWebLoginStatus().status === "pending") return sendJson(response, 409, { ok: false, error: "Finish the pending account login before switching" });
                  await pool.select(body.id);
                  activeQuotaAccountId = body.id;
                  store.selectionChanged?.(body.id);
                  emitLlmAdaptersUpdated(ctx);
                } else if (body.action === "remove") {
                  if (body.confirm !== true) return sendJson(response, 400, { ok: false, error: "Explicit confirmation required" });
                  if (getWebLoginStatus().status === "pending") return sendJson(response, 409, { ok: false, error: "Finish the pending account login before removing accounts" });
                  await pool.remove(body.id);
                  invalidateAccountQuota(body.id);
                  activeQuotaAccountId = (await pool.list()).activeAccountId;
                  store.selectionChanged?.(activeQuotaAccountId);
                  emitLlmAdaptersUpdated(ctx);
                } else if (body.action === "rename") {
                  await pool.rename(body.id, body.label);
                } else if (body.action === "quota") {
                  const quota = await fetchAccountQuota(pool.storeFor(body.id));
                  return sendJson(response, 200, { ok: true, value: { accountId: body.id, fetchedAt: quota.fetchedAt, ...quotaCardRows(quota) } });
                } else return sendJson(response, 400, { ok: false, error: "Unknown account action" });
                return sendJson(response, 200, { ok: true, value: await pool.list() });
              }
              if (path === "status" || path === "") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, pool) });
              }
              if (path === "runtime-status") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                const roster = pool ? await pool.list() : { accounts: [] };
                return sendJson(response, 200, { ok: true, value: store.runtime?.snapshot(roster.accounts) || { provider: PROVIDER, updatedAt: Date.now(), routes: [], health: { state: "idle" } } });
              }
              if (path === "pool-quota") {
                if (request.method !== "GET" && request.method !== "POST") return sendMethodNotAllowed(response);
                if (!pool) return sendJson(response, 503, { ok: false, error: "Account pool unavailable" });
                return sendJson(response, 200, { ok: true, value: await fetchPoolQuota(pool, modelSettings, request.method === "POST", store) });
              }
              if (path === "login") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const value = await beginWebLogin(store);
                return sendJson(response, 200, { ok: true, value });
              }
              if (path === "quota") {
                if (request.method !== "GET" && request.method !== "POST") {
                  return sendMethodNotAllowed(response);
                }
                const quota = await fetchAccountQuota(store, modelSettings);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, {
                  ok: true,
                  value: {
                    accountId: quota.accountId,
                    projectId: quota.projectId,
                    planLabel: quota.planLabel,
                    fetchedAt: quota.fetchedAt,
                    ...quotaCardRows(quota),
                    models: modelOptionsPayload(await modelSettings.read(), quota),
                  },
                });
              }
              if (path === "models") {
                if (request.method === "GET") {
                  const fixed = await store.capture?.();
                  const accountId = fixed?.accountId || null;
                  return sendJson(response, 200, {
                    ok: true,
                    value: { ...modelOptionsPayload(await modelSettings.read(), getCachedQuota(accountId || "legacy")), accountId },
                  });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  const fixed = await store.capture?.();
                  const accountId = fixed?.accountId || null;
                  const settings = await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: { ...modelOptionsPayload(settings, getCachedQuota(accountId || "legacy")), accountId },
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                if (getWebLoginStatus().status === "pending") return sendJson(response, 409, { ok: false, error: "Finish the pending account login before signing out" });
                await store.delete();
                invalidateAccountQuota();
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, pool) });
              }
              return sendJson(response, 404, { ok: false, error: "not-found" });
            } catch (error) {
              return sendJson(response, 500, { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-antigravity: web api",
    );
  });
}

export function createPoolCredentialStore(pool) {
  const scheduler = new AccountScheduler({ cooldownMs: QUOTA_COOLDOWN_MS });
  const runtime = new RuntimeStatus();
  const cooldownsFor = id => scheduler.cooldownsFor(id);
  return {
    runtime,
    cooldownsFor,
    selectionChanged: id => scheduler.observeSelection(id),
    // Session affinity was already committed at reservation; an older concurrent success
    // must not overwrite a newer low-quota switch. Legacy calls remain success-sticky.
    recordRoute: (model, id, epoch, options = {}) => { if (!options.sessionId) scheduler.bind(model.id, id, undefined, epoch); },
    // A real upstream cooldown is valid even if a manual switch happened during that request.
    recordQuotaFailure: (model, id) => scheduler.recordQuotaFailure(model.id, id),
    reserveRoute: (model, fixed, options = {}) => scheduler.reserve(fixed.accountId, { modelId: model.id, sessionId: options.sessionId, epoch: fixed.routeSelection }),
    candidateStoresForModel: async (model, options = {}) => {
      const roster = await pool.list();
      const accounts = roster.accounts || [];
      const activeId = roster.activeAccountId;
      scheduler.observeSelection(activeId);
      if (!accounts.length || !activeId) return [];
      const snapshots = accounts.map(account => {
        const q = getCachedQuota(account.id);
        const catalog = q?.catalogModels?.find(item => item.id === model.id);
        const modelQuota = catalog?.remainingFraction !== undefined ? catalog : publicModelQuotaSummary(model, q);
        return { ...account, ...(q ? quotaCardRows(q) : {}), fetchedAt: q?.fetchedAt,
          stale: !q || Date.now() - q.fetchedAt >= 120000, error: accountQuotaErrors.has(account.id),
          models: { options: [{ ...modelQuota, id: model.id }] } };
      });
      // Materialize stores before reserving: a storeFor error cannot leak a lease.
      const stores = new Map(accounts.map(account => [account.id, pool.storeFor(account.id)]));
      // select() ranks, pre-binds session affinity and reserves FIRST attempt synchronously.
      // No await may be inserted between ranking and reserve (parallel streams would pick one ID).
      return scheduler.select(snapshots, { modelId: model.id, sessionId: options.sessionId, selection: activeId })
        .map(({ account, decision, epoch, release, reasonCode }) => ({ ...stores.get(account.id), routeSelection: epoch, releaseRoute: release,
          routeReason: decision.state === 'available' ? ({ affinity: '会话亲和，继续使用本会话账户', 'new-balanced': '新会话按额度/(1+并发占用)与最近使用分配', 'low-quota-switch': '会话账户额度不高于10%，提前切换至余量至少高10个百分点的账户', 'legacy-sticky': '沿用所选或最近成功账户' }[reasonCode] || '其他可用账户，保留输出前兜底')
            : decision.state === 'unknown' ? '部分额度未知或过期，排后尝试；由上游确认' : '此账户当前受限，保留兜底尝试' }));
    },
    capture: async () => {
      const fixed = await pool.captureActiveStore();
      activeQuotaAccountId = fixed?.accountId || null;
      return fixed;
    },
    read: async () => (await pool.captureActiveStore())?.read(),
    write: async (credentials) => {
      const id = await pool.upsert(credentials, { select: true });
      scheduler.observeSelection(id);
      activeQuotaAccountId = id;
      invalidateAccountQuota(id);
    },
    modify: async (fn) => {
      const fixed = await pool.captureActiveStore();
      if (!fixed) throw new Error("Select an Antigravity account first");
      return fixed.modify(fn);
    },
    delete: async () => {
      const fixed = await pool.captureActiveStore();
      if (fixed) {
        await fixed.delete();
        scheduler.observeSelection((await pool.list()).activeAccountId);
        invalidateAccountQuota(fixed.accountId);
      }
    },
  };
}

export async function apply(ctx) {
  const pool = new LocalAccountPool(dshHomePath("storages", "antigravity-accounts.json"), new FileCredentialStore(credentialPath()));
  await pool.ensureMigrated();
  activeQuotaAccountId = (await pool.list()).activeAccountId;
  const store = createPoolCredentialStore(pool);
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  const adapter = new AntigravityAdapter(store, modelSettings);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, store, modelSettings, pool);
}

apply.inject = ["llm"];

export default apply;
