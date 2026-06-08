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
  clearAllData,
  getAbilities,
  getCapturedDrillQuestions,
  getCapturedDrills,
  getHistory,
  initDb,
  setAbility,
  updateCapturedDrillStreak
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
