require("./setup.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateAssessmentNarrativeStream, generateDrillCard, generateQuestion, generateQuestions, generateStudyGuide, gradeAnswer, testConnection } = require("../lib/llm.ts");
const { normalizeErrorTags } = require("../lib/errorTags.ts");
const { publicQuestionSkills } = require("../lib/questionSafety.ts");

process.env.ZAI_API_KEY = "test-api-key";

function settings() {
  return {
    baseUrl: "https://open.bigmodel.test/api/paas/v4",
    model: "glm-4.7-flash",
    temperature: 0.2,
    dailyCount: 10,
    maxConcurrentPredictions: 1
  };
}

function payload() {
  return {
    total_questions: 1,
    matrix: [
      { dimension: "时态", score: 60, confidence: 0.25, evidence_count: 1 },
      { dimension: "介词搭配", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "定语从句", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "连接词", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "被动语态", score: 80, confidence: 0, evidence_count: 0 },
      { dimension: "冠词", score: 80, confidence: 0, evidence_count: 0 }
    ],
    weakest_dimensions: [{ dimension: "时态", score: 60, confidence: 0.25, evidence_count: 1 }],
    insufficient_evidence_dimensions: ["时态", "介词搭配", "定语从句", "连接词", "被动语态", "冠词"],
    top_error_tags: [{ tag: "tense_error", count: 1 }],
    top_skill_findings: [{ skill: "过去式不稳定", count: 1 }]
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

test("public question skills remove answer-revealing formulas", () => {
  assert.deepEqual(publicQuestionSkills([
    "By + 过去时间，主句使用过去完成时 had done",
    "read three chapters of that book 表示部分与整体关系",
    "already 用于完成时态句中",
    "过去完成时判断",
    "完成时态语境"
  ]), ["过去完成时判断"]);
});

test("normalizeErrorTags maps legacy Chinese and English labels", () => {
  assert.deepEqual(normalizeErrorTags([
    "时态错误",
    "冠词缺失",
    "article missing",
    "passive",
    "完全未知",
    "tense"
  ]), ["tense_error", "missing_article", "passive_voice_error", "other"]);
});

test("connection test covers GLM structured, text, thinking, and streaming scenarios", async () => {
  const requests = [];
  const headers = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    headers.push(init.headers);
    if (request.stream) {
      return reasoningOnlyStreamResponse(JSON.stringify({
        summary: "流式测试显示连接正常。",
        weak_points: ["时态：过去式需要继续练习。"],
        recommendations: ["每天做 1 道过去时练习。"]
      }));
    }
    if (!request.response_format) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "连接测试已经正常通过。" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.thinking?.type === "enabled") {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            reasoning_content: JSON.stringify({
              summary: "thinking 测试显示连接正常。",
              weak_points: ["时态：过去式需要继续练习。"],
              recommendations: ["每天做 1 道过去时练习。"]
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await testConnection(settings());

    assert.deepEqual(result.tests.map((item) => [item.key, item.ok]), [
      ["structured_json", true],
      ["structured_thinking", true],
      ["plain_text", true],
      ["streaming", true]
    ]);
    assert.equal(headers[0].Authorization, "Bearer test-api-key");
    assert.equal(requests[0].response_format.type, "json_object");
    assert.match(requests[0].messages[1].content, /connection_test schema/);
    assert.equal(requests[0].thinking.type, "disabled");
    assert.equal(requests[1].thinking.type, "enabled");
    assert.equal(requests[2].response_format, undefined);
    assert.equal(requests[3].stream, true);
    assert.equal(requests[3].thinking.type, "enabled");
    assert.equal("stream_options" in requests[3], false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("personal SiliconFlow settings use personal key and omit Z.ai thinking payload", async () => {
  const requests = [];
  const urls = [];
  const headers = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    urls.push(url);
    requests.push(request);
    headers.push(init.headers);
    if (request.stream) {
      return streamResponse(JSON.stringify({
        summary: "个人模型流式测试正常。",
        weak_points: ["时态：过去式需要继续练习。"],
        recommendations: ["每天做 1 道过去时练习。"]
      }));
    }
    if (!request.response_format) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "个人模型连接正常。" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.messages.some((message) => /connection_test schema/.test(message.content))) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "个人模型测试显示连接正常。",
            weak_points: ["时态：过去式需要继续练习。"],
            recommendations: ["每天做 1 道过去时练习。"]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await testConnection({
      ...settings(),
      personalProviderEnabled: true,
      personalBaseUrl: "https://api.siliconflow.test/v1",
      personalModel: "deepseek-ai/DeepSeek-V4-Flash",
      hasPersonalApiKey: true,
      personalApiKey: "sf-test-key"
    });

    assert.equal(result.tests.every((item) => item.ok), true);
    assert.equal(urls.every((url) => url === "https://api.siliconflow.test/v1/chat/completions"), true);
    assert.equal(headers.every((header) => header.Authorization === "Bearer sf-test-key"), true);
    assert.equal(requests.every((request) => request.model === "deepseek-ai/DeepSeek-V4-Flash"), true);
    assert.equal(requests.every((request) => !("thinking" in request)), true);
    assert.equal(requests.some((request) => request.response_format?.type === "json_object"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("server LLM connection test rejects browser-only WebLLM", async () => {
  await assert.rejects(
    () => testConnection({
      ...settings(),
      llmProvider: "webllm",
      personalProviderEnabled: true,
      personalModel: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
      hasPersonalApiKey: false
    }),
    /WebLLM 只能在浏览器中运行/
  );
});

test("connection test exposes failed response validation details", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (!request.response_format) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await assert.rejects(
      () => testConnection(settings()),
      (error) => {
        assert.match(error.message, /未全部通过/);
        const result = error.connectionTestResult;
        assert.equal(result.tests.find((item) => item.key === "plain_text").ok, false);
        assert.equal(result.tests.find((item) => item.key === "structured_json").ok, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("connection test accepts very short plain text responses", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.stream) {
      return reasoningOnlyStreamResponse(JSON.stringify({
        summary: "流式测试显示连接正常。",
        weak_points: ["时态：过去式需要继续练习。"],
        recommendations: ["每天做 1 道过去时练习。"]
      }));
    }
    if (!request.response_format) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "正常" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.thinking?.type === "enabled") {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "thinking 测试显示连接正常。",
              weak_points: ["时态：过去式需要继续练习。"],
              recommendations: ["每天做 1 道过去时练习。"]
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await testConnection(settings());
    const plainTextTest = result.tests.find((item) => item.key === "plain_text");
    assert.equal(plainTextTest.ok, true);
    assert.match(plainTextTest.detail, /返回 2 个字符/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("assessment narrative stream sends GLM thinking and json mode", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return streamResponse(JSON.stringify({
      summary: "本次测评显示时态需要优先巩固。",
      weak_points: ["时态：过去式使用不稳定，需要先复盘基础形式。"],
      recommendations: ["每天做 3 道过去时中译英，并改写正确句。"]
    }));
  };

  try {
    const result = await generateAssessmentNarrativeStream(settings(), payload());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].thinking.type, "enabled");
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.equal(requests[0].stream, true);
    assert.equal("stream_options" in requests[0], false);
    assert.match(requests[0].messages[1].content, /assessment_narrative schema/);
    assert.match(requests[0].messages[1].content, /ReportFacts/);
    assert.match(requests[0].messages[1].content, /高频规范错误标签/);
    assert.equal(requests[0].messages[1].content.includes("逐题结构化证据"), false);
    assert.equal(requests[0].messages[1].content.includes("用户译文"), false);
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
    assert.equal(requests[0].thinking.type, "enabled");
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
    assert.equal(requests[0].thinking.type, "enabled");
    assert.equal("stream" in requests[1], false);
    assert.equal(requests[1].thinking.type, "enabled");
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
            skills: ["过去式动词", "finish 使用过去式 finished"],
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
    assert.equal(requests[0].thinking.type, "enabled");
    assert.equal(requests[0].messages[1].content.includes("/no_think"), false);
    assert.equal(requests[0].messages[1].content.includes("高信息密度"), false);
    assert.equal(requests[0].messages[1].content.includes("1-2 个可独立评分的次要维度"), true);
    assert.match(requests[0].messages[1].content, /先保证生活化，再考虑语法覆盖/);
    assert.match(requests[0].messages[1].content, /公平但不能泄题/);
    assert.match(requests[0].messages[1].content, /禁止出现任何英文字母/);
    assert.match(requests[0].messages[1].content, /不要写“was\/were \+ past participle”/);
    assert.equal(question.chinese, "昨天我完成了作业。");
    assert.deepEqual(question.skills, ["过去式动词"]);
    assert.equal(typeof question.difficulty_b, "number");
    assert.ok(Array.isArray(question.calibration_issues));
    assert.equal(typeof question.calibration_passed, "boolean");
  } finally {
    global.fetch = originalFetch;
  }
});

test("drill card generation sends structured schema and normalizes reference answer", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            casual: "I was in meetings all morning, so I might send the report a bit later.",
            standard: "I was in meetings all morning, so I may submit the report a little later.",
            vivid: "My morning was packed with meetings, so the report may come a little later.",
            source_cn: "我今天上午一直在开会，所以报告可能晚点交。",
            reference_en: "This should be overwritten.",
            grammar_dimension: "连接词",
            common_mistake: "容易把 because 和 so 重复使用。",
            memory_hook: "先原因，再结果。"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const card = await generateDrillCard(settings(), "我今天上午一直在开会，所以报告可能晚点交。");

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.match(requests[0].messages[1].content, /drill_card schema/);
    assert.equal(requests[0].thinking.type, "disabled");
    assert.match(requests[0].messages[1].content, /grammar_dimension 只能从以下 6 个值中选 1 个/);
    assert.equal(card.reference_en, card.standard);
    assert.equal(card.grammar_dimension, "连接词");
  } finally {
    global.fetch = originalFetch;
  }
});

test("drill card generation parses JSON from reasoning_content and normalizes unknown dimension", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
          reasoning_content: JSON.stringify({
            casual: "I might be a little late today.",
            standard: "I may be a little late today.",
            vivid: "I may run a little late today.",
            source_cn: "我今天可能会迟到一点。",
            reference_en: "I may be a little late today.",
            grammar_dimension: "语序",
            common_mistake: "容易把 may 放在动词后面。",
            memory_hook: "可能先放 may，再接动词原形。"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const card = await generateDrillCard(settings(), "我今天可能会迟到一点。");

    assert.equal(card.source_cn, "我今天可能会迟到一点。");
    assert.equal(card.reference_en, "I may be a little late today.");
    assert.equal(card.grammar_dimension, "连接词");
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

test("batch question generation requests all questions in one structured call", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            questions: [
              {
                chinese: "昨天我在车站等了十分钟。",
                answers: ["I waited at the station for ten minutes yesterday."],
                vocabulary_tips: ["wait", "station", "minute"],
                grammar_focus: "一般过去时 + 地点介词 + 时间介词",
                secondary_dimensions: ["介词搭配", "冠词"],
                skills: ["过去式动词", "地点介词", "时间介词"],
                rubric_points: ["wait 使用过去式", "at the station 搭配正确"]
              },
              {
                chinese: "这封邮件已经被经理回复了。",
                answers: ["This email has already been replied to by the manager."],
                vocabulary_tips: ["email", "reply", "manager"],
                grammar_focus: "现在完成时被动语态 + 冠词",
                secondary_dimensions: ["时态", "冠词"],
                skills: ["现在完成时", "被动语态结构", "特指冠词"],
                rubric_points: ["使用 has been replied to", "the manager 表达正确"]
              }
            ]
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const questions = await generateQuestions(settings(), [
      { dimension: "时态", difficulty: 45, paperPosition: "第 1/2 题" },
      { dimension: "被动语态", difficulty: 60, paperPosition: "第 2/2 题" }
    ], true, ["我昨天去了商店。"]);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.match(requests[0].messages[1].content, /assessment_question_batch schema/);
    assert.match(requests[0].messages[1].content, /一次性生成 2 道/);
    assert.match(requests[0].messages[1].content, /场景尽量分散/);
    assert.match(requests[0].messages[1].content, /像日常微信、课堂、办公室、家里/);
    assert.match(requests[0].messages[1].content, /禁止生成明显教材化、百科化、脱离日常的模板句/);
    assert.match(requests[0].messages[1].content, /secondary_dimensions 给 1-2 个/);
    assert.equal(questions.length, 2);
    assert.equal(questions[0].dimension, "时态");
    assert.equal(questions[1].dimension, "被动语态");
    assert.equal(typeof questions[0].difficulty_b, "number");
    assert.ok(Array.isArray(questions[0].calibration_issues));
    assert.equal(typeof questions[0].calibration_passed, "boolean");
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
    assert.equal(requests[0].thinking.type, "enabled");
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
    assert.deepEqual(result.error_types, ["tense", "passive"]);
    assert.deepEqual(result.error_tags, ["tense_error", "passive_voice_error"]);
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

test("grading downgrades overall verdict when a secondary core dimension has a major failure", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "partial",
            error_types: ["tense", "verb_form", "preposition"],
            reference_answers: ["I left my umbrella on the bus, and I am walking home in the rain now."],
            differences: ["用户后半句没有使用现在进行时。", "用户写了 to home。"],
            explanations: ["现在正回家应使用 am walking home。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "介词搭配", score: 85, verdict: "correct", severity: "minor", notes: "on the bus 正确，但 to home 不自然。" },
              { dimension: "时态", score: 20, verdict: "wrong", severity: "major", notes: "was walk 不是正确结构，也没有表达现在进行时。" }
            ],
            skill_findings: ["现在进行时结构薄弱", "home 作副词用法薄弱"]
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
      chinese: "我把雨伞忘在了公交车上，现在正淋着雨回家。",
      answers: ["I left my umbrella on the bus, and I am walking home in the rain now."],
      grammar_focus: "交通工具介词 + 一般过去时 + 现在进行时",
      dimension: "介词搭配",
      secondary_dimensions: ["时态"],
      difficulty: 60
    }, "I left my umbrella on the bus, so I was walk to home in the rain.");

    assert.equal(result.verdict, "wrong");
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

test("grading prompt treats hidden reference-only structures as non-mandatory", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "partial",
            error_types: ["subject_verb_agreement"],
            reference_answers: ["I am used to drinking coffee every morning, but my brother only likes tea."],
            differences: ["my brother 后 like 应改为 likes。"],
            explanations: ["usually drink 能自然表达每天早晨喝咖啡的习惯，但第三人称单数需要 likes。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "介词搭配", score: 65, verdict: "partial", severity: "minor", notes: "习惯表达可接受，但后半句主谓一致错误。" }
            ],
            skill_findings: ["第三人称单数谓语变化"]
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
      chinese: "我习惯每天早晨喝咖啡，但我的弟弟只喜欢喝茶。",
      answers: ["I am used to drinking coffee every morning, but my brother only likes tea."],
      grammar_focus: "be used to doing 习惯表达",
      dimension: "介词搭配",
      secondary_dimensions: ["冠词"],
      skills: ["习惯表达辨析", "动名词作宾语", "频率副词位置", "人称代词所有格", "转折逻辑衔接"],
      difficulty: 55
    }, "I usually drink coffee every morning, but my brother only like drinking tea.");

    const prompt = requests[0].messages.map((message) => message.content).join("\n");
    assert.match(prompt, /做题前可见技能标签/);
    assert.match(prompt, /不能把做题前不可见的特定参考句式当成唯一正确答案/);
    assert.match(prompt, /usually do 或 be used to doing/);
    assert.equal(result.verdict, "partial");
  } finally {
    global.fetch = originalFetch;
  }
});

test("grading prompt allows natural determiner variants for specific references", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "correct",
            error_types: [],
            reference_answers: ["My sister likes the girl who always wears a red dress."],
            differences: ["that girl 和 the girl 都可表达特指。"],
            explanations: ["定语从句、第三人称单数和 a red dress 均正确。"],
            memory_tip: "",
            dimension_scores: [
              { dimension: "定语从句", score: 95, verdict: "correct", severity: "minor", notes: "who 引导定语从句正确。" },
              { dimension: "冠词", score: 95, verdict: "correct", severity: "minor", notes: "that girl 可自然表达“那个女孩”。" }
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
      chinese: "我妹妹喜欢那个总是穿红裙子的女孩。",
      answers: ["My sister likes the girl who always wears a red dress."],
      grammar_focus: "who 引导定语从句 + 冠词",
      dimension: "定语从句",
      secondary_dimensions: ["冠词", "时态"],
      skills: ["who 引导定语从句", "第三人称单数", "频度副词位置", "特指表达", "泛指单数名词"],
      difficulty: 55
    }, "My sister likes that girl who always wears a red dress.");

    const prompt = requests[0].messages.map((message) => message.content).join("\n");
    assert.match(prompt, /that girl who always wears a red dress/);
    assert.match(prompt, /不能仅因参考答案是 “the girl who\.\.\.” 就判错/);
    assert.equal(result.verdict, "correct");
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
