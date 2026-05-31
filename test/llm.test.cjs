require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateAssessmentNarrativeStream, generateQuestion, generateStudyGuide, gradeAnswer } = require("../lib/llm.ts");

function settings() {
  return {
    baseUrl: "http://lmstudio.test",
    model: "qwen3.6",
    temperature: 0.2,
    dailyCount: 10,
    maxConcurrentPredictions: 1
  };
}

function payload() {
  return {
    totalQuestions: 1,
    matrix: [
      { dimension: "时态", score: 60, confidence: 0.25, evidence_count: 1 },
      { dimension: "介词搭配", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "定语从句", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "连接词", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "被动语态", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "冠词", score: 80, confidence: 0, evidence_count: 0 }
    ],
    findings: ["第 1 题 时态 - 过去式不稳定"]
  };
}

function streamResponse(content) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function reasoningOnlyStreamResponse(reasoning) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

test("assessment narrative stream keeps enable_thinking when retrying without stream_options", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) {
      return new Response("unsupported stream_options", { status: 400 });
    }
    return streamResponse(JSON.stringify({
      summary: "本次测评显示时态需要优先巩固。",
      weak_points: ["时态：过去式使用不稳定，需要先复盘基础形式。"],
      recommendations: ["每天做 3 道过去时中译英，并改写正确句。"]
    }));
  };

  try {
    const result = await generateAssessmentNarrativeStream(settings(), payload());

    assert.equal(requests.length, 2);
    assert.equal(requests[0].enable_thinking, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(requests[1].enable_thinking, true);
    assert.equal("stream_options" in requests[1], false);
    assert.equal(result.summary, "本次测评显示时态需要优先巩固。");
  } finally {
    global.fetch = originalFetch;
  }
});

test("assessment narrative stream parses structured JSON from reasoning_content", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return reasoningOnlyStreamResponse(JSON.stringify({
      summary: "流式 reasoning_content 报告成功生成。",
      weak_points: ["时态：过去式使用不稳定，需要先复盘基础形式。"],
      recommendations: ["每天做 3 道过去时中译英，并改写正确句。"]
    }));
  };

  try {
    const result = await generateAssessmentNarrativeStream(settings(), payload());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].enable_thinking, true);
    assert.equal(result.summary, "流式 reasoning_content 报告成功生成。");
  } finally {
    global.fetch = originalFetch;
  }
});

test("assessment narrative stream retries non-stream when reasoning_content is not JSON", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (request.stream) return reasoningOnlyStreamResponse("先分析能力矩阵。");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "非流式报告成功生成。",
            weak_points: ["时态：过去式使用不稳定，需要先复盘基础形式。"],
            recommendations: ["每天做 3 道过去时中译英，并改写正确句。"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await generateAssessmentNarrativeStream(settings(), payload());

    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].enable_thinking, true);
    assert.equal("stream" in requests[1], false);
    assert.equal(requests[1].enable_thinking, true);
    assert.equal(result.summary, "非流式报告成功生成。");
  } finally {
    global.fetch = originalFetch;
  }
});

test("question generation can opt into thinking mode", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            chinese: "昨天我完成了作业。",
            answers: ["I finished my homework yesterday."],
            vocabulary_tips: ["finish", "homework", "yesterday"],
            grammar_focus: "一般过去时",
            secondary_dimensions: ["冠词"],
            skills: ["过去式动词"],
            rubric_points: ["动词使用过去式"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const question = await generateQuestion(
      settings(),
      "时态",
      50,
      true,
      [],
      "",
      "扩展题 1/1",
      { thinking: true }
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].enable_thinking, true);
    assert.equal(requests[0].messages[1].content.includes("/no_think"), false);
    assert.equal(question.chinese, "昨天我完成了作业。");
  } finally {
    global.fetch = originalFetch;
  }
});

test("question generation accepts structured JSON from reasoning_content when content is empty", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
          reasoning_content: JSON.stringify({
            chinese: "这种水果通常只在夏天才能买到。",
            answers: [
              "This kind of fruit is usually only available in summer.",
              "This type of fruit can usually be bought only in the summer."
            ],
            grammar_focus: "被动语态",
            secondary_dimensions: ["时态", "介词搭配"],
            skills: ["一般现在时的被动语态结构"],
            rubric_points: ["正确使用 is/are + past participle。"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const question = await generateQuestion(settings(), "被动语态", 50);

    assert.equal(question.chinese, "这种水果通常只在夏天才能买到。");
    assert.equal(question.answers[0], "This kind of fruit is usually only available in summer.");
    assert.deepEqual(question.secondary_dimensions, ["时态", "介词搭配"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("study guide generation uses outlines without original questions or answers", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: "今天先复习时态和冠词。",
            sections: [{
              title: "一般过去时",
              why_it_matters: "一般过去时是今天需要稳定掌握的核心谓语形式。",
              explanation: "一般过去时表示过去发生的动作，谓语通常使用过去式。",
              key_points: ["先找过去时间线索。"],
              patterns: ["主语 + 动词过去式 + 过去时间。"],
              contrast: ["一般过去时强调过去事实，现在完成时强调现在结果。"],
              examples: ["我昨晚复习了英语。 -> I reviewed English last night."],
              pitfalls: ["不要忘记把动词改成过去式。"],
              drills: [{
                prompt: "把“她昨天打扫了房间”译成英文。",
                answer: "She cleaned the room yesterday.",
                explanation: "yesterday 表明过去时间，clean 用过去式 cleaned。"
              }]
            }],
            checklist: ["先判断时间，再检查谓语形式。"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const guide = await generateStudyGuide(settings(), [{
      dimension: "时态",
      secondary_dimensions: ["冠词"],
      grammar_focus: "一般过去时",
      skills: ["过去式动词"],
      rubric_points: ["动词使用过去式"],
      difficulty: 45,
      chinese: "昨天我完成了作业。",
      answers: ["I finished my homework yesterday."]
    }]);

    const prompt = requests[0].messages.map((message) => message.content).join("\n");
    assert.equal(prompt.includes("昨天我完成了作业"), false);
    assert.equal(prompt.includes("I finished my homework yesterday"), false);
    assert.equal(requests[0].enable_thinking, true);
    assert.equal(guide.sections[0].title, "一般过去时");
    assert.equal(guide.sections[0].drills[0].answer, "She cleaned the room yesterday.");
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading normalizes dimension scores that are returned on a 10 point scale", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "correct",
            error_types: [],
            reference_answers: ["Because it was cold, we stayed home."],
            differences: [],
            explanations: ["答案正确。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "连接词", score: 5, verdict: "correct", severity: "none", notes: "逻辑连接正确。" },
              { dimension: "时态", score: 10, verdict: "correct", severity: "none", notes: "过去时正确。" },
              { dimension: "介词搭配", score: 4, verdict: "correct", severity: "minor", notes: "可接受的小瑕疵。" }
            ],
            skill_findings: []
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await gradeAnswer(settings(), {
      chinese: "因为天气很冷，我们待在家里。",
      answers: ["Because it was cold, we stayed home."],
      grammar_focus: "原因状语从句",
      dimension: "连接词",
      secondary_dimensions: ["时态", "介词搭配"],
      difficulty: 50
    }, "Because it was cold, we stayed home.");

    assert.deepEqual(result.dimension_scores?.map((item) => item.score), [100, 100, 85]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading reconciles contradictory score verdict and severity fields", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "partial",
            error_types: ["tense", "passive"],
            reference_answers: ["The letter was sent yesterday."],
            differences: ["用户没有使用被动语态。"],
            explanations: ["动作承受者作主语时应使用被动语态。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "被动语态", score: 95, verdict: "wrong", severity: "major", notes: "没有使用 was sent。" },
              { dimension: "时态", score: 100, verdict: "partial", severity: "major", notes: "时间 yesterday 已体现，但语态结构错误影响谓语。" },
              { dimension: "冠词", score: 20, verdict: "correct", severity: "minor", notes: "冠词没有明显问题。" },
              { dimension: "介词搭配", score: "not-a-number", verdict: "correct", severity: "none", notes: "未发现介词错误。" }
            ],
            skill_findings: ["被动语态识别不足"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await gradeAnswer(settings(), {
      chinese: "这封信昨天被寄出了。",
      answers: ["The letter was sent yesterday."],
      grammar_focus: "一般过去时被动语态",
      dimension: "被动语态",
      secondary_dimensions: ["时态", "冠词", "介词搭配"],
      difficulty: 65
    }, "Someone sent the letter yesterday.");

    assert.equal(result.verdict, "wrong");
    assert.deepEqual(result.dimension_scores?.map((item) => [item.dimension, item.score]), [
      ["被动语态", 20],
      ["时态", 80],
      ["冠词", 85],
      ["介词搭配", 100]
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading downgrades overall verdict when the primary dimension is only partial", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "correct",
            error_types: [],
            reference_answers: ["The letter was sent yesterday."],
            differences: ["用户使用主动语态，参考答案使用被动语态。"],
            explanations: ["语义正确，但未命中被动语态考点。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "被动语态", score: 75, verdict: "partial", severity: "minor", notes: "未直接使用 was sent。" },
              { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "过去时正确。" }
            ],
            skill_findings: ["被动转换意识不足"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await gradeAnswer(settings(), {
      chinese: "这封信昨天被寄出了。",
      answers: ["The letter was sent yesterday."],
      grammar_focus: "一般过去时被动语态",
      dimension: "被动语态",
      secondary_dimensions: ["时态"],
      difficulty: 65
    }, "Someone sent the letter yesterday.");

    assert.equal(result.verdict, "partial");
    assert.equal(result.dimension_scores?.find((item) => item.dimension === "被动语态")?.score, 75);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading parses structured JSON from reasoning_content when content is empty", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
          reasoning_content: JSON.stringify({
            verdict: "wrong",
            error_types: ["relative_clause"],
            reference_answers: ["The boy who lives next door is my classmate."],
            differences: ["用户没有写出 who 引导的定语从句。"],
            explanations: ["需要用定语从句修饰 the boy。"],
            memory_tip: "先找先行词，再补关系代词。",
            dimension_scores: [
              { dimension: "定语从句", score: 30, verdict: "wrong", severity: "major", notes: "缺少定语从句结构。" }
            ],
            skill_findings: ["关系代词 who 使用不足"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await gradeAnswer(settings(), {
      chinese: "住在隔壁的那个男孩是我的同学。",
      answers: ["The boy who lives next door is my classmate."],
      grammar_focus: "who 引导的限制性定语从句",
      dimension: "定语从句",
      difficulty: 55
    }, "The boy lives next door is my classmate.");

    assert.equal(result.verdict, "wrong");
    assert.equal(result.dimension_scores?.[0].dimension, "定语从句");
    assert.equal(result.dimension_scores?.[0].score, 20);
    assert.deepEqual(result.skill_findings, ["关系代词 who 使用不足"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading preserves a full-score result for a clearly perfect answer", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "correct",
            error_types: [],
            reference_answers: ["The book that I bought yesterday is very interesting."],
            differences: [],
            explanations: ["译文完整、自然，核心语法点全部正确。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "定语从句", score: 100, verdict: "correct", severity: "none", notes: "that 引导的定语从句结构完整。" },
              { dimension: "时态", score: 100, verdict: "correct", severity: "none", notes: "bought 正确体现 yesterday 的过去时间。" },
              { dimension: "冠词", score: 100, verdict: "correct", severity: "none", notes: "The book 特指正确。" }
            ],
            skill_findings: ["限制性定语从句稳定", "一般过去时稳定", "特指冠词稳定"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await gradeAnswer(settings(), {
      chinese: "我昨天买的那本书很有趣。",
      answers: ["The book that I bought yesterday is very interesting."],
      grammar_focus: "that 引导的限制性定语从句",
      dimension: "定语从句",
      secondary_dimensions: ["时态", "冠词"],
      difficulty: 70
    }, "The book that I bought yesterday is very interesting.");

    assert.equal(result.verdict, "correct");
    assert.deepEqual(result.dimension_scores?.map((item) => [item.dimension, item.score]), [
      ["定语从句", 100],
      ["时态", 100],
      ["冠词", 100]
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading preserves CEFR-like score ordering across answer quality levels", async () => {
  const mockScores = [20, 55, 72, 92, 100];
  const expectedBands = [
    ["A1", "wrong", 20],
    ["A2", "partial", 55],
    ["B1", "partial", 72],
    ["B2", "correct", 92],
    ["C1", "correct", 100]
  ];
  let callIndex = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const score = mockScores[callIndex++];
    const verdict = score >= 80 ? "correct" : score >= 45 ? "partial" : "wrong";
    const severity = score >= 80 ? "none" : score >= 45 ? "minor" : "major";
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict,
            error_types: score >= 80 ? [] : ["tense"],
            reference_answers: ["Although he has been working at this company since last year, he still feels that he has a lot to learn."],
            differences: [],
            explanations: [`CEFR-like mocked answer scored ${score}.`],
            memory_tip: "",
            dimension_scores: [
              { dimension: "时态", score, verdict, severity, notes: "按同题不同层级答案质量给分。" },
              { dimension: "连接词", score: Math.min(100, score + 5), verdict, severity, notes: "让步关系表达随层级提升。" }
            ],
            skill_findings: []
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const question = {
      chinese: "虽然他从去年开始一直在这家公司工作，但他仍然觉得自己有很多东西要学。",
      answers: ["Although he has been working at this company since last year, he still feels that he has a lot to learn."],
      grammar_focus: "现在完成进行时与让步状语从句",
      dimension: "时态",
      secondary_dimensions: ["连接词", "介词搭配"],
      difficulty: 80
    };
    const answers = [
      "He work company last year. He have many learn.",
      "He works in this company from last year, but he still feel he has many things learn.",
      "Although he worked at this company since last year, he still feels he has many things to learn.",
      "Although he has worked at this company since last year, he still feels that he has a lot to learn.",
      "Although he has been working at this company since last year, he still feels that he has a great deal to learn."
    ];

    const results = [];
    for (const answer of answers) {
      const result = await gradeAnswer(settings(), question, answer);
      results.push([
        result.verdict,
        result.dimension_scores?.find((item) => item.dimension === "时态")?.score
      ]);
    }

    assert.deepEqual(results.map(([, score]) => score), expectedBands.map(([, , score]) => score));
    assert.deepEqual(results.map(([verdict]) => verdict), expectedBands.map(([, verdict]) => verdict));
  } finally {
    global.fetch = originalFetch;
  }
});
