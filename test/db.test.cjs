const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "english-writing-trainer-db-"));
process.chdir(tmpdir);

require("./setup.cjs");

const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  addCapturedDrill,
  addMistake,
  clearAllData,
  createAuthSession,
  createInvite,
  createUser,
  disableInvite,
  getAbilities,
  getCapturedDrillQuestions,
  getCapturedDrills,
  getHistory,
  getInvites,
  getRuntimeSettings,
  getSettings,
  getMistakes,
  getSessionUser,
  getUserByUsername,
  initDb,
  loginUser,
  registerWithInvite,
  setSettings,
  setAbility,
  updateCapturedDrillStreak,
  verifyPassword
} = require("../lib/db.ts");

beforeEach(() => {
  initDb();
  clearAllData();
});

test("abilities default to neutral scores with no evidence", () => {
  const abilities = getAbilities();

  assert.equal(abilities.length, 6);
  assert.deepEqual(abilities.find((item) => item.dimension === "时态"), {
    dimension: "时态",
    score: 50,
    evidence_count: 0
  });
});

test("setAbility stores score and evidence count in current and history tables", () => {
  setAbility("时态", 42.126, 3);

  assert.deepEqual(getAbilities().find((item) => item.dimension === "时态"), {
    dimension: "时态",
    score: 42.13,
    evidence_count: 3
  });
  assert.deepEqual(getHistory().find((item) => item.dimension === "时态"), {
    date: new Date().toISOString().slice(0, 10),
    dimension: "时态",
    score: 42.13,
    evidence_count: 3
  });
});

test("admin user is created from environment once", () => {
  const oldUsername = process.env.ADMIN_USERNAME;
  const oldPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = "admin_test";
  process.env.ADMIN_PASSWORD = "admin_password_123";
  try {
    initDb();
    initDb();
    const user = getUserByUsername("admin_test");

    assert.equal(user.username, "admin_test");
    assert.equal(user.role, "admin");
  } finally {
    if (oldUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = oldUsername;
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = oldPassword;
  }
});

test("password hashing verifies correct and incorrect passwords", () => {
  const user = createUser({ username: "hash_user", password: "password_123" });

  assert.equal(loginUser("hash_user", "password_123").id, user.id);
  assert.throws(() => loginUser("hash_user", "wrong_password"), /用户名或密码错误/);
  assert.equal(verifyPassword("password_123", "not-a-scrypt-hash"), false);
});

test("invite codes are one-time and disabled invites cannot register", () => {
  const admin = createUser({ username: "invite_admin", password: "password_123", role: "admin" });
  const invite = createInvite(admin.id);
  const user = registerWithInvite("invited_user", "password_123", invite.code);

  assert.equal(user.role, "user");
  assert.throws(() => registerWithInvite("second_user", "password_123", invite.code), /邀请码无效或已使用/);

  const disabled = createInvite(admin.id);
  disableInvite(disabled.id);
  assert.throws(() => registerWithInvite("blocked_user", "password_123", disabled.code), /邀请码无效或已使用/);
  assert.ok(getInvites().some((item) => item.id === invite.id && item.used_by === user.id));
});

test("auth sessions resolve until deleted or user is disabled", () => {
  const user = createUser({ username: "session_user", password: "password_123" });
  const session = createAuthSession(user.id);

  assert.equal(getSessionUser(session.token).username, "session_user");
});

test("personal API keys are encrypted and not returned in public settings", () => {
  const oldSecret = process.env.USER_API_KEY_ENCRYPTION_SECRET;
  process.env.USER_API_KEY_ENCRYPTION_SECRET = "unit-test-secret";
  try {
    const user = createUser({ username: "personal_key_user", password: "password_123" });
    setSettings({
      ...getSettings(user.id),
      personalProviderEnabled: true,
      personalApiKey: "sk-test-personal-key"
    }, user.role, user.id);

    const publicSettings = getSettings(user.id);
    assert.equal(publicSettings.personalProviderEnabled, true);
    assert.equal(publicSettings.hasPersonalApiKey, true);
    assert.equal("personalApiKey" in publicSettings, false);
    assert.equal(getRuntimeSettings(user.id).personalApiKey, "sk-test-personal-key");
  } finally {
    if (oldSecret === undefined) delete process.env.USER_API_KEY_ENCRYPTION_SECRET;
    else process.env.USER_API_KEY_ENCRYPTION_SECRET = oldSecret;
  }
});

test("saving a personal API key requires encryption secret", () => {
  const oldSecret = process.env.USER_API_KEY_ENCRYPTION_SECRET;
  delete process.env.USER_API_KEY_ENCRYPTION_SECRET;
  try {
    const user = createUser({ username: "missing_secret_user", password: "password_123" });
    assert.throws(
      () => setSettings({ ...getSettings(user.id), personalApiKey: "sk-test" }, user.role, user.id),
      /USER_API_KEY_ENCRYPTION_SECRET/
    );
  } finally {
    if (oldSecret === undefined) delete process.env.USER_API_KEY_ENCRYPTION_SECRET;
    else process.env.USER_API_KEY_ENCRYPTION_SECRET = oldSecret;
  }
});

test("training data is isolated by user id", () => {
  const userA = createUser({ username: "isolated_a", password: "password_123" });
  const userB = createUser({ username: "isolated_b", password: "password_123" });

  setAbility("时态", 33, 2, userA.id);
  setAbility("时态", 88, 4, userB.id);
  addMistake({
    chinese: "我昨天去了学校。",
    answers: ["I went to school yesterday."],
    vocabulary_tips: [],
    grammar_focus: "一般过去时",
    dimension: "时态",
    skills: ["一般过去时"],
    difficulty: 40,
    error_types: ["tense"]
  }, userA.id);
  addCapturedDrill(sampleCard(), userB.id);

  assert.equal(getAbilities(userA.id).find((item) => item.dimension === "时态").score, 33);
  assert.equal(getAbilities(userB.id).find((item) => item.dimension === "时态").score, 88);
  assert.equal(getMistakes(false, userA.id).length, 1);
  assert.equal(getMistakes(false, userB.id).length, 0);
  assert.equal(getCapturedDrills(false, userA.id).length, 0);
  assert.equal(getCapturedDrills(false, userB.id).length, 1);
});

function sampleCard() {
  return {
    source_cn: "我今天上午一直在开会，所以报告可能晚点交。",
    casual: "I was in meetings all morning, so I might send the report a bit later.",
    standard: "I was in meetings all morning, so I may submit the report a little later.",
    vivid: "My morning was packed with meetings, so the report may come a little later.",
    reference_en: "I was in meetings all morning, so I may submit the report a little later.",
    grammar_dimension: "连接词",
    common_mistake: "容易把“所以”直译成 so 并连接两个逗号拼接句。",
    memory_hook: "先说原因，再用 so 接结果。"
  };
}

test("initDb creates captured drill storage and reads empty capture pool", () => {
  assert.deepEqual(getCapturedDrills(), []);
  assert.deepEqual(getCapturedDrillQuestions(), []);
});

test("saving and reading a captured drill maps to a practice question", () => {
  const id = addCapturedDrill(sampleCard());

  const drills = getCapturedDrills();
  const questions = getCapturedDrillQuestions();

  assert.equal(drills.length, 1);
  assert.equal(drills[0].id, id);
  assert.equal(drills[0].origin, "user_capture");
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0], {
    chinese: sampleCard().source_cn,
    answers: [sampleCard().reference_en],
    grammar_focus: sampleCard().common_mistake,
    dimension: "连接词",
    skills: [sampleCard().common_mistake],
    rubric_points: [
      `自然口语：${sampleCard().casual}`,
      `标准表达：${sampleCard().standard}`,
      `生动表达：${sampleCard().vivid}`,
      `记忆钩子：${sampleCard().memory_hook}`
    ],
    difficulty: 45,
    origin: "user_capture",
    captureId: id
  });
});

test("updating captured drill streak does not delete saved capture", () => {
  const id = addCapturedDrill(sampleCard());

  updateCapturedDrillStreak(id, true);
  updateCapturedDrillStreak(id, true);

  assert.equal(getCapturedDrills(false).length, 1);
  assert.equal(getCapturedDrills(false)[0].correct_streak, 2);
  assert.equal(getCapturedDrills(true).length, 0);
});
