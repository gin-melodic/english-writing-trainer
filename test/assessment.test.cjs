require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assessmentEvidenceDetails,
  assessmentFindings,
  calculateAssessmentSkillAbilityUpdates,
  calculateAssessmentMatrix,
  calculatePracticeReport,
  calculatePracticeAbilityUpdates,
  calculatePracticeSkillAbilityUpdates,
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

test("calculatePracticeReport produces objective daily summary with calibrated partial scores", () => {
  const report = calculatePracticeReport([
    record({
      session_id: 9,
      mode: "每日练习",
      question_index: 0,
      result: {
        verdict: "partial",
        error_types: ["tense"],
        reference_answers: ["I finished my homework yesterday."],
        differences: ["finish 应改为 finished。"],
        explanations: ["过去时间 yesterday 要使用一般过去时。"],
        dimension_scores: [
          { dimension: "时态", score: 30, verdict: "partial", severity: "minor", notes: "时态形式不完整。" }
        ],
        skill_findings: ["一般过去时动词变化不稳定"]
      }
    }),
    record({
      session_id: 9,
      mode: "每日练习",
      question_index: 1,
      question: {
        chinese: "这本书在桌子上。",
        answers: ["The book is on the table."],
        grammar_focus: "介词 on",
        dimension: "介词搭配",
        difficulty: 50,
        source: "ai"
      },
      user_answer: "The book is on the table.",
      result: {
        verdict: "correct",
        error_types: [],
        reference_answers: ["The book is on the table."],
        differences: [],
        explanations: ["表达正确"],
        dimension_scores: [
          { dimension: "介词搭配", score: 96, verdict: "correct", severity: "none", notes: "介词搭配正确。" }
        ]
      }
    }),
    record({
      session_id: 9,
      mode: "每日练习",
      question_index: 2,
      question: {
        chinese: "我没有去上班，因为我感冒了。",
        answers: ["I didn't go to work because I had a cold."],
        grammar_focus: "because 从句",
        dimension: "连接词",
        difficulty: 60,
        source: "ai"
      },
      user_answer: "I didn't go to work because of a cold.",
      result: {
        verdict: "wrong",
        error_types: ["conjunction"],
        reference_answers: ["I didn't go to work because I had a cold."],
        differences: ["because of 后面不是完整从句。"],
        explanations: ["本题要表达原因从句。"],
        dimension_scores: [
          { dimension: "连接词", score: 70, verdict: "wrong", severity: "major", notes: "没有使用 because 引导从句。" }
        ]
      }
    })
  ]);

  assert.equal(report.session_id, 9);
  assert.equal(report.total, 3);
  assert.equal(report.correct, 1);
  assert.equal(report.partial, 1);
  assert.equal(report.wrong, 1);
  assert.equal(report.accuracy, 33);
  assert.equal(report.average_score, 62);
  assert.equal(report.dimension_reports.find((item) => item.dimension === "时态").average_score, 45);
  assert.equal(report.dimension_reports.find((item) => item.dimension === "连接词").average_score, 44);
  assert.ok(report.weaknesses.some((item) => item.includes("连接词")));
  assert.ok(report.recommendations.some((item) => item.includes("一般过去时动词变化不稳定")));
});

test("mergeAssessmentScore initializes directly and blends existing ability by confidence", () => {
  assert.equal(mergeAssessmentScore(0, 72, 0.5, true), 72);
  assert.equal(mergeAssessmentScore(50, 80, 0, false), 61);
  assert.equal(mergeAssessmentScore(50, 80, 1, false), 74);
});

test("calculatePracticeAbilityUpdates uses calibrated evidence instead of fixed point increments", () => {
  const abilities = [
    { dimension: "时态", score: 60 },
    { dimension: "介词搭配", score: 50 },
    { dimension: "定语从句", score: 50 },
    { dimension: "连接词", score: 50 },
    { dimension: "被动语态", score: 50 },
    { dimension: "冠词", score: 50 }
  ];
  const updates = calculatePracticeAbilityUpdates(
    abilities,
    {
      chinese: "这封信昨天被寄出了。",
      answers: ["The letter was sent yesterday."],
      grammar_focus: "一般过去时被动语态",
      dimension: "被动语态",
      secondary_dimensions: ["时态"],
      difficulty: 80
    },
    {
      verdict: "correct",
      error_types: [],
      reference_answers: ["The letter was sent yesterday."],
      differences: [],
      explanations: ["表达正确"],
      dimension_scores: [
        { dimension: "被动语态", score: 100, verdict: "correct", severity: "none", notes: "被动语态完整。" },
        { dimension: "时态", score: 90, verdict: "correct", severity: "minor", notes: "过去时正确。" }
      ]
    },
    "每日练习"
  );

  assert.deepEqual(updates, [
    { dimension: "被动语态", score: 50.31, evidence_count: 1 },
    { dimension: "时态", score: 60.15, evidence_count: 1 }
  ]);
});

test("calculatePracticeAbilityUpdates starts uncovered dimensions from neutral evidence", () => {
  const updates = calculatePracticeAbilityUpdates(
    [],
    {
      chinese: "这本书在桌子上。",
      answers: ["The book is on the table."],
      grammar_focus: "介词 on",
      dimension: "介词搭配",
      difficulty: 30
    },
    {
      verdict: "wrong",
      error_types: ["preposition"],
      reference_answers: ["The book is on the table."],
      differences: ["缺少 on the table。"],
      explanations: ["低难度介词结构未完成。"],
      dimension_scores: [
        { dimension: "介词搭配", score: 20, verdict: "wrong", severity: "major", notes: "介词结构错误。" }
      ]
    },
    "每日练习"
  );

  assert.deepEqual(updates, [{ dimension: "介词搭配", score: 49.71, evidence_count: 1 }]);
});

test("calculatePracticeAbilityUpdates does not reward partial answers", () => {
  const updates = calculatePracticeAbilityUpdates(
    [{ dimension: "连接词", score: 35, evidence_count: 2 }],
    {
      chinese: "我因为感冒没有去上班。",
      answers: ["I didn't go to work because I had a cold."],
      grammar_focus: "because 引导原因状语从句",
      dimension: "连接词",
      secondary_dimensions: ["介词搭配", "冠词", "时态"],
      difficulty: 60
    },
    {
      verdict: "partial",
      error_types: ["conjunction"],
      reference_answers: ["I didn't go to work because I had a cold."],
      differences: ["用户使用 because of 短语，没有使用 because 从句。"],
      explanations: ["题目要求 because + 主谓结构。"],
      dimension_scores: [
        { dimension: "连接词", score: 70, verdict: "partial", severity: "major", notes: "未使用 because 引导原因状语从句。" }
      ]
    },
    "每日练习"
  );

  assert.deepEqual(updates, [{ dimension: "连接词", score: 35, evidence_count: 3 }]);
});

test("calculatePracticeSkillAbilityUpdates updates primary and secondary skill evidence", () => {
  const updates = calculatePracticeSkillAbilityUpdates(
    [
      { dimension: "被动语态", skill: "一般过去时被动结构", score: 50, evidence_count: 1, updated_at: "2026-05-28T00:00:00.000Z" },
      { dimension: "时态", skill: "一般过去时被动结构", score: 60, evidence_count: 2, updated_at: "2026-05-28T00:00:00.000Z" }
    ],
    {
      chinese: "这封信昨天被寄出了。",
      answers: ["The letter was sent yesterday."],
      grammar_focus: "一般过去时被动语态",
      dimension: "被动语态",
      secondary_dimensions: ["时态"],
      skills: ["一般过去时被动结构", "be 动词时态变化"],
      difficulty: 80
    },
    {
      verdict: "wrong",
      error_types: [],
      reference_answers: ["The letter was sent yesterday."],
      differences: ["漏掉被动结构。"],
      explanations: ["应使用 was sent。"],
      dimension_scores: [
        { dimension: "被动语态", score: 20, verdict: "wrong", severity: "major", notes: "被动语态缺失。" },
        { dimension: "时态", score: 75, verdict: "partial", severity: "minor", notes: "时间判断基本正确。" }
      ],
      skill_findings: ["一般过去时被动结构不稳定"]
    },
    "每日练习"
  );

  assert.deepEqual(updates.find((item) => item.dimension === "被动语态" && item.skill === "一般过去时被动结构"), {
    dimension: "被动语态",
    skill: "一般过去时被动结构",
    score: 45.09,
    evidence_count: 3
  });
  assert.deepEqual(updates.find((item) => item.dimension === "时态" && item.skill === "一般过去时被动结构"), {
    dimension: "时态",
    skill: "一般过去时被动结构",
    score: 60,
    evidence_count: 4
  });
});

test("calculatePracticeSkillAbilityUpdates falls back to grammar focus when skills are absent", () => {
  const updates = calculatePracticeSkillAbilityUpdates(
    [],
    {
      chinese: "我昨天学习了。",
      answers: ["I studied yesterday."],
      grammar_focus: "一般过去时",
      dimension: "时态",
      difficulty: 40
    },
    {
      verdict: "correct",
      error_types: [],
      reference_answers: ["I studied yesterday."],
      differences: [],
      explanations: ["表达正确"]
    }
  );

  assert.deepEqual(updates, [{ dimension: "时态", skill: "一般过去时", score: 52.68, evidence_count: 1 }]);
});

test("calculateAssessmentSkillAbilityUpdates accumulates skill evidence across records", () => {
  const updates = calculateAssessmentSkillAbilityUpdates([], [
    record({
      question: {
        chinese: "昨天我完成了作业。",
        answers: ["I finished my homework yesterday."],
        grammar_focus: "一般过去时",
        dimension: "时态",
        skills: ["过去式动词"],
        difficulty: 50,
        source: "ai"
      },
      result: {
        verdict: "wrong",
        error_types: [],
        reference_answers: ["I finished my homework yesterday."],
        differences: [],
        explanations: ["时态错误"],
        dimension_scores: [
          { dimension: "时态", score: 20, verdict: "wrong", severity: "major", notes: "没有使用过去式" }
        ]
      }
    }),
    record({
      question_index: 1,
      question: {
        chinese: "他昨晚打电话给我。",
        answers: ["He called me last night."],
        grammar_focus: "一般过去时",
        dimension: "时态",
        skills: ["过去式动词"],
        difficulty: 50,
        source: "ai"
      },
      result: {
        verdict: "correct",
        error_types: [],
        reference_answers: ["He called me last night."],
        differences: [],
        explanations: ["表达正确"],
        dimension_scores: [
          { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "过去式正确" }
        ]
      }
    })
  ]);

  assert.deepEqual(updates, [{ dimension: "时态", skill: "过去式动词", score: 50.74, evidence_count: 2 }]);
});

test("calculatePracticeAbilityUpdates does not reward easy correct answers for already high ability", () => {
  const updates = calculatePracticeAbilityUpdates(
    [{ dimension: "时态", score: 90 }],
    {
      chinese: "我昨天学习了。",
      answers: ["I studied yesterday."],
      grammar_focus: "一般过去时",
      dimension: "时态",
      difficulty: 35
    },
    {
      verdict: "correct",
      error_types: [],
      reference_answers: ["I studied yesterday."],
      differences: [],
      explanations: ["表达正确"],
      dimension_scores: [
        { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "过去式正确。" }
      ]
    }
  );

  assert.deepEqual(updates, [{ dimension: "时态", score: 90, evidence_count: 1 }]);
});

test("calculatePracticeAbilityUpdates avoids raising low ability after a hard wrong answer", () => {
  const updates = calculatePracticeAbilityUpdates(
    [{ dimension: "定语从句", score: 30 }],
    {
      chinese: "我喜欢昨天买的那本书。",
      answers: ["I like the book that I bought yesterday."],
      grammar_focus: "定语从句",
      dimension: "定语从句",
      difficulty: 85
    },
    {
      verdict: "wrong",
      error_types: ["relative_clause"],
      reference_answers: ["I like the book that I bought yesterday."],
      differences: ["缺少定语从句。"],
      explanations: ["没有写出 that I bought yesterday。"],
      dimension_scores: [
        { dimension: "定语从句", score: 20, verdict: "wrong", severity: "major", notes: "目标结构缺失。" }
      ]
    }
  );

  assert.deepEqual(updates, [{ dimension: "定语从句", score: 30, evidence_count: 1 }]);
});

test("calculatePracticeAbilityUpdates weighs mistake review lower than daily practice", () => {
  const question = {
    chinese: "这封信昨天被寄出了。",
    answers: ["The letter was sent yesterday."],
    grammar_focus: "一般过去时被动语态",
    dimension: "被动语态",
    difficulty: 35
  };
  const result = {
    verdict: "wrong",
    error_types: ["passive_voice"],
    reference_answers: ["The letter was sent yesterday."],
    differences: ["缺少被动语态。"],
    explanations: ["应使用 was sent。"],
    dimension_scores: [
      { dimension: "被动语态", score: 20, verdict: "wrong", severity: "major", notes: "被动语态缺失。" }
    ]
  };
  const daily = calculatePracticeAbilityUpdates([{ dimension: "被动语态", score: 70, evidence_count: 4 }], question, result, "每日练习")[0];
  const review = calculatePracticeAbilityUpdates([{ dimension: "被动语态", score: 70, evidence_count: 4 }], { ...question, source: "mistake" }, result, "错题重练")[0];

  assert.ok(daily.score < review.score);
  assert.equal(daily.evidence_count, 5);
  assert.equal(review.evidence_count, 5);
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

test("assessmentEvidenceDetails keeps structured per-question diagnosis fields", () => {
  const details = assessmentEvidenceDetails([
    record({
      question_index: 2,
      question: {
        chinese: "昨天我完成了作业。",
        answers: ["I finished my homework yesterday."],
        grammar_focus: "一般过去时",
        dimension: "时态",
        secondary_dimensions: ["冠词"],
        skills: ["过去式动词"],
        rubric_points: ["动词必须使用过去式"],
        difficulty: 50,
        source: "ai"
      },
      user_answer: "I finish my homework yesterday.",
      result: {
        verdict: "partial",
        error_types: ["tense"],
        reference_answers: ["I finished my homework yesterday."],
        differences: ["finish 应改为 finished。"],
        explanations: ["yesterday 表示过去时间，动词需要用过去式。"],
        dimension_scores: [
          { dimension: "时态", score: 45, verdict: "partial", severity: "major", notes: "过去式遗漏" }
        ],
        skill_findings: ["时间状语 yesterday 与动词形式不匹配"]
      }
    })
  ]);

  assert.deepEqual(details[0], {
    question_index: 3,
    dimension: "时态",
    secondary_dimensions: ["冠词"],
    difficulty: 50,
    grammar_focus: "一般过去时",
    skills: ["过去式动词"],
    rubric_points: ["动词必须使用过去式"],
    chinese: "昨天我完成了作业。",
    user_answer: "I finish my homework yesterday.",
    reference_answer: "I finished my homework yesterday.",
    verdict: "partial",
    error_types: ["tense"],
    dimension_scores: [
      { dimension: "时态", score: 45, verdict: "partial", severity: "major", notes: "过去式遗漏" }
    ],
    differences: ["finish 应改为 finished。"],
    explanations: ["yesterday 表示过去时间，动词需要用过去式。"],
    skill_findings: ["时间状语 yesterday 与动词形式不匹配"]
  });
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
