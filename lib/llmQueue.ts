import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export type LlmQueueSnapshot = {
  state: "idle" | "processing" | "queued";
  pendingCount: number;
  runningCount: number;
  myPosition: number | null;
  completedCount: number;
  failedCount: number;
};

type QueueTask<T> = {
  id: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const DB_PATH = join(process.cwd(), "data", "trainer.db");
const POLL_MS = 500;
const RUNNING_STALE_SECONDS = 10 * 60;
const HEARTBEAT_STALE_SECONDS = 30;
let queueTableEnsured = false;

function sqlQuote(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql: string, json = false) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const args = json ? ["-cmd", ".timeout 5000", "-json", DB_PATH, sql] : ["-cmd", ".timeout 5000", DB_PATH, sql];
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureQueueTable() {
  if (queueTableEnsured) return;
  runSql(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS llm_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  owner_pid INTEGER,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_queue_status_id ON llm_queue(status, id);
`);
  const queueColumns = rows<{ name: string }>("PRAGMA table_info(llm_queue);").map((column) => column.name);
  if (!queueColumns.includes("owner_pid")) {
    runSql("ALTER TABLE llm_queue ADD COLUMN owner_pid INTEGER;");
  }
  if (!queueColumns.includes("heartbeat_at")) {
    runSql("ALTER TABLE llm_queue ADD COLUMN heartbeat_at TEXT;");
  }
  queueTableEnsured = true;
}

function cleanupStaleRunning() {
  runSql(`
UPDATE llm_queue
SET status = 'failed',
  finished_at = CURRENT_TIMESTAMP,
  error = 'legacy queue task without owner'
WHERE status IN ('queued', 'running')
  AND (owner_pid IS NULL OR heartbeat_at IS NULL);
`);
  const ownedRows = rows<{ id: number; owner_pid: number | null }>(`
SELECT id, owner_pid
FROM llm_queue
WHERE status IN ('queued', 'running') AND owner_pid IS NOT NULL;
`);
  const deadIds = ownedRows
    .filter((row) => {
      try {
        process.kill(Number(row.owner_pid), 0);
        return false;
      } catch {
        return true;
      }
    })
    .map((row) => Number(row.id));
  if (deadIds.length > 0) {
    runSql(`
UPDATE llm_queue
SET status = 'failed',
  finished_at = CURRENT_TIMESTAMP,
  error = 'owner process exited'
WHERE id IN (${deadIds.join(",")});
`);
  }
  runSql(`
UPDATE llm_queue
SET status = 'failed',
  finished_at = CURRENT_TIMESTAMP,
  error = 'stale queue heartbeat'
WHERE status IN ('queued', 'running')
  AND heartbeat_at < datetime('now', '-${HEARTBEAT_STALE_SECONDS} seconds');
UPDATE llm_queue
SET status = 'failed',
  finished_at = CURRENT_TIMESTAMP,
  error = 'stale running task'
WHERE status = 'running'
  AND started_at < datetime('now', '-${RUNNING_STALE_SECONDS} seconds');
DELETE FROM llm_queue
WHERE status IN ('completed', 'failed')
  AND finished_at < datetime('now', '-1 hour');
`);
}

function insertTask(userId?: number | null) {
  ensureQueueTable();
  cleanupStaleRunning();
  const normalizedUserId = Number.isFinite(Number(userId)) ? Number(userId) : null;
  const [{ id }] = rows<{ id: number }>(
    `INSERT INTO llm_queue(user_id, owner_pid, status, heartbeat_at) VALUES (${sqlQuote(normalizedUserId)}, ${process.pid}, 'queued', CURRENT_TIMESTAMP) RETURNING id;`
  );
  return id;
}

function heartbeatTask(id: number) {
  runSql(`
UPDATE llm_queue
SET heartbeat_at = CURRENT_TIMESTAMP
WHERE id = ${Number(id)}
  AND status IN ('queued', 'running');
`);
}

function acquireTask(id: number) {
  ensureQueueTable();
  heartbeatTask(id);
  cleanupStaleRunning();
  const acquired = rows<{ id: number }>(`
UPDATE llm_queue
SET status = 'running', owner_pid = ${process.pid}, heartbeat_at = CURRENT_TIMESTAMP, started_at = CURRENT_TIMESTAMP
WHERE id = ${Number(id)}
  AND status = 'queued'
  AND NOT EXISTS (SELECT 1 FROM llm_queue WHERE status = 'running')
  AND id = (SELECT id FROM llm_queue WHERE status = 'queued' ORDER BY id LIMIT 1)
RETURNING id;
`);
  return acquired.length > 0;
}

function finishTask(id: number, status: "completed" | "failed", error?: unknown) {
  runSql(`
UPDATE llm_queue
SET status = ${sqlQuote(status)},
  finished_at = CURRENT_TIMESTAMP,
  error = ${sqlQuote(error instanceof Error ? error.message : error ? String(error) : null)}
WHERE id = ${Number(id)};
`);
}

async function runWhenReady<T>(task: QueueTask<T>) {
  try {
    while (!acquireTask(task.id)) {
      await delay(POLL_MS);
    }
    const heartbeat = setInterval(() => heartbeatTask(task.id), 5000);
    try {
      const value = await task.run();
      finishTask(task.id, "completed");
      task.resolve(value);
    } catch (error) {
      finishTask(task.id, "failed", error);
      task.reject(error);
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    task.reject(error);
  }
}

export function enqueue<T>(run: () => Promise<T>, userId?: number | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = insertTask(userId);
    void runWhenReady({
      id,
      run,
      resolve,
      reject
    });
  });
}

export function snapshot(userId?: number | null): LlmQueueSnapshot {
  ensureQueueTable();
  const normalizedUserId = Number.isFinite(Number(userId)) ? Number(userId) : null;
  const [{ pendingCount = 0 } = { pendingCount: 0 }] = rows<{ pendingCount: number }>(
    "SELECT COUNT(*) as pendingCount FROM llm_queue WHERE status = 'queued';"
  );
  const [{ runningCount = 0 } = { runningCount: 0 }] = rows<{ runningCount: number }>(
    "SELECT COUNT(*) as runningCount FROM llm_queue WHERE status = 'running';"
  );
  const [{ completedCount = 0 } = { completedCount: 0 }] = rows<{ completedCount: number }>(
    "SELECT COUNT(*) as completedCount FROM llm_queue WHERE status = 'completed';"
  );
  const [{ failedCount = 0 } = { failedCount: 0 }] = rows<{ failedCount: number }>(
    "SELECT COUNT(*) as failedCount FROM llm_queue WHERE status = 'failed';"
  );
  let myPosition: number | null = null;
  if (normalizedUserId !== null) {
    const runningMine = rows<{ id: number }>(
      `SELECT id FROM llm_queue WHERE status = 'running' AND user_id = ${Number(normalizedUserId)} LIMIT 1;`
    );
    if (runningMine.length > 0) {
      myPosition = 0;
    } else {
      const [pendingMine] = rows<{ position: number }>(`
SELECT position FROM (
  SELECT id, user_id, ROW_NUMBER() OVER (ORDER BY id) as position
  FROM llm_queue
  WHERE status = 'queued'
)
WHERE user_id = ${Number(normalizedUserId)}
ORDER BY position
LIMIT 1;
`);
      myPosition = pendingMine?.position ?? null;
    }
  }
  return {
    state: runningCount > 0
      ? pendingCount > 0 ? "queued" : "processing"
      : pendingCount > 0 ? "queued" : "idle",
    pendingCount,
    runningCount,
    myPosition,
    completedCount,
    failedCount
  };
}
