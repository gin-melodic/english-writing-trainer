require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assessmentFindings,
  calculateAssessmentMatrix,
  mergeAssessmentScore
} = require("../lib/assessment.ts");

function record(overrides) {
  return {
    id: 1,
    session_id: 1,
    mode: "能力测评",
    question_index: 0,
    question: {
      chinese: "昨天我完成了作业。",
      answers: ["I finished my homework yesterday."],
      grammar_focus: "一般过去时",
      dimension: "时态",
      difficulty: 50,
      source: "ai"
    },
    user_answer: "I finish my homework yesterday.",
    result: {
      verdict: "partial",
      error_types: [],
      reference_answers: ["I finished my homework yesterday."],
      differences: [],
      explanations: ["时态错误"]
    },
    duration_seconds: 12,
    created_at: "2026-05-28T00:00:00.000Z",
    ...overrides
  };
}

test("calculateAssessmentMatrix weights primary and secondary dimension evidence", () => {
  const matrix = calculateAssessmentMatrix([
    record({
      result: {
        verdict: "partial",
        error_types: ["tense"],
        reference_answers: ["I finished my homework yesterday."],
        differences: [],
        explanations: ["时态需使用过去式"],
        dimension_scores: [
          { dimension: "时态", score: 40, verdict: "wrong", severity: "major", notes: "没有使用过去式" },
          { dimension: "冠词", score: 80, verdict: "correct", severity: "none", notes: "无需冠词" }
        ],
        skill_findings: ["过去式动词不稳定"]
      }
    }),
    record({
      question_index: 1,
      question: {
        chinese: "这本书在桌子上。",
        answers: ["The book is on the table."],
        grammar_focus: "介词 on",
        dimension: "介词搭配",
        secondary_dimensions: ["冠词"],
        difficulty: 50,
        source: "ai"
      },
      result: {
        verdict: "correct",
        error_types: [],
        reference_answers: ["The book is on the table."],
        differences: [],
        explanations: ["表达正确"],
        dimension_scores: [
          { dimension: "介词搭配", score: 90, verdict: "correct", severity: "none", notes: "介词使用正确" },
          { dimension: "冠词", score: 60, verdict: "partial", severity: "minor", notes: "冠词证据较弱" }
        ]
      }
    })
  ]);

  assert.deepEqual(matrix.find((item) => item.dimension === "时态"), {
    dimension: "时态",
    score: 40,
    confidence: 0.25,
    evidence_count: 1
  });
  assert.deepEqual(matrix.find((item) => item.dimension === "介词搭配"), {
    dimension: "介词搭配",
    score: 90,
    confidence: 0.25,
    evidence_count: 1
  });
  assert.deepEqual(matrix.find((item) => item.dimension === "冠词"), {
    dimension: "冠词",
    score: 70,
    confidence: 0.28,
    evidence_count: 2
  });
});

test("calculateAssessmentMatrix falls back to verdict score when dimension scores are absent", () => {
  const matrix = calculateAssessmentMatrix([
    record({
      question: {
        chinese: "如果下雨，我们就待在家。",
        answers: ["If it rains, we will stay at home."],
        grammar_focus: "条件连接词",
        dimension: "连接词",
        secondary_dimensions: ["时态"],
        difficulty: 60,
        source: "ai"
      },
      result: {
        verdict: "wrong",
        error_types: ["conjunction"],
        reference_answers: ["If it rains, we will stay at home."],
        differences: [],
        explanations: ["没有写出 if 条件句"]
      }
    })
  ]);

  assert.equal(matrix.find((item) => item.dimension === "连接词").score, 20);
  assert.equal(matrix.find((item) => item.dimension === "连接词").confidence, 0.25);
  assert.equal(matrix.find((item) => item.dimension === "时态").score, 20);
  assert.equal(matrix.find((item) => item.dimension === "时态").confidence, 0.11);
});

test("mergeAssessmentScore initializes directly and blends existing ability by confidence", () => {
  assert.equal(mergeAssessmentScore(0, 72, 0.5, true), 72);
  assert.equal(mergeAssessmentScore(50, 80, 0, false), 61);
  assert.equal(mergeAssessmentScore(50, 80, 1, false), 74);
});

test("assessmentFindings includes dimension notes and skill findings with question position", () => {
  const findings = assessmentFindings([
    record({
      question_index: 2,
      result: {
        verdict: "partial",
        error_types: [],
        reference_answers: ["I finished my homework yesterday."],
        differences: [],
        explanations: ["时态错误"],
        dimension_scores: [
          { dimension: "时态", score: 45, verdict: "partial", severity: "major", notes: "过去式遗漏" }
        ],
        skill_findings: ["时间状语 yesterday 与动词形式不匹配"]
      }
    })
  ]);

  assert.deepEqual(findings, [
    "第 3 题 时态 - 时态:partial/45 过去式遗漏",
    "第 3 题 时态 - 时间状语 yesterday 与动词形式不匹配"
  ]);
});

test("calculateAssessmentMatrix stays high when normalized correct evidence is high", () => {
  const matrix = calculateAssessmentMatrix([
    record({
      question_index: 0,
      question: {
        chinese: "因为天气很冷，我们待在家里。",
        answers: ["Because it was cold, we stayed home."],
        grammar_focus: "原因状语从句",
        dimension: "连接词",
        secondary_dimensions: ["时态"],
        difficulty: 50,
        source: "ai"
      },
      result: {
        verdict: "correct",
        error_types: [],
        reference_answers: ["Because it was cold, we stayed home."],
        differences: [],
        explanations: ["表达正确"],
        dimension_scores: [
          { dimension: "连接词", score: 100, verdict: "correct", severity: "none", notes: "连接词 because 使用正确" },
          { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "过去时正确" }
        ]
      }
    }),
    record({
      question_index: 1,
      question: {
        chinese: "尽管下雨，孩子们仍然玩得很开心。",
        answers: ["Although it rained, the children still had a great time."],
        grammar_focus: "让步状语从句",
        dimension: "连接词",
        secondary_dimensions: ["时态"],
        difficulty: 60,
        source: "ai"
      },
      result: {
        verdict: "correct",
        error_types: [],
        reference_answers: ["Although it rained, the children still had a great time."],
        differences: [],
        explanations: ["表达正确"],
        dimension_scores: [
          { dimension: "连接词", score: 95, verdict: "correct", severity: "minor", notes: "Despite 替换 Although 可接受" },
          { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "过去时正确" }
        ]
      }
    })
  ]);

  assert.equal(matrix.find((item) => item.dimension === "连接词").score, 98);
  assert.equal(matrix.find((item) => item.dimension === "时态").score, 100);
});

test("calculateAssessmentMatrix detects a core-grammar failure despite secondary correct evidence", () => {
  const matrix = calculateAssessmentMatrix([
    record({
      question: {
        chinese: "这封信昨天被寄出了。",
        answers: ["The letter was sent yesterday."],
        grammar_focus: "一般过去时被动语态",
        dimension: "被动语态",
        secondary_dimensions: ["时态"],
        difficulty: 65,
        source: "ai"
      },
      result: {
        verdict: "partial",
        error_types: ["passive_voice"],
        reference_answers: ["The letter was sent yesterday."],
        differences: ["用户使用主动语态。"],
        explanations: ["应使用 was sent。"],
        dimension_scores: [
          { dimension: "被动语态", score: 20, verdict: "wrong", severity: "major", notes: "没有使用被动语态" },
          { dimension: "时态", score: 80, verdict: "partial", severity: "major", notes: "yesterday 对应过去时间，但谓语结构错误" }
        ]
      }
    })
  ]);

  assert.equal(matrix.find((item) => item.dimension === "被动语态").score, 20);
  assert.equal(matrix.find((item) => item.dimension === "时态").score, 80);
});

test("calculateAssessmentMatrix returns full scores for an all-perfect assessment", () => {
  const perfectRecords = [
    ["时态", ["介词搭配"], "I finished my homework yesterday."],
    ["介词搭配", ["冠词"], "The book is on the table."],
    ["定语从句", ["时态"], "The book that I bought yesterday is very interesting."],
    ["连接词", ["时态"], "Because it was cold, we stayed home."],
    ["被动语态", ["时态"], "The letter was sent yesterday."],
    ["冠词", ["定语从句"], "The boy who lives next door is a student."]
  ].map(([dimension, secondaryDimensions, answer], index) => record({
    question_index: index,
    question: {
      chinese: `满分测试题 ${index + 1}`,
      answers: [answer],
      grammar_focus: `${dimension} 满分锚点`,
      dimension,
      secondary_dimensions: secondaryDimensions,
      difficulty: 70,
      source: "ai"
    },
    user_answer: answer,
    result: {
      verdict: "correct",
      error_types: [],
      reference_answers: [answer],
      differences: [],
      explanations: ["答案完全正确"],
      dimension_scores: [
        { dimension, score: 100, verdict: "correct", severity: "none", notes: "主维度完全正确" },
        ...secondaryDimensions.map((secondaryDimension) => ({
          dimension: secondaryDimension,
          score: 100,
          verdict: "correct",
          severity: "none",
          notes: "次维度完全正确"
        }))
      ]
    }
  }));

  const matrix = calculateAssessmentMatrix(perfectRecords);

  assert.deepEqual(matrix.map((item) => [item.dimension, item.score]), [
    ["时态", 100],
    ["介词搭配", 100],
    ["定语从句", 100],
    ["连接词", 100],
    ["被动语态", 100],
    ["冠词", 100]
  ]);
});
