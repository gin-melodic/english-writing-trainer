const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "english-writing-trainer-api-"));
process.chdir(tmpdir);

require("./setup.cjs");

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_USERNAME = "api_admin";
process.env.ADMIN_PASSWORD = "api_admin_password";

const { GET: getState } = require("../app/api/state/route.ts");
const { GET: getLlmStatus } = require("../app/api/llm/status/route.ts");
const { GET: getLlmEvents } = require("../app/api/llm/events/route.ts");
const { POST: login } = require("../app/api/auth/login/route.ts");
const { POST: logout } = require("../app/api/auth/logout/route.ts");
const { GET: getAdminInvites } = require("../app/api/admin/invites/route.ts");
const { createAuthSession, createUser, initDb } = require("../lib/db.ts");

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

test("state API requires authentication", async () => {
  initDb();
  const response = await getState(new Request("http://localhost/api/state"));

  assert.equal(response.status, 401);
});

test("LLM queue status and events require authentication", async () => {
  initDb();

  assert.equal((await getLlmStatus(new Request("http://localhost/api/llm/status"))).status, 401);
  assert.equal((await getLlmEvents(new Request("http://localhost/api/llm/events"))).status, 401);
});

test("login sets a session cookie and logout invalidates it", async () => {
  initDb();
  const loginResponse = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "api_admin", password: "api_admin_password" })
  }));
  const cookie = cookieFrom(loginResponse);

  assert.equal(loginResponse.status, 200);
  assert.match(cookie, /^trainer_session=/);
  assert.equal((await getState(new Request("http://localhost/api/state", { headers: { cookie } }))).status, 200);

  const logoutResponse = await logout(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie } }));
  assert.equal(logoutResponse.status, 200);
  assert.equal((await getState(new Request("http://localhost/api/state", { headers: { cookie } }))).status, 401);
});

test("admin routes reject normal users", async () => {
  initDb();
  const user = createUser({ username: "api_normal", password: "password_123" });
  const session = createAuthSession(user.id);
  const response = await getAdminInvites(new Request("http://localhost/api/admin/invites", {
    headers: { cookie: `trainer_session=${encodeURIComponent(session.token)}` }
  }));

  assert.equal(response.status, 403);
});

test("LLM events return SSE headers for authenticated users", async () => {
  initDb();
  const user = createUser({ username: "api_sse_user", password: "password_123" });
  const session = createAuthSession(user.id);
  const response = await getLlmEvents(new Request("http://localhost/api/llm/events", {
    headers: { cookie: `trainer_session=${encodeURIComponent(session.token)}` }
  }));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(response.headers.get("cache-control"), /no-cache/);
  await response.body.cancel();
});
