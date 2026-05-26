import { DIMENSIONS, Dimension, GradeResult, Question, Settings } from "./types";

function stripCodeFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(stripCodeFence(text)) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 返回内容不是有效 JSON");
    return JSON.parse(match[0]) as T;
  }
}

function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.map((item) => toText(item)).filter(Boolean).join("；");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toTextArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return value.map((item) => toText(item)).filter(Boolean);
  const text = toText(value);
  return text ? [text] : fallback;
}

async function chat(settings: Settings, messages: Array<{ role: "system" | "user"; content: string }>) {
  if (!settings.model) throw new Error("请先在设置页填写 LM Studio 模型名称");
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const payload = {
    model: settings.model,
    temperature: settings.temperature,
    response_format: { type: "json_object" },
    messages
  };
  let res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let errorText = "";
  if (!res.ok) {
    errorText = await res.text();
    // 部分 LM Studio 版本或模型不支持 response_format，失败时自动降级为纯 prompt 约束。
    if (/response_format|json_object/i.test(errorText)) {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, response_format: undefined })
      });
      errorText = res.ok ? "" : await res.text();
    }
  }
  if (!res.ok) {
    throw new Error(`LM Studio 请求失败：${res.status} ${errorText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export async function testConnection(settings: Settings) {
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/v1/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`无法连接 LM Studio：${res.status}`);
  const models = await res.json();
  if (settings.model) {
    await chat(settings, [
      { role: "system", content: "你只返回 JSON，不要输出额外内容。" },
      { role: "user", content: '返回 {"ok":true}' }
    ]);
  }
  return models;
}

export async function generateQuestion(settings: Settings, dimension: Dimension, difficulty: number): Promise<Question> {
  const content = await chat(settings, [
    {
      role: "system",
      content:
        "你是一位专业的英语写作训练出题老师，母语为中文。请只返回 JSON，不要输出任何额外内容。"
    },
    {
      role: "user",
      content: `请生成 1 道中译英练习题。
考查维度：${dimension}
难度：${difficulty}/100
要求：中文句子自然、适合中文母语者练习英语写作；参考答案给 1-2 个英文变体；明确说明考查语法点。
严格返回 JSON：{"chinese":"中文原句","answers":["英文答案1","英文答案2"],"grammar_focus":"考查语法点说明"}`
    }
  ]);
  const parsed = parseJson<{ chinese: string; answers: string[]; grammar_focus: string }>(content);
  return {
    chinese: toText(parsed.chinese, "题目生成失败，请重新生成。"),
    answers: toTextArray(parsed.answers).slice(0, 2),
    grammar_focus: toText(parsed.grammar_focus, "本题考查指定语法维度。"),
    dimension,
    difficulty,
    source: "ai"
  };
}

export async function gradeAnswer(settings: Settings, question: Question, userAnswer: string): Promise<GradeResult> {
  const content = await chat(settings, [
    {
      role: "system",
      content: `你是一位专业的英语语法教师，母语为中文。
用户正在练习将中文句子翻译成英文。
请严格按照以下 JSON 格式返回批改结果，不要输出任何额外内容。
{
  "verdict":"correct|partial|wrong",
  "error_types":["错误类型标签"],
  "reference_answers":["参考答案"],
  "differences":["逐处对比用户原句与参考答案的差异"],
  "explanations":["用中文解释每处错误的语法原理"],
  "memory_tip":"一句中文记忆技巧，可省略"
}`
    },
    {
      role: "user",
      content: `中文原句：${question.chinese}
考查维度：${question.dimension}
考查语法点：${question.grammar_focus}
参考答案：${question.answers.join(" / ")}
用户译文：${userAnswer}

请判断：正确、基本正确（有小瑕疵）或错误。即使意思接近，也要指出语法、搭配、冠词、时态、语序等问题。`
    }
  ]);
  const parsed = parseJson<GradeResult>(content);
  return {
    verdict: ["correct", "partial", "wrong"].includes(parsed.verdict) ? parsed.verdict : "wrong",
    error_types: toTextArray(parsed.error_types),
    reference_answers: toTextArray(parsed.reference_answers, question.answers).slice(0, 2),
    differences: toTextArray(parsed.differences),
    explanations: toTextArray(parsed.explanations),
    memory_tip: parsed.memory_tip ? toText(parsed.memory_tip) : undefined
  };
}

export function chooseAdaptiveDifficulty(score: number) {
  const offset = 5 + Math.floor(Math.random() * 11);
  return Math.max(1, Math.min(100, Math.round(score + offset)));
}

export function chooseLowestDimension(scores: Array<{ dimension: Dimension; score: number }>) {
  return [...scores].sort((a, b) => a.score - b.score)[0]?.dimension ?? DIMENSIONS[0];
}
