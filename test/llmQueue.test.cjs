require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const tmpdir = mkdtempSync(join(os.tmpdir(), "english-writing-trainer-queue-"));
process.chdir(tmpdir);

const { enqueue, snapshot } = require("../lib/llmQueue.ts");
const DB_PATH = join(process.cwd(), "data", "trainer.db");

test.after(() => {
  rmSync(tmpdir, { recursive: true, force: true });
});

function sql(value) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const result = spawnSync("sqlite3", ["-cmd", ".timeout 5000", DB_PATH, value], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "SQLite 执行失败");
  }
  return result.stdout.trim();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("platform queue runs tasks serially and snapshots only expose aggregate plus own position", async () => {
  const first = deferred();
  const events = [];

  const taskA = enqueue(async () => {
    events.push("a:start");
    await first.promise;
    events.push("a:end");
    return "a";
  }, 101);
  const taskB = enqueue(async () => {
    events.push("b:start");
    return "b";
  }, 202);
  const taskC = enqueue(async () => {
    events.push("c:start");
    return "c";
  }, 101);

  assert.equal(snapshot(101).runningCount, 1);
  assert.equal(snapshot(101).pendingCount, 2);
  assert.equal(snapshot(101).myPosition, 0);
  assert.equal(snapshot(202).myPosition, 1);
  assert.equal(snapshot(303).myPosition, null);
  assert.deepEqual(events, ["a:start"]);

  first.resolve();
  assert.equal(await taskA, "a");
  assert.equal(await taskB, "b");
  assert.equal(await taskC, "c");
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "c:start"]);
  assert.equal(snapshot(101).state, "idle");
  assert.equal(snapshot(101).pendingCount, 0);

  sql(`
INSERT INTO llm_queue(user_id, owner_pid, status, heartbeat_at, finished_at)
VALUES (404, NULL, 'completed', NULL, datetime('now', '-2 hours'));
`);
  snapshot(404);
  const remaining = Number(sql("SELECT COUNT(*) FROM llm_queue WHERE user_id = 404 AND status = 'completed';"));
  assert.equal(remaining, 1);
  sql("DELETE FROM llm_queue WHERE user_id = 404;");
});
