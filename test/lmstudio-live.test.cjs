require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const { getSettings } = require("../lib/db.ts");
const { gradeAnswer } = require("../lib/llm.ts");

function liveSettings() {
  const settings = getSettings();
  return { ...settings, temperature: 0 };
}

function question(overrides) {
  return {
    chinese: "昨天我完成了作业。",
    answers: ["I finished my homework yesterday."],
    grammar_focus: "一般过去时",
    dimension: "时态",
    difficulty: 50,
    source: "ai",
    ...overrides
  };
}

function primaryScore(result, dimension) {
  return result.dimension_scores?.find((item) => item.dimension === dimension)?.score;
}

async function gradeCefrLikeAnswer(answer) {
  const result = await gradeAnswer(liveSettings(), question({
    chinese: "虽然他从去年开始一直在这家公司工作，但他仍然觉得自己有很多东西要学。",
    answers: ["Although he has been working at this company since last year, he still feels that he has a lot to learn."],
    grammar_focus: "现在完成进行时与让步状语从句",
    dimension: "时态",
    secondary_dimensions: ["连接词", "介词搭配"],
    rubric_points: [
      "用 has/have been doing 或 has/have done 表达从过去持续到现在。",
      "用 although/though/but 等方式清楚表达让步或转折关系。",
      "since last year、at this company、a lot to learn 等搭配自然。"
    ],
    difficulty: 80
  }), answer);
  return {
    verdict: result.verdict,
    score: primaryScore(result, "时态") ?? 0,
    result
  };
}

const liveSkip = process.env.LIVE_LM_STUDIO === "1"
  ? false
  : "Set LIVE_LM_STUDIO=1 to run live LM Studio grading checks.";

test("live LM Studio grading accepts a clearly correct answer", { skip: liveSkip }, async () => {
  const result = await gradeAnswer(liveSettings(), question({}), "I finished my homework yesterday.");

  assert.equal(result.verdict, "correct");
  assert.ok((primaryScore(result, "时态") ?? 0) >= 80);
});

test("live LM Studio grading rejects a clear tense error", { skip: liveSkip }, async () => {
  const result = await gradeAnswer(liveSettings(), question({}), "I finish my homework yesterday.");

  assert.notEqual(result.verdict, "correct");
  assert.ok((primaryScore(result, "时态") ?? 100) < 80);
});

test("live LM Studio grading penalizes missing required passive voice", { skip: liveSkip }, async () => {
  const result = await gradeAnswer(liveSettings(), question({
    chinese: "这封信昨天被寄出了。",
    answers: ["The letter was sent yesterday."],
    grammar_focus: "一般过去时被动语态",
    dimension: "被动语态",
    secondary_dimensions: ["时态"],
    rubric_points: ["必须使用 was/were + past participle 表达被动。"]
  }), "Someone sent the letter yesterday.");

  assert.notEqual(result.verdict, "correct");
  assert.ok((primaryScore(result, "被动语态") ?? 100) < 80);
});

test("live LM Studio grading roughly orders CEFR-like answers by quality", { skip: liveSkip }, async () => {
  const cases = [
    ["A1", "He work company last year. He have many learn."],
    ["A2", "He works in this company from last year, but he still feel he has many things learn."],
    ["B1", "Although he worked at this company since last year, he still feels he has many things to learn."],
    ["B2", "Although he has worked at this company since last year, he still feels that he has a lot to learn."],
    ["C1", "Although he has been working at this company since last year, he still feels that he has a great deal to learn."]
  ];
  const graded = [];
  for (const [level, answer] of cases) {
    graded.push({ level, ...(await gradeCefrLikeAnswer(answer)) });
  }
  const scores = Object.fromEntries(graded.map((item) => [item.level, item.score]));

  assert.ok(scores.A1 < 45, JSON.stringify(graded));
  assert.ok(scores.A2 >= scores.A1, JSON.stringify(graded));
  assert.ok(scores.B1 >= scores.A2, JSON.stringify(graded));
  assert.ok(scores.B2 >= 80, JSON.stringify(graded));
  assert.ok(scores.C1 >= scores.B2, JSON.stringify(graded));
});
