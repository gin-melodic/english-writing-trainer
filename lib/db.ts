import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Ability, AbilityHistory, DIMENSIONS, Dimension, Mistake, Settings, TrainingRecord } from "./types";

const DB_PATH = join(process.cwd(), "data", "trainer.db");

function sqlQuote(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql: string, json = false) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const args = json ? ["-json", DB_PATH, sql] : [DB_PATH, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "SQLite 执行失败");
  }
  return result.stdout.trim();
}

export function initDb() {
  runSql(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS abilities (
  dimension TEXT PRIMARY KEY,
  score REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ability_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chinese TEXT NOT NULL,
  answers TEXT NOT NULL,
  grammar_focus TEXT NOT NULL,
  dimension TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  error_types TEXT NOT NULL,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
`);
  const settings = getSettings();
  setSettings(settings);
}

function rows<T>(sql: string): T[] {
  const out = runSql(sql, true);
  return out ? (JSON.parse(out) as T[]) : [];
}

export function getSettings(): Settings {
  const defaults: Settings = {
    baseUrl: "http://localhost:1234",
    model: "",
    temperature: 0.3,
    dailyCount: 20
  };
  const data = rows<{ key: keyof Settings; value: string }>("SELECT key, value FROM settings;");
  for (const item of data) {
    if (item.key === "temperature" || item.key === "dailyCount") {
      (defaults[item.key] as number) = Number(item.value);
    } else {
      defaults[item.key] = item.value;
    }
  }
  return defaults;
}

export function setSettings(settings: Settings) {
  const normalized: Settings = {
    baseUrl: settings.baseUrl || "http://localhost:1234",
    model: settings.model || "",
    temperature: Math.min(1, Math.max(0, Number(settings.temperature) || 0.3)),
    dailyCount: Math.min(50, Math.max(10, Number(settings.dailyCount) || 20))
  };
  const entries = Object.entries(normalized)
    .map(([key, value]) => `(${sqlQuote(key)}, ${sqlQuote(value)})`)
    .join(",");
  runSql(`INSERT OR REPLACE INTO settings(key, value) VALUES ${entries};`);
}

export function getAbilities(): Ability[] {
  const existing = rows<Ability>("SELECT dimension, score FROM abilities ORDER BY dimension;");
  return DIMENSIONS.map((dimension) => ({
    dimension,
    score: Math.round(existing.find((x) => x.dimension === dimension)?.score ?? 0)
  }));
}

export function setAbility(dimension: Dimension, score: number) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const today = new Date().toISOString().slice(0, 10);
  runSql(`
INSERT OR REPLACE INTO abilities(dimension, score) VALUES (${sqlQuote(dimension)}, ${clamped});
INSERT INTO ability_history(date, dimension, score) VALUES (${sqlQuote(today)}, ${sqlQuote(dimension)}, ${clamped});
`);
}

export function clearAbilities() {
  runSql("DELETE FROM abilities; DELETE FROM ability_history;");
}

export function clearAllData() {
  runSql("DELETE FROM settings; DELETE FROM abilities; DELETE FROM ability_history; DELETE FROM mistakes; DELETE FROM sessions;");
  setSettings({ baseUrl: "http://localhost:1234", model: "", temperature: 0.3, dailyCount: 20 });
}

export function getHistory(): AbilityHistory[] {
  return rows<AbilityHistory>(`
SELECT date, dimension, ROUND(AVG(score)) as score
FROM ability_history
WHERE date >= date('now', '-30 day')
GROUP BY date, dimension
ORDER BY date ASC;
`);
}

export function getMistakes(activeOnly = false): Mistake[] {
  const where = activeOnly ? "WHERE correct_streak < 2" : "";
  return rows<Omit<Mistake, "answers" | "error_types"> & { answers: string; error_types: string }>(`
SELECT id, chinese, answers, grammar_focus, dimension, difficulty, error_types, correct_streak, created_at
FROM mistakes ${where}
ORDER BY updated_at DESC, id DESC;
`).map((item) => ({ ...item, answers: JSON.parse(item.answers), error_types: JSON.parse(item.error_types) }));
}

export function addMistake(input: Omit<Mistake, "id" | "correct_streak" | "created_at">) {
  runSql(`
INSERT INTO mistakes(chinese, answers, grammar_focus, dimension, difficulty, error_types, correct_streak)
VALUES (${sqlQuote(input.chinese)}, ${sqlQuote(JSON.stringify(input.answers))}, ${sqlQuote(input.grammar_focus)}, ${sqlQuote(input.dimension)}, ${input.difficulty}, ${sqlQuote(JSON.stringify(input.error_types))}, 0);
`);
}

export function updateMistakeStreak(id: number, correct: boolean) {
  runSql(`
UPDATE mistakes
SET correct_streak = ${correct ? "correct_streak + 1" : "0"}, updated_at = CURRENT_TIMESTAMP
WHERE id = ${Number(id)};
DELETE FROM mistakes WHERE id = ${Number(id)} AND correct_streak >= 2;
`);
}

export function createSession(mode: string, total: number) {
  runSql(`INSERT INTO sessions(mode, total) VALUES (${sqlQuote(mode)}, ${Number(total)});`);
  const [{ id }] = rows<{ id: number }>("SELECT MAX(id) as id FROM sessions;");
  return id;
}

export function updateSession(id: number, correct: boolean) {
  runSql(`
UPDATE sessions
SET completed = completed + 1, correct = correct + ${correct ? 1 : 0}
WHERE id = ${Number(id)};
`);
}

export function endSession(id: number) {
  runSql(`UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ${Number(id)};`);
}

export function getRecords(): TrainingRecord[] {
  return rows<TrainingRecord>(`
SELECT id, date(started_at) as date, mode, completed as total, correct,
  CASE WHEN completed = 0 THEN 0 ELSE ROUND(correct * 100.0 / completed) END as accuracy
FROM sessions
WHERE completed > 0
ORDER BY started_at DESC
LIMIT 50;
`);
}

export function getStreak() {
  const days = rows<{ date: string }>("SELECT DISTINCT date(started_at) as date FROM sessions WHERE completed > 0 ORDER BY date DESC;");
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
