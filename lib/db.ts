import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { calculateAssessmentSkillAbilityUpdates, calculatePracticeReport } from "./assessment";
import { Ability, AbilityHistory, AssessmentMatrixItem, AssessmentReport, CapturedDrill, DIMENSIONS, Dimension, DrillCard, GradeResult, Mistake, PracticeReport, Question, QuestionAnswerRecord, Settings, SkillAbility, TrainingRecord } from "./types";

const DB_PATH = join(process.cwd(), "data", "trainer.db");
const DEFAULT_USER_ID = 1;
const SESSION_DAYS = 30;
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_MODEL = "glm-4.7-flash";
const DEFAULT_PERSONAL_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_PERSONAL_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_WEBLLM_MODEL_BASE_URL = "https://hf-mirror.com";
const DEFAULT_LLM_PROVIDER: Settings["llmProvider"] = "zai";
const FREE_MODEL_CONCURRENCY = 1;
const DEFAULT_PERSONAL_CONCURRENCY = 20;
const MAX_PERSONAL_CONCURRENCY = 20;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
let dbInitialized = false;

export type UserRole = "admin" | "user";

export type AuthUser = {
  id: number;
  username: string;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
};

export type Invite = {
  id: number;
  code: string;
  created_by: number | null;
  used_by: number | null;
  used_at: string | null;
  disabled_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export type SessionUser = AuthUser & {
  session_id: number;
  expires_at: string;
};

export class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

function sqlQuote(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql: string, json = false) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const args = ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...(json ? ["-json"] : []), DB_PATH, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "SQLite 执行失败");
  }
  return result.stdout.trim();
}

function rows<T>(sql: string): T[] {
  const out = runSql(sql, true);
  return out ? (JSON.parse(out) as T[]) : [];
}

function columns(table: string) {
  return rows<{ name: string }>(`PRAGMA table_info(${table});`).map((column) => column.name);
}

function tableExists(table: string) {
  const [row] = rows<{ count: number }>(`SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ${sqlQuote(table)};`);
  return row?.count > 0;
}

function resetLegacyTable(table: string) {
  if (tableExists(table) && !columns(table).includes("user_id")) {
    runSql(`DROP TABLE ${table};`);
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${key}`;
}

function userApiKeyEncryptionSecret() {
  return process.env.USER_API_KEY_ENCRYPTION_SECRET?.trim() || "";
}

function userApiKeyEncryptionKey() {
  const secret = userApiKeyEncryptionSecret();
  if (!secret) throw new AuthError("缺少 USER_API_KEY_ENCRYPTION_SECRET，无法保存个人 API Key。", 500);
  return createHash("sha256").update(secret).digest();
}

function encryptUserApiKey(apiKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", userApiKeyEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptUserApiKey(value: string) {
  const [version, ivText, tagText, encryptedText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) return "";
  const decipher = createDecipheriv("aes-256-gcm", userApiKeyEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, salt, key] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function ensureAdminUser() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!username || !password) return;
  validateUsername(username);
  validatePassword(password);
  const existing = getUserByUsername(username);
  if (existing) return;
  createUser({ username, password, role: "admin" });
}

function ensureSettingsDefaults() {
  setSettings(getSettings(), "admin");
}

function normalizeLlmConcurrency(value: unknown, fallback = FREE_MODEL_CONCURRENCY) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_PERSONAL_CONCURRENCY, Math.round(parsed)))
    : fallback;
}

export function initDb() {
  if (dbInitialized) {
    ensureAdminUser();
    return;
  }
  runSql(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions_auth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER,
  used_by INTEGER,
  used_at TEXT,
  disabled_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`);
  for (const table of [
    "abilities",
    "ability_history",
    "skill_abilities",
    "skill_ability_history",
    "mistakes",
    "captured_drills",
    "sessions",
    "question_answers",
    "assessment_reports"
  ]) {
    resetLegacyTable(table);
  }
  runSql(`
CREATE TABLE IF NOT EXISTS abilities (
  user_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, dimension)
);
CREATE TABLE IF NOT EXISTS ability_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS skill_abilities (
  user_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  skill TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, dimension, skill)
);
CREATE TABLE IF NOT EXISTS skill_ability_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  skill TEXT NOT NULL,
  score REAL NOT NULL,
  evidence_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chinese TEXT NOT NULL,
  answers TEXT NOT NULL,
  vocabulary_tips TEXT NOT NULL DEFAULT '[]',
  grammar_focus TEXT NOT NULL,
  dimension TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  difficulty INTEGER NOT NULL,
  error_types TEXT NOT NULL,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS captured_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source_cn TEXT NOT NULL,
  casual TEXT NOT NULL,
  standard TEXT NOT NULL,
  vivid TEXT NOT NULL,
  reference_en TEXT NOT NULL,
  grammar_dimension TEXT NOT NULL,
  common_mistake TEXT NOT NULL,
  memory_hook TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user_capture',
  difficulty INTEGER NOT NULL DEFAULT 45,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS question_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  question_json TEXT NOT NULL,
  user_answer TEXT NOT NULL,
  result_json TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assessment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  matrix_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  weak_points_json TEXT NOT NULL,
  recommendations_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
  const mistakeColumns = columns("mistakes");
  if (!mistakeColumns.includes("vocabulary_tips")) {
    runSql("ALTER TABLE mistakes ADD COLUMN vocabulary_tips TEXT NOT NULL DEFAULT '[]';");
  }
  if (!mistakeColumns.includes("skills")) {
    runSql("ALTER TABLE mistakes ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';");
  }
  ensureSettingsDefaults();
  ensureAdminUser();
  cleanupExpiredSessions();
  dbInitialized = true;
}

export function validateUsername(username: string) {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    throw new AuthError("用户名只能包含字母、数字、下划线或短横线，长度 3-32。", 400);
  }
}

export function validatePassword(password: string) {
  if (password.length < 8) throw new AuthError("密码至少需要 8 位。", 400);
}

function normalizeUser(row: AuthUser): AuthUser {
  return { ...row, role: row.role === "admin" ? "admin" : "user" };
}

export function getUserByUsername(username: string): AuthUser | null {
  const [user] = rows<AuthUser>(`
SELECT id, username, role, disabled_at, created_at
FROM users
WHERE lower(username) = lower(${sqlQuote(username)})
LIMIT 1;
`);
  return user ? normalizeUser(user) : null;
}

export function getUserById(id: number): AuthUser | null {
  const [user] = rows<AuthUser>(`
SELECT id, username, role, disabled_at, created_at
FROM users
WHERE id = ${Number(id)}
LIMIT 1;
`);
  return user ? normalizeUser(user) : null;
}

export function createUser(input: { username: string; password: string; role?: UserRole }) {
  const username = input.username.trim();
  validateUsername(username);
  validatePassword(input.password);
  if (getUserByUsername(username)) throw new AuthError("用户名已被使用。", 409);
  const role = input.role === "admin" ? "admin" : "user";
  runSql(`
INSERT INTO users(username, password_hash, role)
VALUES (${sqlQuote(username)}, ${sqlQuote(hashPassword(input.password))}, ${sqlQuote(role)});
`);
  const [{ id }] = rows<{ id: number }>("SELECT MAX(id) as id FROM users;");
  return getUserById(id)!;
}

export function loginUser(username: string, password: string) {
  const [record] = rows<AuthUser & { password_hash: string }>(`
SELECT id, username, password_hash, role, disabled_at, created_at
FROM users
WHERE lower(username) = lower(${sqlQuote(username.trim())})
LIMIT 1;
`);
  if (!record || record.disabled_at || !verifyPassword(password, record.password_hash)) {
    throw new AuthError("用户名或密码错误。", 401);
  }
  return normalizeUser(record);
}

export function createAuthSession(userId: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  runSql(`
INSERT INTO sessions_auth(user_id, token_hash, expires_at)
VALUES (${Number(userId)}, ${sqlQuote(hashToken(token))}, ${sqlQuote(expiresAt)});
`);
  return { token, expiresAt };
}

export function getSessionUser(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const [user] = rows<SessionUser>(`
SELECT users.id, users.username, users.role, users.disabled_at, users.created_at, sessions_auth.id as session_id, sessions_auth.expires_at
FROM sessions_auth
JOIN users ON users.id = sessions_auth.user_id
WHERE sessions_auth.token_hash = ${sqlQuote(hashToken(token))}
  AND sessions_auth.expires_at > CURRENT_TIMESTAMP
  AND users.disabled_at IS NULL
LIMIT 1;
`);
  return user ? { ...normalizeUser(user), session_id: user.session_id, expires_at: user.expires_at } : null;
}

export function deleteAuthSession(token: string | undefined | null) {
  if (!token) return;
  runSql(`DELETE FROM sessions_auth WHERE token_hash = ${sqlQuote(hashToken(token))};`);
}

export function deleteUserSessions(userId: number) {
  runSql(`DELETE FROM sessions_auth WHERE user_id = ${Number(userId)};`);
}

export function cleanupExpiredSessions() {
  runSql("DELETE FROM sessions_auth WHERE expires_at <= CURRENT_TIMESTAMP;");
}

export function createInvite(createdBy: number, expiresAt?: string | null) {
  const code = randomBytes(18).toString("base64url");
  runSql(`
INSERT INTO invites(code, created_by, expires_at)
VALUES (${sqlQuote(code)}, ${Number(createdBy)}, ${expiresAt ? sqlQuote(expiresAt) : "NULL"});
`);
  const [{ id }] = rows<{ id: number }>("SELECT MAX(id) as id FROM invites;");
  return getInviteById(id)!;
}

export function getInviteById(id: number) {
  const [invite] = rows<Invite>(`
SELECT id, code, created_by, used_by, used_at, disabled_at, expires_at, created_at
FROM invites
WHERE id = ${Number(id)}
LIMIT 1;
`);
  return invite ?? null;
}

export function getInvites(limit = 50) {
  const normalizedLimit = Math.max(1, Math.min(200, Math.round(limit)));
  return rows<Invite>(`
SELECT id, code, created_by, used_by, used_at, disabled_at, expires_at, created_at
FROM invites
ORDER BY created_at DESC, id DESC
LIMIT ${normalizedLimit};
`);
}

export function disableInvite(id: number) {
  runSql(`
UPDATE invites
SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP)
WHERE id = ${Number(id)} AND used_at IS NULL;
`);
}

export function registerWithInvite(username: string, password: string, code: string) {
  const inviteCode = code.trim();
  const [invite] = rows<Invite>(`
SELECT id, code, created_by, used_by, used_at, disabled_at, expires_at, created_at
FROM invites
WHERE code = ${sqlQuote(inviteCode)}
LIMIT 1;
`);
  if (!invite || invite.used_at || invite.disabled_at || (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now())) {
    throw new AuthError("邀请码无效或已使用。", 400);
  }
  const user = createUser({ username, password, role: "user" });
  runSql(`
UPDATE invites
SET used_by = ${Number(user.id)}, used_at = CURRENT_TIMESTAMP
WHERE id = ${Number(invite.id)} AND used_at IS NULL AND disabled_at IS NULL;
`);
  return user;
}

export function listUsers() {
  return rows<AuthUser & { active_sessions: number }>(`
SELECT users.id, users.username, users.role, users.disabled_at, users.created_at, COUNT(sessions_auth.id) as active_sessions
FROM users
LEFT JOIN sessions_auth ON sessions_auth.user_id = users.id AND sessions_auth.expires_at > CURRENT_TIMESTAMP
GROUP BY users.id
ORDER BY users.created_at DESC, users.id DESC;
`).map((user) => ({ ...normalizeUser(user), active_sessions: user.active_sessions }));
}

export function disableUser(id: number) {
  const user = getUserById(id);
  if (!user) throw new AuthError("用户不存在。", 404);
  if (user.role === "admin") throw new AuthError("不能禁用管理员用户。", 400);
  runSql(`UPDATE users SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP) WHERE id = ${Number(id)};`);
  deleteUserSessions(id);
}

export function resetUserPassword(id: number, password: string) {
  validatePassword(password);
  const user = getUserById(id);
  if (!user) throw new AuthError("用户不存在。", 404);
  runSql(`UPDATE users SET password_hash = ${sqlQuote(hashPassword(password))} WHERE id = ${Number(id)};`);
  deleteUserSessions(id);
}

export function getSettings(userId = DEFAULT_USER_ID): Settings {
  const defaults: Settings = {
    llmProvider: DEFAULT_LLM_PROVIDER,
    baseUrl: DEFAULT_GLM_BASE_URL,
    model: DEFAULT_GLM_MODEL,
    temperature: 0.3,
    dailyCount: 20,
    maxConcurrentPredictions: FREE_MODEL_CONCURRENCY,
    personalProviderEnabled: false,
    personalBaseUrl: DEFAULT_PERSONAL_BASE_URL,
    personalModel: DEFAULT_PERSONAL_MODEL,
    personalResponseFormat: "auto",
    webLlmModelBaseUrl: DEFAULT_WEBLLM_MODEL_BASE_URL,
    hasPersonalApiKey: false
  };
  const data = rows<{ key: string; value: string }>("SELECT key, value FROM settings;");
  for (const item of data) {
    if (item.key === "temperature") defaults.temperature = Number(item.value);
    if (item.key === "maxConcurrentPredictions") defaults.maxConcurrentPredictions = normalizeLlmConcurrency(item.value);
    if (item.key === "baseUrl") defaults.baseUrl = item.value;
    if (item.key === "model") defaults.model = item.value;
  }
  if (!defaults.model.trim() || /^qwen/i.test(defaults.model.trim())) {
    defaults.model = DEFAULT_GLM_MODEL;
  }
  const userRows = rows<{ key: string; value: string }>(`
SELECT key, value FROM user_settings WHERE user_id = ${Number(userId)};
`);
  for (const item of userRows) {
    if (item.key === "dailyCount") defaults.dailyCount = Number(item.value);
    if (item.key === "llmProvider" && ["zai", "openai-compatible", "webllm"].includes(item.value)) {
      defaults.llmProvider = item.value as Settings["llmProvider"];
    }
    if (item.key === "personalBaseUrl") defaults.personalBaseUrl = item.value || DEFAULT_PERSONAL_BASE_URL;
    if (item.key === "personalModel") defaults.personalModel = item.value || DEFAULT_PERSONAL_MODEL;
    if (item.key === "personalResponseFormat" && ["auto", "json_object", "json_schema", "none"].includes(item.value)) {
      defaults.personalResponseFormat = item.value as Settings["personalResponseFormat"];
    }
    if (item.key === "webLlmModelBaseUrl") defaults.webLlmModelBaseUrl = item.value || DEFAULT_WEBLLM_MODEL_BASE_URL;
    if (item.key === "personalApiKeyEncrypted") defaults.hasPersonalApiKey = Boolean(item.value);
  }
  if (defaults.hasPersonalApiKey && defaults.llmProvider === "zai") {
    defaults.llmProvider = "openai-compatible";
  }
  defaults.personalProviderEnabled = defaults.llmProvider !== "zai" && (defaults.hasPersonalApiKey || defaults.llmProvider === "webllm");
  if (defaults.personalProviderEnabled) {
    defaults.maxConcurrentPredictions = defaults.maxConcurrentPredictions > FREE_MODEL_CONCURRENCY
      ? normalizeLlmConcurrency(defaults.maxConcurrentPredictions, DEFAULT_PERSONAL_CONCURRENCY)
      : DEFAULT_PERSONAL_CONCURRENCY;
  } else {
    defaults.maxConcurrentPredictions = FREE_MODEL_CONCURRENCY;
  }
  return defaults;
}

export function getUserPersonalApiKey(userId = DEFAULT_USER_ID) {
  const [row] = rows<{ value: string }>(`
SELECT value FROM user_settings WHERE user_id = ${Number(userId)} AND key = 'personalApiKeyEncrypted' LIMIT 1;
`);
  if (!row?.value) return "";
  return decryptUserApiKey(row.value);
}

export type RuntimeSettings = Settings & {
  personalApiKey?: string;
  userId: number;
};

export function getRuntimeSettings(userId = DEFAULT_USER_ID): RuntimeSettings {
  const settings = getSettings(userId) as RuntimeSettings;
  settings.userId = userId;
  if (settings.hasPersonalApiKey) {
    settings.personalApiKey = getUserPersonalApiKey(userId);
  }
  return settings;
}

export function setSettings(settings: Settings & { personalApiKey?: string; clearPersonalApiKey?: boolean }, actorRole: UserRole = "user", userId = DEFAULT_USER_ID) {
  const current = getSettings(userId);
  const requestedProvider = ["zai", "openai-compatible", "webllm"].includes(String(settings.llmProvider))
    ? settings.llmProvider
    : current.llmProvider;
  const normalized: Settings = {
    llmProvider: requestedProvider,
    baseUrl: actorRole === "admin" ? settings.baseUrl || DEFAULT_GLM_BASE_URL : current.baseUrl,
    model: actorRole === "admin" ? settings.model || DEFAULT_GLM_MODEL : current.model,
    temperature: actorRole === "admin" ? Math.min(1, Math.max(0, Number(settings.temperature) || 0.3)) : current.temperature,
    dailyCount: Math.min(50, Math.max(10, Number(settings.dailyCount) || 20)),
    maxConcurrentPredictions: actorRole === "admin"
      ? normalizeLlmConcurrency(settings.maxConcurrentPredictions, current.maxConcurrentPredictions)
      : current.maxConcurrentPredictions,
    personalProviderEnabled: requestedProvider !== "zai" && (requestedProvider === "webllm" || current.hasPersonalApiKey || Boolean(settings.personalApiKey?.trim())),
    personalBaseUrl: String(settings.personalBaseUrl || DEFAULT_PERSONAL_BASE_URL).trim() || DEFAULT_PERSONAL_BASE_URL,
    personalModel: String(settings.personalModel || DEFAULT_PERSONAL_MODEL).trim() || DEFAULT_PERSONAL_MODEL,
    webLlmModelBaseUrl: String(settings.webLlmModelBaseUrl || DEFAULT_WEBLLM_MODEL_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_WEBLLM_MODEL_BASE_URL,
    personalResponseFormat: ["auto", "json_object", "json_schema", "none"].includes(String(settings.personalResponseFormat))
      ? settings.personalResponseFormat as Settings["personalResponseFormat"]
      : current.personalResponseFormat,
    hasPersonalApiKey: current.hasPersonalApiKey
  };
  if (actorRole === "admin") {
    const globalEntries = [
      ["baseUrl", normalized.baseUrl],
      ["model", normalized.model],
      ["temperature", normalized.temperature],
      ["maxConcurrentPredictions", normalized.maxConcurrentPredictions]
    ]
      .map(([key, value]) => `(${sqlQuote(key)}, ${sqlQuote(value)})`)
      .join(",");
    runSql(`INSERT OR REPLACE INTO settings(key, value) VALUES ${globalEntries};`);
  }
  runSql(`
INSERT OR REPLACE INTO user_settings(user_id, key, value)
VALUES (${Number(userId)}, 'dailyCount', ${sqlQuote(normalized.dailyCount)});
`);
  const userEntries = [
    ["llmProvider", normalized.llmProvider],
    ["personalProviderEnabled", normalized.personalProviderEnabled ? "true" : "false"],
    ["personalBaseUrl", normalized.personalBaseUrl],
    ["personalModel", normalized.personalModel],
    ["webLlmModelBaseUrl", normalized.webLlmModelBaseUrl],
    ["personalResponseFormat", normalized.personalResponseFormat || "auto"]
  ]
    .map(([key, value]) => `(${Number(userId)}, ${sqlQuote(key)}, ${sqlQuote(value)})`)
    .join(",");
  runSql(`INSERT OR REPLACE INTO user_settings(user_id, key, value) VALUES ${userEntries};`);
  if (settings.clearPersonalApiKey) {
    runSql(`DELETE FROM user_settings WHERE user_id = ${Number(userId)} AND key = 'personalApiKeyEncrypted';`);
    normalized.personalProviderEnabled = normalized.llmProvider === "webllm";
  }
  if (typeof settings.personalApiKey === "string" && settings.personalApiKey.trim()) {
    runSql(`
INSERT OR REPLACE INTO user_settings(user_id, key, value)
VALUES (${Number(userId)}, 'personalApiKeyEncrypted', ${sqlQuote(encryptUserApiKey(settings.personalApiKey.trim()))});
`);
    normalized.personalProviderEnabled = true;
  }
  if (normalized.llmProvider === "zai") {
    normalized.personalProviderEnabled = false;
  }
  runSql(`
INSERT OR REPLACE INTO user_settings(user_id, key, value)
VALUES (${Number(userId)}, 'personalProviderEnabled', ${sqlQuote(normalized.personalProviderEnabled ? "true" : "false")});
`);
}

export function getAbilities(userId = DEFAULT_USER_ID): Ability[] {
  const existing = rows<Ability>(`
SELECT dimension, ROUND(score, 2) as score, evidence_count
FROM abilities
WHERE user_id = ${Number(userId)}
ORDER BY dimension;
`);
  return DIMENSIONS.map((dimension) => ({
    dimension,
    score: Number((existing.find((x) => x.dimension === dimension)?.score ?? 50).toFixed(2)),
    evidence_count: Math.max(0, Math.round(Number(existing.find((x) => x.dimension === dimension)?.evidence_count) || 0))
  }));
}

export function setAbility(dimension: Dimension, score: number, evidenceCount = 1, userId = DEFAULT_USER_ID) {
  const clamped = Number(Math.max(0, Math.min(100, score)).toFixed(2));
  const normalizedEvidenceCount = Math.max(0, Math.round(Number(evidenceCount) || 0));
  const today = new Date().toISOString().slice(0, 10);
  runSql(`
INSERT OR REPLACE INTO abilities(user_id, dimension, score, evidence_count) VALUES (${Number(userId)}, ${sqlQuote(dimension)}, ${clamped}, ${normalizedEvidenceCount});
INSERT INTO ability_history(user_id, date, dimension, score, evidence_count) VALUES (${Number(userId)}, ${sqlQuote(today)}, ${sqlQuote(dimension)}, ${clamped}, ${normalizedEvidenceCount});
`);
}

export function getSkillAbilities(userId = DEFAULT_USER_ID): SkillAbility[] {
  return rows<SkillAbility>(`
SELECT dimension, skill, ROUND(score, 2) as score, evidence_count, updated_at
FROM skill_abilities
WHERE user_id = ${Number(userId)}
ORDER BY score ASC, evidence_count DESC, updated_at DESC;
`).filter((item) => (DIMENSIONS as readonly string[]).includes(item.dimension) && item.skill.trim());
}

export function setSkillAbility(input: Pick<SkillAbility, "dimension" | "skill" | "score" | "evidence_count">, userId = DEFAULT_USER_ID) {
  const skill = input.skill.trim();
  if (!skill) return;
  const clamped = Number(Math.max(0, Math.min(100, input.score)).toFixed(2));
  const evidenceCount = Math.max(1, Math.round(Number(input.evidence_count) || 1));
  const today = new Date().toISOString().slice(0, 10);
  runSql(`
INSERT INTO skill_abilities(user_id, dimension, skill, score, evidence_count, updated_at)
VALUES (${Number(userId)}, ${sqlQuote(input.dimension)}, ${sqlQuote(skill)}, ${clamped}, ${evidenceCount}, CURRENT_TIMESTAMP)
ON CONFLICT(user_id, dimension, skill) DO UPDATE SET
  score = excluded.score,
  evidence_count = excluded.evidence_count,
  updated_at = CURRENT_TIMESTAMP;
INSERT INTO skill_ability_history(user_id, date, dimension, skill, score, evidence_count)
VALUES (${Number(userId)}, ${sqlQuote(today)}, ${sqlQuote(input.dimension)}, ${sqlQuote(skill)}, ${clamped}, ${evidenceCount});
`);
}

export function backfillSkillAbilitiesFromAnswers(userId = DEFAULT_USER_ID) {
  const [{ skillCount }] = rows<{ skillCount: number }>(`SELECT COUNT(*) as skillCount FROM skill_abilities WHERE user_id = ${Number(userId)};`);
  if (skillCount > 0) return;
  const [{ answerCount }] = rows<{ answerCount: number }>(`SELECT COUNT(*) as answerCount FROM question_answers WHERE user_id = ${Number(userId)};`);
  if (answerCount < 1) return;
  const records = getAllQuestionAnswers(userId);
  for (const update of calculateAssessmentSkillAbilityUpdates([], records)) {
    setSkillAbility(update, userId);
  }
}

export function clearAbilities(userId = DEFAULT_USER_ID) {
  runSql(`
DELETE FROM abilities WHERE user_id = ${Number(userId)};
DELETE FROM ability_history WHERE user_id = ${Number(userId)};
DELETE FROM skill_abilities WHERE user_id = ${Number(userId)};
DELETE FROM skill_ability_history WHERE user_id = ${Number(userId)};
DELETE FROM assessment_reports WHERE user_id = ${Number(userId)};
`);
}

export function clearAllData(userId = DEFAULT_USER_ID) {
  runSql(`
DELETE FROM abilities WHERE user_id = ${Number(userId)};
DELETE FROM ability_history WHERE user_id = ${Number(userId)};
DELETE FROM skill_abilities WHERE user_id = ${Number(userId)};
DELETE FROM skill_ability_history WHERE user_id = ${Number(userId)};
DELETE FROM mistakes WHERE user_id = ${Number(userId)};
DELETE FROM captured_drills WHERE user_id = ${Number(userId)};
DELETE FROM sessions WHERE user_id = ${Number(userId)};
DELETE FROM question_answers WHERE user_id = ${Number(userId)};
DELETE FROM assessment_reports WHERE user_id = ${Number(userId)};
DELETE FROM user_settings WHERE user_id = ${Number(userId)};
`);
  setSettings({
    llmProvider: DEFAULT_LLM_PROVIDER,
    baseUrl: DEFAULT_GLM_BASE_URL,
    model: DEFAULT_GLM_MODEL,
    temperature: 0.3,
    dailyCount: 20,
    maxConcurrentPredictions: FREE_MODEL_CONCURRENCY,
    personalProviderEnabled: false,
    personalBaseUrl: DEFAULT_PERSONAL_BASE_URL,
    personalModel: DEFAULT_PERSONAL_MODEL,
    personalResponseFormat: "auto",
    webLlmModelBaseUrl: DEFAULT_WEBLLM_MODEL_BASE_URL,
    hasPersonalApiKey: false
  }, "admin", userId);
}

export function getHistory(userId = DEFAULT_USER_ID): AbilityHistory[] {
  return rows<AbilityHistory>(`
SELECT date, dimension, ROUND(AVG(score), 2) as score, ROUND(AVG(evidence_count)) as evidence_count
FROM ability_history
WHERE user_id = ${Number(userId)} AND date >= date('now', '-30 day')
GROUP BY date, dimension
ORDER BY date ASC;
`);
}

export function getMistakes(activeOnly = false, userId = DEFAULT_USER_ID): Mistake[] {
  const where = activeOnly ? "AND correct_streak < 2" : "";
  return rows<Omit<Mistake, "answers" | "vocabulary_tips" | "skills" | "error_types"> & { answers: string; vocabulary_tips: string; skills: string; error_types: string }>(`
SELECT id, chinese, answers, vocabulary_tips, grammar_focus, dimension, skills, difficulty, error_types, correct_streak, created_at
FROM mistakes
WHERE user_id = ${Number(userId)} ${where}
ORDER BY updated_at DESC, id DESC;
`).map((item) => ({
    ...item,
    answers: JSON.parse(item.answers),
    vocabulary_tips: JSON.parse(item.vocabulary_tips),
    skills: JSON.parse(item.skills),
    error_types: JSON.parse(item.error_types)
  }));
}

export function addMistake(input: Omit<Mistake, "id" | "correct_streak" | "created_at">, userId = DEFAULT_USER_ID) {
  runSql(`
INSERT INTO mistakes(user_id, chinese, answers, vocabulary_tips, grammar_focus, dimension, skills, difficulty, error_types, correct_streak)
VALUES (${Number(userId)}, ${sqlQuote(input.chinese)}, ${sqlQuote(JSON.stringify(input.answers))}, ${sqlQuote(JSON.stringify(input.vocabulary_tips ?? []))}, ${sqlQuote(input.grammar_focus)}, ${sqlQuote(input.dimension)}, ${sqlQuote(JSON.stringify(input.skills ?? []))}, ${input.difficulty}, ${sqlQuote(JSON.stringify(input.error_types))}, 0);
`);
}

export function updateMistakeStreak(id: number, correct: boolean, userId = DEFAULT_USER_ID) {
  runSql(`
UPDATE mistakes
SET correct_streak = ${correct ? "correct_streak + 1" : "0"}, updated_at = CURRENT_TIMESTAMP
WHERE id = ${Number(id)} AND user_id = ${Number(userId)};
DELETE FROM mistakes WHERE id = ${Number(id)} AND user_id = ${Number(userId)} AND correct_streak >= 2;
`);
}

function capturedDrillToQuestion(item: CapturedDrill): Question {
  return {
    chinese: item.source_cn,
    answers: [item.reference_en],
    grammar_focus: item.common_mistake,
    dimension: item.grammar_dimension,
    skills: item.common_mistake ? [item.common_mistake] : [],
    rubric_points: [
      `自然口语：${item.casual}`,
      `标准表达：${item.standard}`,
      `生动表达：${item.vivid}`,
      `记忆钩子：${item.memory_hook}`
    ],
    difficulty: item.difficulty,
    origin: "user_capture",
    captureId: item.id
  };
}

export function addCapturedDrill(card: DrillCard, userId = DEFAULT_USER_ID) {
  runSql(`
INSERT INTO captured_drills(user_id, source_cn, casual, standard, vivid, reference_en, grammar_dimension, common_mistake, memory_hook, origin, difficulty, correct_streak)
VALUES (${Number(userId)}, ${sqlQuote(card.source_cn)}, ${sqlQuote(card.casual)}, ${sqlQuote(card.standard)}, ${sqlQuote(card.vivid)}, ${sqlQuote(card.reference_en)}, ${sqlQuote(card.grammar_dimension)}, ${sqlQuote(card.common_mistake)}, ${sqlQuote(card.memory_hook)}, 'user_capture', 45, 0);
`);
  const [{ id }] = rows<{ id: number }>(`SELECT MAX(id) as id FROM captured_drills WHERE user_id = ${Number(userId)};`);
  return id;
}

export function getCapturedDrills(activeOnly = false, userId = DEFAULT_USER_ID): CapturedDrill[] {
  const where = activeOnly ? "AND correct_streak < 2" : "";
  return rows<CapturedDrill>(`
SELECT id, source_cn, casual, standard, vivid, reference_en, grammar_dimension, common_mistake, memory_hook, origin, difficulty, correct_streak, created_at, updated_at
FROM captured_drills
WHERE user_id = ${Number(userId)} ${where}
ORDER BY updated_at DESC, id DESC;
`).filter((item) => item.origin === "user_capture" && (DIMENSIONS as readonly string[]).includes(item.grammar_dimension));
}

export function getCapturedDrillQuestions(activeOnly = false, userId = DEFAULT_USER_ID): Question[] {
  return getCapturedDrills(activeOnly, userId).map(capturedDrillToQuestion);
}

export function updateCapturedDrillStreak(id: number, correct: boolean, userId = DEFAULT_USER_ID) {
  runSql(`
UPDATE captured_drills
SET correct_streak = ${correct ? "correct_streak + 1" : "0"}, updated_at = CURRENT_TIMESTAMP
WHERE id = ${Number(id)} AND user_id = ${Number(userId)};
`);
}

export function createSession(mode: string, total: number, userId = DEFAULT_USER_ID) {
  runSql(`INSERT INTO sessions(user_id, mode, total) VALUES (${Number(userId)}, ${sqlQuote(mode)}, ${Number(total)});`);
  const [{ id }] = rows<{ id: number }>(`SELECT MAX(id) as id FROM sessions WHERE user_id = ${Number(userId)};`);
  return id;
}

export function updateSession(id: number, correct: boolean, userId = DEFAULT_USER_ID) {
  runSql(`
UPDATE sessions
SET completed = completed + 1, correct = correct + ${correct ? 1 : 0}
WHERE id = ${Number(id)} AND user_id = ${Number(userId)};
`);
}

export function recordQuestionAnswer(input: {
  sessionId: number;
  mode: string;
  questionIndex: number;
  question: Question;
  userAnswer: string;
  result: GradeResult;
  durationSeconds?: number;
}, userId = DEFAULT_USER_ID) {
  runSql(`
INSERT INTO question_answers(user_id, session_id, mode, question_index, question_json, user_answer, result_json, duration_seconds)
VALUES (${Number(userId)}, ${Number(input.sessionId)}, ${sqlQuote(input.mode)}, ${Number(input.questionIndex)}, ${sqlQuote(JSON.stringify(input.question))}, ${sqlQuote(input.userAnswer)}, ${sqlQuote(JSON.stringify(input.result))}, ${Math.max(0, Math.round(input.durationSeconds ?? 0))});
`);
}

export function getQuestionAnswers(sessionId: number, userId = DEFAULT_USER_ID): QuestionAnswerRecord[] {
  return rows<Omit<QuestionAnswerRecord, "question" | "result"> & { question_json: string; result_json: string }>(`
SELECT id, session_id, mode, question_index, question_json, user_answer, result_json, duration_seconds, created_at
FROM question_answers
WHERE session_id = ${Number(sessionId)} AND user_id = ${Number(userId)}
ORDER BY question_index ASC, id ASC;
`).map((item) => ({
    id: item.id,
    session_id: item.session_id,
    mode: item.mode,
    question_index: item.question_index,
    question: JSON.parse(item.question_json) as Question,
    user_answer: item.user_answer,
    result: JSON.parse(item.result_json) as GradeResult,
    duration_seconds: item.duration_seconds,
    created_at: item.created_at
  }));
}

function getAllQuestionAnswers(userId = DEFAULT_USER_ID): QuestionAnswerRecord[] {
  return rows<Omit<QuestionAnswerRecord, "question" | "result"> & { question_json: string; result_json: string }>(`
SELECT id, session_id, mode, question_index, question_json, user_answer, result_json, duration_seconds, created_at
FROM question_answers
WHERE user_id = ${Number(userId)}
ORDER BY id ASC;
`).map((item) => ({
    id: item.id,
    session_id: item.session_id,
    mode: item.mode,
    question_index: item.question_index,
    question: JSON.parse(item.question_json) as Question,
    user_answer: item.user_answer,
    result: JSON.parse(item.result_json) as GradeResult,
    duration_seconds: item.duration_seconds,
    created_at: item.created_at
  }));
}

export function getLatestPracticeReport(mode = "每日练习", userId = DEFAULT_USER_ID): PracticeReport | null {
  const [latest] = rows<{ id: number }>(`
SELECT id
FROM sessions
WHERE user_id = ${Number(userId)} AND mode = ${sqlQuote(mode)} AND completed > 0
ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
LIMIT 1;
`);
  if (!latest) return null;
  return calculatePracticeReport(getQuestionAnswers(latest.id, userId).filter((item) => item.mode === mode));
}

export function addAssessmentReport(input: {
  sessionId: number;
  totalQuestions: number;
  matrix: AssessmentMatrixItem[];
  summary: string;
  weakPoints: string[];
  recommendations: string[];
}, userId = DEFAULT_USER_ID) {
  runSql(`
INSERT INTO assessment_reports(user_id, session_id, total_questions, matrix_json, summary, weak_points_json, recommendations_json)
VALUES (${Number(userId)}, ${Number(input.sessionId)}, ${Number(input.totalQuestions)}, ${sqlQuote(JSON.stringify(input.matrix))}, ${sqlQuote(input.summary)}, ${sqlQuote(JSON.stringify(input.weakPoints))}, ${sqlQuote(JSON.stringify(input.recommendations))});
`);
  const [{ id }] = rows<{ id: number }>(`SELECT MAX(id) as id FROM assessment_reports WHERE user_id = ${Number(userId)};`);
  return id;
}

export function getAssessmentReports(limit = 10, offset = 0, userId = DEFAULT_USER_ID): AssessmentReport[] {
  const normalizedLimit = Math.max(1, Math.min(50, Math.round(limit)));
  const normalizedOffset = Math.max(0, Math.round(offset));
  return rows<Omit<AssessmentReport, "matrix" | "weak_points" | "recommendations"> & { matrix_json: string; weak_points_json: string; recommendations_json: string }>(`
SELECT id, session_id, total_questions, matrix_json, summary, weak_points_json, recommendations_json, created_at
FROM assessment_reports
WHERE user_id = ${Number(userId)}
ORDER BY created_at DESC, id DESC
LIMIT ${normalizedLimit} OFFSET ${normalizedOffset};
`).map((item) => ({
    id: item.id,
    session_id: item.session_id,
    total_questions: item.total_questions,
    matrix: JSON.parse(item.matrix_json) as AssessmentMatrixItem[],
    summary: item.summary,
    weak_points: JSON.parse(item.weak_points_json) as string[],
    recommendations: JSON.parse(item.recommendations_json) as string[],
    created_at: item.created_at
  }));
}

export function getAssessmentReportCount(userId = DEFAULT_USER_ID) {
  const [{ count }] = rows<{ count: number }>(`SELECT COUNT(*) as count FROM assessment_reports WHERE user_id = ${Number(userId)};`);
  return count;
}

export function getLatestAssessmentReportCreatedAt(userId = DEFAULT_USER_ID) {
  const [latest] = rows<{ created_at: string }>(`
SELECT created_at FROM assessment_reports
WHERE user_id = ${Number(userId)}
ORDER BY created_at DESC, id DESC
LIMIT 1;
`);
  return latest?.created_at ?? null;
}

export function endSession(id: number, userId = DEFAULT_USER_ID) {
  runSql(`UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ${Number(id)} AND user_id = ${Number(userId)};`);
}

export function getRecords(userId = DEFAULT_USER_ID): TrainingRecord[] {
  return rows<TrainingRecord>(`
SELECT id, date(started_at) as date, mode, completed as total, correct,
  CASE WHEN completed = 0 THEN 0 ELSE ROUND(correct * 100.0 / completed) END as accuracy
FROM sessions
WHERE user_id = ${Number(userId)} AND completed > 0
ORDER BY started_at DESC
LIMIT 50;
`);
}

export function getStreak(userId = DEFAULT_USER_ID) {
  const days = rows<{ date: string }>(`
SELECT DISTINCT date(started_at) as date
FROM sessions
WHERE user_id = ${Number(userId)} AND completed > 0
ORDER BY date DESC;
`);
  let streak = 0;
  const cursor = new Date();
  for (const day of days) {
    const expected = cursor.toISOString().slice(0, 10);
    if (day.date !== expected) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
