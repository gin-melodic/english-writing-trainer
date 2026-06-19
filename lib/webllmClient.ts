"use client";

import type { AppConfig, MLCEngineInterface } from "@mlc-ai/web-llm";
import { normalizeErrorTags } from "./errorTags";
import { calibrateGeneratedQuestion } from "./questionCalibration";
import { publicQuestionSkills } from "./questionSafety";
import { DIMENSIONS, Dimension, DrillCard, FollowUpMessage, GradeResult, Question, Settings, StudyGuide } from "./types";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: false;
};
type WebLlmProgress = (message: string) => void;
type QuestionGenerationSpec = {
  dimension: Dimension;
  difficulty: number;
  paperPosition?: string;
  focusSkills?: string[];
};
type GeneratedQuestionPayload = {
  chinese?: string;
  answers?: string[];
  vocabulary_tips?: string[];
  grammar_focus?: string;
  secondary_dimensions?: string[];
  skills?: string[];
  rubric_points?: string[];
};
type DrillCardPayload = Partial<DrillCard>;

const HUGGING_FACE_BASE_URL = "https://huggingface.co";
const DEFAULT_WEBLLM_MODEL_BASE_URL = "https://hf-mirror.com";

let engineModel = "";
let engineModelBaseUrl = "";
let enginePromise: Promise<MLCEngineInterface> | undefined;

function stripCodeFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function parseJson<T>(text: string): T {
  const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try {
    return JSON.parse(stripCodeFence(cleanText)) as T;
  } catch {
    const match = cleanText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("WebLLM 返回内容不是有效 JSON");
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

function isMeaningfulText(value: unknown) {
  const text = toText(value).trim();
  return text.length >= 8 && !/^[.\s。…-]+$/.test(text);
}

function toVocabularyTips(value: unknown) {
  return [...new Set(toTextArray(value).map((item) => item.trim().toLowerCase()))]
    .filter((item) => /^[a-z]+$/.test(item))
    .slice(0, 5);
}

function toDimensions(value: unknown, primary: Dimension) {
  return [...new Set(toTextArray(value).filter((item): item is Dimension => (DIMENSIONS as readonly string[]).includes(item) && item !== primary))].slice(0, 3);
}

function contentBlockToText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      if (typeof block.value === "string") return block.value;
      return "";
    }).join("");
  }
  return "";
}

function extractContent(data: unknown) {
  const choice = (data as { choices?: Array<{ message?: Record<string, unknown>; text?: unknown }> })?.choices?.[0];
  const message = choice?.message;
  const parsed = message?.parsed;
  if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
  if (typeof parsed === "string") return parsed;
  const content = contentBlockToText(message?.content || choice?.text);
  return content.trim() ? content : contentBlockToText(message?.reasoning_content);
}

function schemaInstruction(messages: ChatMessage[], schemaName: string, schema: JsonSchema) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const instruction = `\n\n请只输出一个合法 JSON 对象，不要输出 markdown、解释或额外文本。JSON 对象必须符合以下 ${schemaName} schema：\n${JSON.stringify(schema)}`;
  return messages.map((message, index) => index === lastUserIndex ? { ...message, content: `${message.content}${instruction}` } : message);
}

function webLlmModel(settings: Settings) {
  const model = settings.personalModel.trim();
  if (!model) throw new Error("请先选择 WebLLM 模型");
  return model;
}

function webLlmModelBaseUrl(settings: Settings) {
  return (settings.webLlmModelBaseUrl || DEFAULT_WEBLLM_MODEL_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_WEBLLM_MODEL_BASE_URL;
}

function base64Url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function webLlmModelProxyBaseUrl(modelBaseUrl: string) {
  if (typeof window === "undefined") return modelBaseUrl;
  return `${window.location.origin}/api/webllm/model/${base64Url(modelBaseUrl)}`;
}

function withModelBaseUrl(appConfig: AppConfig, modelBaseUrl: string): AppConfig {
  const rewrittenBaseUrl = webLlmModelProxyBaseUrl(modelBaseUrl);
  return {
    ...appConfig,
    model_list: appConfig.model_list.map((record) => ({
      ...record,
      model: record.model.startsWith(HUGGING_FACE_BASE_URL)
        ? `${rewrittenBaseUrl}${record.model.slice(HUGGING_FACE_BASE_URL.length)}`
        : record.model
    }))
  };
}

async function getEngine(settings: Settings, onProgress?: WebLlmProgress) {
  if (typeof window === "undefined") throw new Error("WebLLM 只能在浏览器中运行");
  if (!("gpu" in navigator)) throw new Error("当前浏览器不支持 WebGPU，请使用 Chrome/Edge 113+ 并开启 WebGPU");
  const model = webLlmModel(settings);
  const modelBaseUrl = webLlmModelBaseUrl(settings);
  if (!enginePromise || engineModel !== model || engineModelBaseUrl !== modelBaseUrl) {
    engineModel = model;
    engineModelBaseUrl = modelBaseUrl;
    onProgress?.(`WebLLM 正在加载模型：${model}`);
    enginePromise = import("@mlc-ai/web-llm")
      .then(({ CreateMLCEngine, prebuiltAppConfig }) => CreateMLCEngine(model, {
        appConfig: withModelBaseUrl(prebuiltAppConfig, modelBaseUrl),
        initProgressCallback: (report) => {
          const percent = Number.isFinite(report.progress) ? ` ${Math.round(report.progress * 100)}%` : "";
          onProgress?.(`${report.text || "WebLLM 正在初始化"}${percent}`);
        }
      }))
      .catch((error) => {
        enginePromise = undefined;
        throw error;
      });
  }
  return enginePromise;
}

async function chatJson<T>(settings: Settings, messages: ChatMessage[], schemaName: string, schema: JsonSchema, onProgress?: WebLlmProgress): Promise<T> {
  const engine = await getEngine(settings, onProgress);
  const response = await engine.chat.completions.create({
    messages: schemaInstruction(messages, schemaName, schema),
    temperature: settings.temperature,
    response_format: { type: "json_object", schema: JSON.stringify(schema) }
  } as never);
  const content = extractContent(response);
  if (!content.trim()) throw new Error("WebLLM 没有返回内容");
  return parseJson<T>(content);
}

async function chatText(settings: Settings, messages: ChatMessage[], onProgress?: WebLlmProgress) {
  const engine = await getEngine(settings, onProgress);
  const response = await engine.chat.completions.create({
    messages,
    temperature: settings.temperature
  } as never);
  const content = extractContent(response).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!content) throw new Error("WebLLM 没有返回追问解答");
  return content;
}

const dimensionSchema = { type: "string", enum: DIMENSIONS };
const stringArraySchema = { type: "array", items: { type: "string" } };
const connectionSchema: JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false
};

function questionSchema(includeVocabularyTips: boolean): JsonSchema {
  const properties: JsonSchema["properties"] = {
    chinese: { type: "string" },
    answers: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 },
    grammar_focus: { type: "string" },
    secondary_dimensions: { type: "array", items: dimensionSchema },
    skills: { type: "array", items: { type: "string" } },
    rubric_points: { type: "array", items: { type: "string" } }
  };
  const required = ["chinese", "answers", "grammar_focus", "secondary_dimensions", "skills", "rubric_points"];
  if (includeVocabularyTips) {
    properties.vocabulary_tips = { type: "array", items: { type: "string" } };
    required.splice(2, 0, "vocabulary_tips");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function questionBatchSchema(includeVocabularyTips: boolean, count: number): JsonSchema {
  return {
    type: "object",
    properties: {
      questions: { type: "array", minItems: count, maxItems: count, items: questionSchema(includeVocabularyTips) }
    },
    required: ["questions"],
    additionalProperties: false
  };
}

function gradeSchema(primary: Dimension): JsonSchema {
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
      error_types: stringArraySchema,
      reference_answers: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 },
      differences: stringArraySchema,
      explanations: stringArraySchema,
      memory_tip: { type: "string" },
      dimension_scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: [primary, ...DIMENSIONS.filter((dimension) => dimension !== primary)] },
            score: { type: "integer", minimum: 0, maximum: 100 },
            verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
            severity: { type: "string", enum: ["none", "minor", "major"] },
            notes: { type: "string" }
          },
          required: ["dimension", "score", "verdict", "severity", "notes"],
          additionalProperties: false
        }
      },
      skill_findings: stringArraySchema
    },
    required: ["verdict", "error_types", "reference_answers", "differences", "explanations", "memory_tip", "dimension_scores", "skill_findings"],
    additionalProperties: false
  };
}

const drillCardSchema: JsonSchema = {
  type: "object",
  properties: {
    casual: { type: "string" },
    standard: { type: "string" },
    vivid: { type: "string" },
    source_cn: { type: "string" },
    reference_en: { type: "string" },
    grammar_dimension: dimensionSchema,
    common_mistake: { type: "string" },
    memory_hook: { type: "string" }
  },
  required: ["casual", "standard", "vivid", "source_cn", "reference_en", "grammar_dimension", "common_mistake", "memory_hook"],
  additionalProperties: false
};

const studyGuideSchema: JsonSchema = {
  type: "object",
  properties: {
    overview: { type: "string" },
    sections: { type: "array", items: { type: "object" } },
    checklist: { type: "array", items: { type: "string" } }
  },
  required: ["overview", "sections", "checklist"],
  additionalProperties: false
};

function questionGenerationPrompt(input: {
  count: number;
  includeVocabularyTips: boolean;
  previousQuestions: string[];
  regenerateReason?: string;
  specs: QuestionGenerationSpec[];
}) {
  const avoidList = input.previousQuestions.filter(Boolean).slice(-20).map((item, index) => `${index + 1}. ${item}`).join("\n");
  const specList = input.specs.map((spec, index) => [
    `${index + 1}. 考查维度：${spec.dimension}`,
    `   难度：${spec.difficulty}/100`,
    spec.paperPosition ? `   试卷位置：${spec.paperPosition}` : "",
    spec.focusSkills?.length ? `   优先覆盖薄弱技能：${spec.focusSkills.slice(0, 5).join("、")}` : ""
  ].filter(Boolean).join("\n")).join("\n");

  return `请一次性生成 ${input.count} 道中译英练习题，并按 questions 数组顺序返回。
每道题的目标：
${specList}

要求：
1. 中文句子必须像日常微信、课堂、办公室、家里、路上、购物、吃饭、约时间、请假、催进度、邻里闲聊中真实会说的话。
2. 尽量使用初级英语词汇和常见生活场景，避免生僻词、抽象名词、复杂专业表达。
3. 主要难点必须来自语法结构，而不是词汇理解。
4. 每题围绕 1 个主维度即可；只有在自然时才嵌入 1-2 个次要维度。
5. 中文题干建议 12-28 个汉字；最多 2 个分句。
6. answers 必须且只能给 1 个最佳英文参考答案。
7. grammar_focus 必须说明主考点和自然嵌入的次要考点。
${input.includeVocabularyTips ? "8. vocabulary_tips 只给 0-5 个关键英文单词原型，禁止透露语法答案。" : "8. 不要返回 vocabulary_tips。"}
9. secondary_dimensions 只能从：${DIMENSIONS.join("、")} 中选择，且不能包含主维度。
10. skills 会在做题前展示，必须公平但不能泄题；写成 2-4 个中文抽象能力点，不要出现英文答案片段或公式。
11. rubric_points 可包含内部批改细则，但不要把不可见的特定参考句式设为唯一正确答案。
12. 禁止生成明显教材化、百科化、脱离日常的模板句。
${avoidList ? `已生成题目，必须避开：\n${avoidList}` : "本轮还没有已生成题目。"}
${input.regenerateReason ? `用户要求重生成的原因：${input.regenerateReason}` : ""}`;
}

function normalizeGeneratedQuestion(parsed: GeneratedQuestionPayload, dimension: Dimension, difficulty: number, includeVocabularyTips: boolean): Question {
  const answers = toTextArray(parsed.answers, ["This question needs a valid reference answer."]).filter(Boolean);
  const question: Question = {
    chinese: toText(parsed.chinese, "题目生成失败，请重新生成。"),
    answers: [answers[0] || "This question needs a valid reference answer."],
    vocabulary_tips: includeVocabularyTips ? toVocabularyTips(parsed.vocabulary_tips) : undefined,
    grammar_focus: toText(parsed.grammar_focus, "本题考查指定语法维度。"),
    dimension,
    secondary_dimensions: toDimensions(parsed.secondary_dimensions, dimension),
    skills: publicQuestionSkills(parsed.skills),
    rubric_points: toTextArray(parsed.rubric_points).slice(0, 6),
    difficulty,
    source: "ai"
  };
  const calibration = calibrateGeneratedQuestion(question, difficulty);
  return { ...question, difficulty_b: calibration.difficulty_b, calibration_issues: calibration.issues, calibration_passed: calibration.passed };
}

function normalizeDimensionScores(value: unknown, primary: Dimension): GradeResult["dimension_scores"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return undefined;
    const raw = item as Record<string, unknown>;
    const dimension = (DIMENSIONS as readonly string[]).includes(String(raw.dimension)) ? String(raw.dimension) as Dimension : primary;
    const verdict = ["correct", "partial", "wrong"].includes(String(raw.verdict)) ? raw.verdict as GradeResult["verdict"] : "wrong";
    const severity = ["none", "minor", "major"].includes(String(raw.severity)) ? raw.severity as "none" | "minor" | "major" : verdict === "correct" ? "none" : verdict === "partial" ? "minor" : "major";
    const fallbackScore = verdict === "correct" ? 90 : verdict === "partial" ? 65 : 25;
    const score = Math.max(0, Math.min(100, Math.round(Number(raw.score) || fallbackScore)));
    return { dimension, score, verdict, severity, notes: toText(raw.notes) };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function normalizeGrade(parsed: GradeResult, question: Question): GradeResult {
  const dimensionScores = normalizeDimensionScores(parsed.dimension_scores, question.dimension);
  const verdict = ["correct", "partial", "wrong"].includes(parsed.verdict) ? parsed.verdict : "wrong";
  const rawErrorTypes = toTextArray(parsed.error_types);
  return {
    verdict,
    error_types: rawErrorTypes,
    error_tags: normalizeErrorTags(rawErrorTypes),
    reference_answers: [toTextArray(parsed.reference_answers, question.answers)[0] || question.answers[0] || "No reference answer was provided."],
    differences: toTextArray(parsed.differences),
    explanations: toTextArray(parsed.explanations),
    memory_tip: parsed.memory_tip ? toText(parsed.memory_tip) : undefined,
    dimension_scores: dimensionScores,
    skill_findings: toTextArray(parsed.skill_findings).slice(0, 6)
  };
}

function normalizeDrillCard(parsed: DrillCardPayload, sourceCn: string): DrillCard {
  const standard = toText(parsed.standard).trim();
  const dimension = (DIMENSIONS as readonly string[]).includes(String(parsed.grammar_dimension)) ? parsed.grammar_dimension as Dimension : "连接词";
  if (!isMeaningfulText(sourceCn)) throw new Error("中文场景内容过短");
  if (!isMeaningfulText(standard)) throw new Error("WebLLM 返回的 standard 为空或过短");
  return {
    casual: toText(parsed.casual || standard).trim(),
    standard,
    vivid: toText(parsed.vivid || standard).trim(),
    source_cn: sourceCn,
    reference_en: standard,
    grammar_dimension: dimension,
    common_mistake: toText(parsed.common_mistake, `${dimension}相关表达容易直译。`).trim(),
    memory_hook: toText(parsed.memory_hook, "先想自然英文表达，再检查核心语法。").trim()
  };
}

export async function testWebLlmConnection(settings: Settings, onProgress?: WebLlmProgress) {
  const result = await chatJson<{ ok: boolean }>(settings, [
    { role: "system", content: "你用于测试 WebLLM 结构化输出连接。请严格返回 JSON。" },
    { role: "user", content: "返回连接状态 ok 为 true。" }
  ], "connection_test", connectionSchema, onProgress);
  if (result.ok !== true) throw new Error("ok 字段不是 true");
  return {
    tests: [
      { key: "webgpu", label: "WebGPU / 模型加载", ok: true, detail: "WebLLM 模型已在浏览器中初始化" },
      { key: "structured_json", label: "JSON 模式结构化输出", ok: true, detail: "WebLLM JSON 解析成功" }
    ]
  };
}

export async function generateWebLlmQuestions(settings: Settings, specs: QuestionGenerationSpec[], includeVocabularyTips = false, previousQuestions: string[] = [], regenerateReason = "", onProgress?: WebLlmProgress) {
  const normalizedSpecs = specs.map((spec) => ({
    ...spec,
    difficulty: Math.max(1, Math.min(100, Math.round(Number(spec.difficulty) || 50))),
    focusSkills: spec.focusSkills?.filter(Boolean).slice(0, 5) ?? []
  }));
  if (!normalizedSpecs.length) return [];
  const parsed = await chatJson<{ questions?: GeneratedQuestionPayload[] }>(settings, [
    { role: "system", content: "你是一位专业的英语写作训练出题老师，母语为中文。请一次性完成整张试卷出题，并按结构化输出 schema 填写字段。" },
    {
      role: "user",
      content: questionGenerationPrompt({
        count: normalizedSpecs.length,
        includeVocabularyTips,
        previousQuestions,
        regenerateReason,
        specs: normalizedSpecs
      })
    }
  ], includeVocabularyTips ? "assessment_question_batch" : "practice_question_batch", questionBatchSchema(includeVocabularyTips, normalizedSpecs.length), onProgress);
  const questions = parsed.questions ?? [];
  if (questions.length !== normalizedSpecs.length) throw new Error(`WebLLM 返回的题目数量不正确：需要 ${normalizedSpecs.length} 道，实际 ${questions.length} 道`);
  return questions.map((question, index) => normalizeGeneratedQuestion(question, normalizedSpecs[index].dimension, normalizedSpecs[index].difficulty, includeVocabularyTips));
}

export async function gradeWebLlmAnswer(settings: Settings, question: Question, userAnswer: string, onProgress?: WebLlmProgress) {
  const parsed = await chatJson<GradeResult>(settings, [
    {
      role: "system",
      content: "你是一位专业的英语语法教师，母语为中文。用户正在练习将中文句子翻译成英文。请按结构化输出 schema 填写批改结果。"
    },
    {
      role: "user",
      content: `中文原句：${question.chinese}
考查维度：${question.dimension}
次要维度：${question.secondary_dimensions?.join("、") || "无"}
考查语法点：${question.grammar_focus}
做题前可见技能标签：${question.skills?.join("、") || "无"}
批改要点：${question.rubric_points?.join("；") || "按题目语法点批改"}
参考答案：${question.answers.join(" / ")}
用户译文：${userAnswer}

请判断：正确、基本正确（仅限非核心小瑕疵）或错误。即使意思接近，也要指出语法、搭配、冠词、时态、语序等问题。
reference_answers 必须且只能给 1 个最佳英文参考答案。
dimension_scores 必须覆盖主维度；如果次要维度有明确证据，也要分别给出。score 使用 0-100 百分制。
公平性原则：评分以中文原句、考查维度、做题前可见技能标签为硬标准；参考答案只能帮助理解题意，不能把不可见的特定句式当成唯一正确答案。`
    }
  ], "grade_result", gradeSchema(question.dimension), onProgress);
  return normalizeGrade(parsed, question);
}

export async function generateWebLlmDrillCard(settings: Settings, sourceCn: string, onProgress?: WebLlmProgress) {
  const trimmedSource = sourceCn.trim();
  const parsed = await chatJson<DrillCardPayload>(settings, [
    { role: "system", content: "你是一位面向中文母语者的英语表达教练。请只输出符合 schema 的 JSON。" },
    {
      role: "user",
      content: `中文个人场景：
${trimmedSource}

请生成一个中译英表达 Drill Card。casual 是自然口语版本，standard 是标准版本，vivid 是更生动但不过度高级的版本。source_cn 必须保留用户原始中文场景，reference_en 必须等于 standard。grammar_dimension 只能从以下 6 个值中选 1 个：${DIMENSIONS.join("、")}。`
    }
  ], "drill_card", drillCardSchema, onProgress);
  return normalizeDrillCard(parsed, trimmedSource);
}

export async function answerWebLlmFollowUp(settings: Settings, question: Question, userAnswer: string, result: GradeResult, messages: FollowUpMessage[], prompt: string, onProgress?: WebLlmProgress) {
  const safeMessages = messages.filter((message) => message.content.trim()).slice(-8).map((message) => ({
    role: message.role,
    content: message.content.trim().slice(0, 1200)
  }));
  return chatText(settings, [
    {
      role: "system",
      content: "你是一位耐心、严格的中译英写作教练，母语为中文。只围绕当前题目、用户译文、参考答案和批改结果回答追问。"
    },
    {
      role: "user",
      content: `当前题目上下文：
中文原句：${question.chinese}
考查维度：${question.dimension}
考查语法点：${question.grammar_focus}
最佳参考答案：${result.reference_answers[0] || question.answers[0] || "无"}
用户译文：${userAnswer}
批改结论：${result.verdict}
错误类型：${result.error_types.join("、") || "无"}
解释：${result.explanations.join("；") || "无"}`
    },
    ...safeMessages,
    { role: "user", content: prompt.trim().slice(0, 1200) }
  ], onProgress);
}

export async function generateWebLlmStudyGuide(settings: Settings, questions: Question[], onProgress?: WebLlmProgress): Promise<StudyGuide> {
  const outlines = questions.map((question) => ({
    dimension: question.dimension,
    secondary_dimensions: question.secondary_dimensions?.slice(0, 3),
    grammar_focus: question.grammar_focus,
    skills: question.skills?.slice(0, 4),
    rubric_points: question.rubric_points?.slice(0, 4),
    difficulty: question.difficulty
  })).slice(0, 50);
  const parsed = await chatJson<StudyGuide>(settings, [
    { role: "system", content: "你是一位面向中文母语者的英语写作课老师。请按结构化输出 schema 生成中文专项学习材料。" },
    {
      role: "user",
      content: `请根据今天试卷涉及的知识点，生成做题前专项学习材料。
只允许使用以下知识点元数据，不得猜测、复述、改写或透露原试卷题目和参考答案：
${JSON.stringify(outlines)}

要求：overview 用 3-5 句话；sections 给若干专题，每个专题包含 title、why_it_matters、explanation、key_points、patterns、contrast、examples、pitfalls、drills；checklist 给做题前检查清单。`
    }
  ], "study_guide", studyGuideSchema, onProgress);
  return {
    overview: isMeaningfulText(parsed.overview) ? toText(parsed.overview).trim() : "今天的试卷主要涉及多个语法知识点。先梳理判断方法，再进入答题会更稳定。",
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    checklist: toTextArray(parsed.checklist).slice(0, 8)
  };
}
