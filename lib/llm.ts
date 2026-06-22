import { DIMENSIONS, Dimension, DimensionScore, DrillCard, FollowUpMessage, GradeResult, Question, ReportFacts, Settings, StudyGuide } from "./types";
import { normalizeErrorTags } from "./errorTags";
import { calibrateGeneratedQuestion } from "./questionCalibration";
import { publicQuestionSkills } from "./questionSafety";
import { enqueue } from "./llmQueue";

function stripCodeFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function preview(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function parseJson<T>(text: string): T {
  const cleanText = stripThinking(text);
  try {
    return JSON.parse(stripCodeFence(cleanText)) as T;
  } catch {
    const match = cleanText.match(/\{[\s\S]*\}/);
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

function isMeaningfulText(value: unknown) {
  const text = toText(value).trim();
  return text.length >= 8 && !/^[.\s。…-]+$/.test(text);
}

type AssessmentNarrativePayload = ReportFacts;

type StudyGuideQuestionOutline = {
  dimension: Dimension;
  secondary_dimensions?: Dimension[];
  grammar_focus: string;
  skills?: string[];
  rubric_points?: string[];
  difficulty: number;
};

function fallbackAssessmentNarrative(payload: AssessmentNarrativePayload) {
  const sorted = [...payload.matrix].sort((a, b) => a.score - b.score || a.evidence_count - b.evidence_count);
  const weak = sorted.filter((item) => item.score < 70 || item.evidence_count < 3);
  const strongest = [...payload.matrix].sort((a, b) => b.score - a.score)[0];
  const weakest = weak[0] ?? sorted[0];
  const missing = payload.insufficient_evidence_dimensions.length
    ? payload.insufficient_evidence_dimensions
    : payload.matrix.filter((item) => item.evidence_count === 0).map((item) => item.dimension);
  const evidence = payload.top_skill_findings
    .map((item) => `${item.skill} ${item.count} 次`)
    .filter(Boolean)
    .slice(0, 3);

  const summaryParts = [
    `本次测评共完成 ${payload.total_questions} 题，当前最需要优先处理的是${weakest.dimension}，测评分为 ${weakest.score}。`,
    strongest ? `${strongest.dimension}相对稳定，测评分为 ${strongest.score}。` : "",
    missing.length ? `${missing.join("、")}暂时缺少有效测评证据，后续需要补题确认。` : "系统已根据逐题表现生成当前能力矩阵。"
  ].filter(Boolean);

  const weakPoints = (weak.length ? weak : sorted.slice(0, 3)).slice(0, 6).map((item) => {
    const confidenceText = item.confidence < 0.5 ? "证据还不够稳定" : "已有一定证据";
    return `${item.dimension}：当前分数 ${item.score}，有效证据 ${item.evidence_count} 条，${confidenceText}。`;
  });

  const recommendations = [
    weakest ? `优先安排${weakest.dimension}专项练习，先做中低难度题，确保核心结构能稳定写完整。` : "",
    `每次练习后把错误句改写成 2-3 个正确变体，重点检查主谓结构、固定搭配和信息是否遗漏。`,
    evidence[0] ? `针对本次典型问题复盘：${evidence[0]}。` : "",
    missing.length ? `下次测评或练习补充${missing.join("、")}题目，避免能力矩阵因为证据不足而偏差。` : "保持每日练习，并优先选择低分维度作为下一轮训练入口。"
  ].filter(Boolean).slice(0, 6);

  return {
    summary: summaryParts.join(""),
    weak_points: weakPoints,
    recommendations
  };
}

function toVocabularyTips(value: unknown): string[] {
  return [...new Set(toTextArray(value).map((item) => item.trim().toLowerCase()))]
    .filter((item) => /^[a-z]+$/.test(item))
    .slice(0, 5);
}

function toDimensions(value: unknown, primary: Dimension): Dimension[] {
  return [...new Set(toTextArray(value).filter((item): item is Dimension => (DIMENSIONS as readonly string[]).includes(item) && item !== primary))].slice(0, 3);
}

function normalizeDimensionScores(value: unknown, primary: Dimension): DimensionScore[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return undefined;
    const raw = item as Record<string, unknown>;
    const dimension = (DIMENSIONS as readonly string[]).includes(String(raw.dimension)) ? String(raw.dimension) as Dimension : primary;
    const verdict = ["correct", "partial", "wrong"].includes(String(raw.verdict)) ? raw.verdict as DimensionScore["verdict"] : "wrong";
    const severity = ["none", "minor", "major"].includes(String(raw.severity)) ? raw.severity as DimensionScore["severity"] : verdict === "correct" ? "none" : verdict === "partial" ? "minor" : "major";
    const fallbackScore = verdict === "correct"
      ? severity === "none" ? 100 : severity === "minor" ? 85 : 75
      : verdict === "partial"
        ? severity === "major" ? 50 : 65
        : severity === "minor" ? 40 : 20;
    const numericScore = Number(raw.score);
    const hasNumericScore = Number.isFinite(numericScore);
    const usesTenPointScale = hasNumericScore && numericScore > 0 && numericScore <= 10;
    const scaledScore = usesTenPointScale
      ? numericScore * 10
      : numericScore;
    const clampedScore = Math.max(0, Math.min(100, Math.round(Number.isFinite(scaledScore) ? scaledScore : fallbackScore)));
    const score = verdict === "correct"
      ? Math.max(clampedScore, usesTenPointScale || !hasNumericScore || clampedScore < 45 ? fallbackScore : 80)
      : verdict === "wrong"
        ? Math.min(clampedScore, fallbackScore)
        : Math.max(40, Math.min(80, clampedScore));
    return {
      dimension,
      score,
      verdict,
      severity,
      notes: toText(raw.notes)
    };
  }).filter((item): item is DimensionScore => Boolean(item));
}

function normalizeGradeVerdict(verdict: GradeResult["verdict"], scores: DimensionScore[], primary: Dimension): GradeResult["verdict"] {
  const primaryScore = scores.find((item) => item.dimension === primary);
  const hasMajorFailure = scores.some((item) => item.severity === "major" && (item.verdict === "wrong" || item.score < 45));
  if (hasMajorFailure) return "wrong";
  if (!primaryScore) return verdict;
  if (primaryScore.score >= 80 && primaryScore.verdict === "correct") return verdict === "wrong" ? "partial" : verdict;
  return primaryScore.score < 45 || primaryScore.verdict === "wrong" ? "wrong" : "partial";
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: false;
};

type ChatPayload = {
  model: string;
  temperature: number;
  response_format?:
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown> } }
  ;
  messages: ChatMessage[];
  thinking?: {
    type: "enabled" | "disabled";
  };
  stream?: boolean;
};

type RuntimeSettings = Settings & {
  userId?: number;
  personalApiKey?: string;
};

type AssessmentNarrative = {
  summary: string;
  weak_points: string[];
  recommendations: string[];
};

export type ConnectionTestItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type ConnectionTestResult = {
  tests: ConnectionTestItem[];
};

export type AssessmentNarrativeStreamProgress = {
  generatedChars: number;
  estimatedTokens: number;
  tokensPerSecond: number;
  finalTokens?: number;
  fallback?: boolean;
  deltaContent?: string;
  deltaReasoning?: string;
};

export type TextStreamProgress = {
  content: string;
  generatedChars: number;
  estimatedTokens: number;
  tokensPerSecond: number;
  finalTokens?: number;
  deltaContent?: string;
  deltaReasoning?: string;
};

function chatEndpoint(settings: RuntimeSettings) {
  const baseUrl = isPersonalProvider(settings) ? settings.personalBaseUrl : settings.baseUrl;
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function getZaiApiKey() {
  return process.env.ZAI_API_KEY?.trim()
    || process.env.ZHIPU_API_KEY?.trim()
    || process.env.BIGMODEL_API_KEY?.trim()
    || "";
}

function isPersonalProvider(settings: RuntimeSettings) {
  return Boolean(settings.personalProviderEnabled && settings.personalApiKey);
}

function isZaiProvider(settings: RuntimeSettings) {
  return !isPersonalProvider(settings);
}

function providerLabel(settings: RuntimeSettings) {
  if (settings.llmProvider === "webllm") return "WebLLM";
  if (isPersonalProvider(settings)) return "OpenAI 兼容模型";
  return "GLM";
}

function ensureChatSettings(settings: RuntimeSettings) {
  if (settings.llmProvider === "webllm") {
    throw new Error("WebLLM 只能在浏览器中运行，请在前端使用浏览器内推理");
  }
  if (isPersonalProvider(settings)) {
    if (!settings.personalBaseUrl) throw new Error(`请先填写 ${providerLabel(settings)} API 地址`);
    if (!settings.personalModel) throw new Error(`请先填写 ${providerLabel(settings)} 模型名称`);
    if (!settings.personalApiKey) throw new Error("请先保存个人模型 API Key");
    return;
  }
  if (!getZaiApiKey()) throw new Error("请先在 .env 中填写 ZAI_API_KEY");
  if (!settings.model) throw new Error("请先在设置页填写 GLM 模型名称");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function glmRequestTimeoutMs() {
  const parsed = Number(process.env.GLM_REQUEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90000;
}

function llmQueueConcurrency(settings: RuntimeSettings) {
  if (isZaiProvider(settings)) return 1;
  const parsed = Number(settings.maxConcurrentPredictions);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(20, Math.round(parsed))) : 20;
}

function providerPayload(settings: RuntimeSettings, payload: ChatPayload): ChatPayload {
  const model = isPersonalProvider(settings) ? settings.personalModel : settings.model;
  const next: ChatPayload = {
    ...payload,
    model
  };
  if (!isZaiProvider(settings)) {
    delete next.thinking;
  }
  console.info(`[${providerLabel(settings)}] providerPayload built`, {
    model,
    isPersonal: isPersonalProvider(settings),
    hasThinking: "thinking" in next,
    temperature: next.temperature,
    hasResponseFormat: !!next.response_format,
    messageCount: next.messages.length,
    stream: Boolean(next.stream)
  });
  return next;
}

async function fetchChat(settings: RuntimeSettings, payload: ChatPayload) {
  const provider = providerLabel(settings);
  const endpointUrl = chatEndpoint(settings);
  const apiKey = settings.llmProvider === "webllm"
    ? ""
    : isPersonalProvider(settings) ? settings.personalApiKey : getZaiApiKey();

  console.info(`[${provider}] fetchChat sending request`, {
    endpoint: endpointUrl,
    model: payload.model,
    apiKeyPresent: !!apiKey,
    timeoutMs: glmRequestTimeoutMs(),
    bodyBytes: JSON.stringify(payload).length,
    stream: Boolean(payload.stream)
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const fetchStartedAt = Date.now();
  console.info(`[${provider}] fetchChat calling fetch()`, { endpoint: endpointUrl });

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(glmRequestTimeoutMs()),
    body: JSON.stringify(payload)
  });

  console.info(`[${provider}] fetchChat fetch() returned`, {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    elapsedMs: Date.now() - fetchStartedAt
  });

  if (response.status !== 429) return response;
  const errorText = await response.text();
  const retryAfter = Number(response.headers.get("retry-after"));
  console.warn(`[${provider}] fetchChat rate limited`, {
    status: response.status,
    retryAfterMs: retryAfter * 1000,
    elapsedMs: Date.now() - fetchStartedAt
  });
  throw Object.assign(new Error(`${provider} 请求限流：${errorText}`), {
    retryable: true,
    status: response.status,
    errorText,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
  });
}

async function postChat(settings: RuntimeSettings, payload: ChatPayload) {
  const provider = providerLabel(settings);
  const concurrency = llmQueueConcurrency(settings);

  console.info(`[${provider}] postChat entering with concurrency=${concurrency}`, {
    userId: settings.userId,
    model: payload.model,
    stream: Boolean(payload.stream)
  });

  const run = async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      console.info(`[${provider}] postChat attempt ${attempt + 1}/3`, { model: payload.model });
      try {
        const finalPayload = providerPayload(settings, payload);
        return await fetchChat(settings, finalPayload);
      } catch (error) {
        lastError = error;
        const retryable = Boolean((error as { retryable?: boolean })?.retryable)
          || (error instanceof Error && /Timeout|UND_ERR_HEADERS_TIMEOUT|fetch failed/i.test(error.message));

        console.warn(`[${provider}] postChat attempt ${attempt + 1} failed`, {
          retryable,
          errorMessage: error instanceof Error ? error.message : String(error),
          hasRetryAfterMs: !!(error as { retryAfterMs?: number })?.retryAfterMs
        });

        if (!retryable || attempt === 2) throw error;
        const retryAfterMs = (error as { retryAfterMs?: number })?.retryAfterMs ?? 20000 * (attempt + 1);
        console.info(`[${provider}] postChat waiting ${retryAfterMs}ms before retry`, {});
        await delay(retryAfterMs);
      }
    }
    throw lastError;
  };

  const enqueueStart = Date.now();
  console.info(`[${provider}] postChat enqueuing task to llmQueue`);

  const result = await enqueue(run, settings.userId, concurrency);

  console.info(`[${provider}] postChat dequeue and execute completed`, {
    elapsedMs: Date.now() - enqueueStart
  });

  return result;
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

function extractContent(data: unknown): string {
  const choice = (data as { choices?: Array<{ message?: Record<string, unknown>; text?: unknown }> })?.choices?.[0];
  const message = choice?.message;
  const parsed = message?.parsed;
  if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
  if (typeof parsed === "string") return parsed;
  const content = contentBlockToText(message?.content || choice?.text);
  return content.trim() ? content : contentBlockToText(message?.reasoning_content);
}

function extractStreamDelta(data: unknown) {
  const choice = (data as { choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown>; text?: unknown }> })?.choices?.[0];
  const delta = choice?.delta;
  const message = choice?.message;
  return {
    content: contentBlockToText(delta?.content || message?.content || choice?.text),
    reasoning: contentBlockToText(delta?.reasoning_content || message?.reasoning_content)
  };
}

function jsonResponseFormat(
  settings?: RuntimeSettings,
  schemaName?: string,
  schema?: JsonSchema
): ChatPayload["response_format"] {
  // Zai/GLM always uses json_schema format
  if (settings && isZaiProvider(settings) && schema && schemaName) {
    return { type: "json_schema", json_schema: { name: schemaName, schema } };
  }

  // Personal providers use the user-configured response_format mode
  if (!settings || !isPersonalProvider(settings)) {
    return { type: "json_object" };
  }

  const fmt = settings.personalResponseFormat;
  if (fmt === "json_schema" && schema && schemaName) {
    return { type: "json_schema", json_schema: { name: schemaName, schema } };
  }
  // "auto", "none": omit response_format, rely on prompt instructions
  // "json_object": use OpenAI-style json_object (but only if explicitly set below)
  if (fmt === "json_object") {
    return { type: "json_object" };
  }
  return undefined;
}

function withJsonSchemaInstruction(messages: ChatMessage[], schemaName: string, schema: JsonSchema) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const instruction = `\n\n请只输出一个合法 JSON 对象，不要输出 markdown、解释或额外文本。JSON 对象必须符合以下 ${schemaName} schema：\n${JSON.stringify(schema)}`;
  if (lastUserIndex < 0) return messages;
  return messages.map((message, index) => index === lastUserIndex
    ? { ...message, content: `${message.content}${instruction}` }
    : message
  );
}

const dimensionSchema = { type: "string", enum: DIMENSIONS };
const stringArraySchema = { type: "array", items: { type: "string" } };
type GeneratedQuestionPayload = {
  chinese: string;
  answers: string[];
  vocabulary_tips?: string[];
  grammar_focus: string;
  secondary_dimensions?: string[];
  skills?: string[];
  rubric_points?: string[];
};
type DrillCardPayload = {
  casual?: string;
  standard?: string;
  vivid?: string;
  source_cn?: string;
  reference_en?: string;
  grammar_dimension?: string;
  common_mistake?: string;
  memory_hook?: string;
};
type QuestionGenerationSpec = {
  dimension: Dimension;
  difficulty: number;
  paperPosition?: string;
  focusSkills?: string[];
};

const connectionSchema: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" }
  },
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
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function questionBatchSchema(includeVocabularyTips: boolean, count: number): JsonSchema {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: questionSchema(includeVocabularyTips)
      }
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

const assessmentNarrativeSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    weak_points: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "weak_points", "recommendations"],
  additionalProperties: false
};

const studyGuideSchema: JsonSchema = {
  type: "object",
  properties: {
    overview: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why_it_matters: { type: "string" },
          explanation: { type: "string" },
          key_points: { type: "array", items: { type: "string" } },
          patterns: { type: "array", items: { type: "string" } },
          contrast: { type: "array", items: { type: "string" } },
          examples: { type: "array", items: { type: "string" } },
          pitfalls: { type: "array", items: { type: "string" } },
          drills: {
            type: "array",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                answer: { type: "string" },
                explanation: { type: "string" }
              },
              required: ["prompt", "answer", "explanation"],
              additionalProperties: false
            }
          }
        },
        required: ["title", "why_it_matters", "explanation", "key_points", "patterns", "contrast", "examples", "pitfalls", "drills"],
        additionalProperties: false
      }
    },
    checklist: { type: "array", items: { type: "string" } }
  },
  required: ["overview", "sections", "checklist"],
  additionalProperties: false
};

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

function assessmentNarrativeMessages(payload: AssessmentNarrativePayload): ChatMessage[] {
  const sortedMatrix = [...payload.matrix].sort((a, b) => a.score - b.score || a.confidence - b.confidence || a.evidence_count - b.evidence_count);
  return [
    {
      role: "system",
      content: `你是一位严谨的中译英写作能力测评老师。请只输出符合 schema 的 JSON，不要输出 markdown。
报告必须具体、可执行，并且只能基于输入的本地计算事实写作；不要重新判断能力分，不要编造逐题细节。`
    },
    {
      role: "user",
      content: `请根据以下 ReportFacts，生成中文总结报告。LLM 只能解释这些已计算事实，不要重新判断分数或补充不存在的逐题证据。
ReportFacts：${JSON.stringify(payload)}
题量：${payload.total_questions}
能力矩阵：${JSON.stringify(payload.matrix)}
低分优先矩阵：${JSON.stringify(sortedMatrix)}
最弱维度：${JSON.stringify(payload.weakest_dimensions)}
证据不足维度：${JSON.stringify(payload.insufficient_evidence_dimensions)}
高频规范错误标签：${JSON.stringify(payload.top_error_tags)}
高频技能发现：${JSON.stringify(payload.top_skill_findings)}

要求：
1. summary 用 2-4 句话，必须说明整体水平、最弱 1-2 个维度、相对稳定维度，以及置信度/证据量是否足够；不要只说“需要加强”。
2. weak_points 给 3-6 条最需要优先处理的薄弱点，按优先级排序。每条必须包含：维度名称、分数或证据量、具体错误标签或技能发现、为什么影响中译英质量。
3. recommendations 给 3-6 条具体训练建议，必须和 weak_points 一一呼应。每条建议要包含训练动作、练习量或频率、检查标准，例如“连续 3 天每天 5 句”“每句先标主谓宾/时态/从句边界”。
4. 对 evidence_count 为 0 或 confidence 低于 0.5 的维度，不要武断下结论；应写成“证据不足，需要补测确认”。
5. 如果某个维度 score 低于 60，应明确列为优先薄弱点；60-75 写成不稳定；80 以上只在 summary 中作为相对优势提及。
6. 所有内容使用中文，面向学习者，语气直接但不责备。`
    }
  ];
}

function normalizeAssessmentNarrative(parsed: { summary?: string; weak_points?: string[]; recommendations?: string[] }, payload: AssessmentNarrativePayload): AssessmentNarrative {
  const fallback = fallbackAssessmentNarrative(payload);
  const summary = toText(parsed.summary).trim();
  const weakPoints = toTextArray(parsed.weak_points).filter(isMeaningfulText).slice(0, 6);
  const recommendations = toTextArray(parsed.recommendations).filter(isMeaningfulText).slice(0, 6);
  return {
    summary: isMeaningfulText(summary) ? summary : fallback.summary,
    weak_points: weakPoints.length ? weakPoints : fallback.weak_points,
    recommendations: recommendations.length ? recommendations : fallback.recommendations
  };
}

function fallbackStudyGuide(outlines: StudyGuideQuestionOutline[]): StudyGuide {
  const dimensions = [...new Set(outlines.flatMap((item) => [item.dimension, ...(item.secondary_dimensions ?? [])]))];
  const sections = dimensions.length ? dimensions : [DIMENSIONS[0]];
  return {
    overview: `今天的试卷主要涉及${sections.join("、")}。先把这些知识点的判断方法、常见句型和易错点梳理清楚，再进入答题会更稳定。`,
    sections: sections.slice(0, 8).map((dimension) => ({
      title: dimension,
      why_it_matters: "这个知识点会直接影响句子的核心结构是否成立，做题前需要先建立判断顺序。",
      explanation: DIMENSION_FALLBACK_EXPLANATIONS[dimension],
      key_points: DIMENSION_FALLBACK_KEY_POINTS[dimension],
      patterns: DIMENSION_FALLBACK_PATTERNS[dimension],
      contrast: DIMENSION_FALLBACK_CONTRAST[dimension],
      examples: DIMENSION_FALLBACK_EXAMPLES[dimension],
      pitfalls: DIMENSION_FALLBACK_PITFALLS[dimension],
      drills: DIMENSION_FALLBACK_DRILLS[dimension]
    })),
    checklist: [
      "先判断句子的时间、主语和核心谓语，再考虑修饰信息。",
      "遇到固定搭配、冠词和介词时，不要只按中文词序逐字翻译。",
      "写完后检查动词形式、名词单复数、连接关系和信息是否遗漏。"
    ]
  };
}

const DIMENSION_FALLBACK_EXPLANATIONS: Record<Dimension, string> = {
  "时态": "时态的核心是判断动作发生的时间、持续状态和与现在或过去某个时间点的关系。中译英时先确定谓语动词，再决定一般时、进行时、完成时或过去相关形式。",
  "介词搭配": "介词搭配通常来自动词、形容词或名词的固定用法。不能只看中文里的“在、对、为”，要记住英语表达中常见的搭配单位。",
  "定语从句": "定语从句用来修饰前面的名词。先找先行词，再判断关系词在从句里充当主语、宾语、地点、时间或所属关系。",
  "连接词": "连接词负责表达句子之间的逻辑关系，如原因、结果、转折、条件、让步和并列。选择连接词前先说清两部分信息的关系。",
  "被动语态": "被动语态强调动作承受者，基本结构是 be + 过去分词。时态变化体现在 be 动词上，过去分词保持不变。",
  "冠词": "冠词体现名词是否可数、是否首次出现、是否特指。a/an 表泛指单数可数名词，the 表双方都知道或前文已出现的特指对象。"
};

const DIMENSION_FALLBACK_EXAMPLES: Record<Dimension, string[]> = {
  "时态": ["她每天早上读英语。 -> She reads English every morning.", "我们到达时，会议已经开始了。 -> The meeting had started when we arrived."],
  "介词搭配": ["他对这项计划很感兴趣。 -> He is interested in the plan.", "请专注于这个问题。 -> Please focus on this problem."],
  "定语从句": ["我认识那个住在隔壁的老师。 -> I know the teacher who lives next door.", "这是我昨天提到的书。 -> This is the book that I mentioned yesterday."],
  "连接词": ["虽然很晚了，她还是完成了报告。 -> Although it was late, she finished the report.", "如果明天下雨，我们就推迟会议。 -> If it rains tomorrow, we will put off the meeting."],
  "被动语态": ["这封信是昨天写的。 -> The letter was written yesterday.", "这些问题必须今天解决。 -> These problems must be solved today."],
  "冠词": ["我买了一本书。这本书很有用。 -> I bought a book. The book is useful.", "她是一名工程师。 -> She is an engineer."]
};

const DIMENSION_FALLBACK_KEY_POINTS: Record<Dimension, string[]> = {
  "时态": ["先找时间线索，再确定谓语动词。", "一个完整句子通常只能有一个核心谓语，其他动作要处理成从句、非谓语或并列结构。", "完成时强调“对某个时间点已有影响或结果”，不是简单的“已经”。"],
  "介词搭配": ["把动词、形容词、名词和介词作为搭配整体记忆。", "同一个中文介词在英文里可能对应不同介词。", "介词后面接名词、代词或动名词。"],
  "定语从句": ["先行词决定关系词选择。", "关系词在从句里必须承担语法成分。", "从句修饰名词，不要把主句谓语挤进从句。"],
  "连接词": ["先判断两部分信息的逻辑关系。", "从属连词引导从句，并列连词连接同等结构。", "英文通常避免 because 和 so 重复连接同一组因果。"],
  "被动语态": ["动作承受者作主语时优先考虑被动。", "be 动词体现时态和主谓一致。", "过去分词不能代替完整谓语。"],
  "冠词": ["先判断名词是否可数，再判断是否单数。", "首次泛指用 a/an，再次提到或双方已知用 the。", "抽象名词、复数泛指和不可数名词常用零冠词。"]
};

const DIMENSION_FALLBACK_PATTERNS: Record<Dimension, string[]> = {
  "时态": ["一般过去时：主语 + 动词过去式 + 过去时间。", "现在完成时：主语 + have/has + 过去分词。", "过去完成时：主语 + had + 过去分词 + by/before/when..."],
  "介词搭配": ["be interested in + 名词/动名词", "focus on + 名词/动名词", "be responsible for + 名词/动名词"],
  "定语从句": ["人 + who/that + 谓语", "物 + which/that + 谓语", "地点 + where + 完整句子"],
  "连接词": ["Because + 原因从句, 主句。", "Although + 让步从句, 主句。", "If + 条件从句, 主句。"],
  "被动语态": ["一般现在时被动：am/is/are + 过去分词", "一般过去时被动：was/were + 过去分词", "情态动词被动：must/can/should + be + 过去分词"],
  "冠词": ["a/an + 单数可数名词", "the + 特指名词", "零冠词 + 复数泛指/不可数泛指"]
};

const DIMENSION_FALLBACK_CONTRAST: Record<Dimension, string[]> = {
  "时态": ["一般过去时讲过去事实；现在完成时强调现在相关结果。", "过去完成时表示过去的过去，通常需要另一个过去时间点作参照。"],
  "介词搭配": ["look at 强调看；look for 强调寻找；look after 强调照顾。", "good at 是擅长；good for 是有益于。"],
  "定语从句": ["who/which/that 在从句中可作主语或宾语；where/when 通常作状语。", "关系词作宾语时，后面不要再重复宾语代词。"],
  "连接词": ["although 表让步，不等于 but；because 表原因，不等于 so。", "and 连接并列信息；but 连接转折信息。"],
  "被动语态": ["主动语态强调执行者；被动语态强调承受者或结果。", "was done 是过去被动；has been done 是现在完成被动。"],
  "冠词": ["a/an 表某一个；the 表这个/那个已确定对象。", "school 泛指上学活动时可零冠词；the school 指具体学校。"]
};

const DIMENSION_FALLBACK_PITFALLS: Record<Dimension, string[]> = {
  "时态": ["看到中文没有明显时间词就忽略谓语形式。", "完成时和一般过去时混用。"],
  "介词搭配": ["按中文逐字选择介词。", "把固定搭配中的介词漏掉。"],
  "定语从句": ["关系词后重复写先行词。", "从句动词形式没有跟从句主语一致。"],
  "连接词": ["because 和 so 在同一个英文句子里重复表达因果。", "转折、让步和条件关系混用。"],
  "被动语态": ["只写过去分词，漏掉 be 动词。", "没有根据时态改变 be 的形式。"],
  "冠词": ["单数可数名词前漏冠词。", "首次出现和再次特指都用同一个冠词。"]
};

const DIMENSION_FALLBACK_DRILLS: Record<Dimension, StudyGuide["sections"][number]["drills"]> = {
  "时态": [
    { prompt: "把“他昨晚给我打电话”译成英文。", answer: "He called me last night.", explanation: "last night 表明过去时间，谓语 call 要用过去式 called。" },
    { prompt: "把“我已经完成作业了”译成英文。", answer: "I have finished my homework.", explanation: "强调现在已经完成的结果，用 have + 过去分词。" }
  ],
  "介词搭配": [
    { prompt: "把“她擅长数学”译成英文。", answer: "She is good at math.", explanation: "擅长某事使用 be good at，不用 in 或 on。" },
    { prompt: "把“我们正在等待结果”译成英文。", answer: "We are waiting for the result.", explanation: "wait for 是固定搭配，for 不能省略。" }
  ],
  "定语从句": [
    { prompt: "把“那个正在唱歌的女孩是我妹妹”译成英文。", answer: "The girl who is singing is my sister.", explanation: "先行词是人，关系词 who 在从句中作主语。" },
    { prompt: "把“我喜欢你推荐的电影”译成英文。", answer: "I like the movie that you recommended.", explanation: "movie 是先行词，that 在从句中作 recommended 的宾语。" }
  ],
  "连接词": [
    { prompt: "把“因为路很滑，我们走得很慢”译成英文。", answer: "Because the road was slippery, we walked slowly.", explanation: "because 引导原因从句，主句说明结果。" },
    { prompt: "把“如果你需要帮助，请告诉我”译成英文。", answer: "If you need help, please tell me.", explanation: "if 引导条件从句，主句给出条件成立时的动作。" }
  ],
  "被动语态": [
    { prompt: "把“这个房间每天都被打扫”译成英文。", answer: "This room is cleaned every day.", explanation: "room 是动作承受者，一般现在时被动用 is cleaned。" },
    { prompt: "把“这个决定将由经理宣布”译成英文。", answer: "The decision will be announced by the manager.", explanation: "将来被动结构是 will be + 过去分词。" }
  ],
  "冠词": [
    { prompt: "把“她想买一把伞”译成英文。", answer: "She wants to buy an umbrella.", explanation: "umbrella 是单数可数名词且以元音音素开头，泛指用 an。" },
    { prompt: "把“太阳今天很亮”译成英文。", answer: "The sun is bright today.", explanation: "sun 是独一无二的事物，通常用定冠词 the。" }
  ]
};

function normalizeStudyGuide(parsed: Partial<StudyGuide>, outlines: StudyGuideQuestionOutline[]): StudyGuide {
  const fallback = fallbackStudyGuide(outlines);
  function normalizeDrills(value: unknown): StudyGuide["sections"][number]["drills"] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
      if (typeof item === "string") {
        return { prompt: item, answer: "", explanation: "" };
      }
      if (!item || typeof item !== "object") return undefined;
      const raw = item as Record<string, unknown>;
      return {
        prompt: toText(raw.prompt).trim(),
        answer: toText(raw.answer).trim(),
        explanation: toText(raw.explanation).trim()
      };
    }).filter((item): item is StudyGuide["sections"][number]["drills"][number] => Boolean(item?.prompt)).slice(0, 4);
  }
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections.map((section) => ({
      title: toText(section?.title).trim(),
      why_it_matters: toText(section?.why_it_matters).trim(),
      explanation: toText(section?.explanation).trim(),
      key_points: toTextArray(section?.key_points).filter(isMeaningfulText).slice(0, 8),
      patterns: toTextArray(section?.patterns).filter(isMeaningfulText).slice(0, 8),
      contrast: toTextArray(section?.contrast).filter(isMeaningfulText).slice(0, 8),
      examples: toTextArray(section?.examples).filter(isMeaningfulText).slice(0, 4),
      pitfalls: toTextArray(section?.pitfalls).filter(isMeaningfulText).slice(0, 4),
      drills: normalizeDrills(section?.drills)
    })).filter((section) => Boolean(section.title) && isMeaningfulText(section.explanation)).slice(0, 8)
    : [];
  const checklist = toTextArray(parsed.checklist).filter(isMeaningfulText).slice(0, 8);
  return {
    overview: isMeaningfulText(parsed.overview) ? toText(parsed.overview).trim() : fallback.overview,
    sections: sections.length ? sections : fallback.sections,
    checklist: checklist.length ? checklist : fallback.checklist
  };
}

function estimateGeneratedTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 2));
}

function elapsedMsSince(startedAt: number) {
  return Date.now() - startedAt;
}

function formatChatMessagesForLog(messages: ChatMessage[]) {
  return messages.map((message) => `${message.role}:\n${message.content}`).join("\n\n---\n\n");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function validateAssessmentNarrative(value: Partial<AssessmentNarrative>) {
  const weakPoints = value.weak_points;
  const recommendations = value.recommendations;
  if (!isMeaningfulText(value.summary)) throw new Error("summary 缺失或内容过短");
  if (!isStringArray(weakPoints) || !weakPoints.length) throw new Error("weak_points 必须是非空字符串数组");
  if (!isStringArray(recommendations) || !recommendations.length) throw new Error("recommendations 必须是非空字符串数组");
}

async function readChatStream(
  res: Response,
  onProgress?: (progress: AssessmentNarrativeStreamProgress) => void
) {
  if (!res.body) throw new Error("模型流式响应为空");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finalTokens: number | undefined;
  let chunkCount = 0;
  let totalBytes = 0;
  let eventCount = 0;

  console.info("[readChatStream] Start reading stream");

  async function handleEvent(rawEvent: string) {
    eventCount += 1;
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) {
      if (rawEvent.trim()) {
        console.warn(`[readChatStream] Event #${eventCount} does not start with 'data:':`, { rawEvent });
      }
      return false;
    }
    const dataText = dataLines.join("\n").trim();
    if (!dataText || dataText === "[DONE]") {
      console.info(`[readChatStream] Event #${eventCount} is empty or [DONE]`, { dataText });
      return dataText === "[DONE]";
    }
    let data: unknown;
    try {
      data = JSON.parse(dataText);
    } catch (error) {
      console.error("[readChatStream] LLM upstream SSE JSON parse failed", {
        eventIndex: eventCount,
        dataText,
        rawEvent,
        error
      });
      throw new Error(`上游 LLM 流式 JSON 解析失败：${error instanceof Error ? error.message : "未知解析错误"}`);
    }

    if (data && typeof data === "object" && "error" in data) {
      console.error("[readChatStream] LLM upstream returned error payload inside stream", data);
    }

    const delta = extractStreamDelta(data);
    if (delta.content) content += delta.content;
    if (delta.reasoning) reasoning += delta.reasoning;
    const usage = (data as { usage?: { completion_tokens?: unknown } }).usage;
    if (typeof usage?.completion_tokens === "number") finalTokens = usage.completion_tokens;
    const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const generatedText = content + reasoning;
    const estimatedTokens = finalTokens ?? estimateGeneratedTokens(generatedText);
    onProgress?.({
      generatedChars: generatedText.length,
      estimatedTokens,
      tokensPerSecond: Number((estimatedTokens / elapsedSeconds).toFixed(1)),
      finalTokens,
      deltaContent: delta.content || undefined,
      deltaReasoning: delta.reasoning || undefined
    });
    return false;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      chunkCount += 1;
      totalBytes += value.length;
      console.info(`[readChatStream] Received chunk #${chunkCount}, size: ${value.length} bytes, total: ${totalBytes} bytes`);

      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (await handleEvent(event)) {
          console.info("[readChatStream] Stream finished via [DONE] event", {
            elapsedMs: Date.now() - startedAt,
            chunkCount,
            totalBytes,
            eventCount,
            contentLen: content.length,
            reasoningLen: reasoning.length,
            finalTokens
          });
          return { content, reasoning, finalTokens };
        }
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    console.info("[readChatStream] Processing remaining buffer after stream done");
    await handleEvent(buffer);
  }
  console.info("[readChatStream] Stream finished", {
    elapsedMs: Date.now() - startedAt,
    chunkCount,
    totalBytes,
    eventCount,
    contentLen: content.length,
    reasoningLen: reasoning.length,
    finalTokens
  });
  return { content, reasoning, finalTokens };
}

async function chat<T>(settings: Settings, messages: ChatMessage[], schemaName: string, schema: JsonSchema, options: { thinking?: boolean } = {}): Promise<T> {
  const startedAt = Date.now();
  const runtimeSettings = settings as RuntimeSettings;
  const provider = providerLabel(runtimeSettings);
  const model = isPersonalProvider(runtimeSettings) ? runtimeSettings.personalModel : settings.model;

  console.info(`[${provider}] chat begin`, {
    schemaName,
    model,
    temperature: settings.temperature,
    thinking: Boolean(options.thinking),
    messageCount: messages.length,
    endpoint: chatEndpoint(runtimeSettings),
    elapsedMs: elapsedMsSince(startedAt)
  });

  console.info(`[${provider}] chat messages preview`, {
    messages: formatChatMessagesForLog(messages).slice(0, 2000),
    elapsedMs: elapsedMsSince(startedAt)
  });

  ensureChatSettings(runtimeSettings);
  console.info(`[${provider}] chat settings validated`, { elapsedMs: elapsedMsSince(startedAt) });

  const thinking = Boolean(options.thinking);
  const responseFormat = jsonResponseFormat(runtimeSettings, schemaName, schema);
  console.info(`[${provider}] chat response_format built`, {
    formatType: responseFormat?.type,
    schemaName: responseFormat && "json_schema" in responseFormat ? responseFormat.json_schema.name : null,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const processedMessages = withJsonSchemaInstruction(messages, schemaName, schema);
  console.info(`[${provider}] chat messages processed with schema instruction`, {
    originalCount: messages.length,
    processedCount: processedMessages.length,
    lastMessageChars: processedMessages[processedMessages.length - 1]?.content.length ?? 0,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const payload: ChatPayload = {
    model,
    temperature: settings.temperature,
    response_format: responseFormat,
    messages: processedMessages,
    thinking: { type: thinking ? "enabled" : "disabled" }
  };

  console.info(`[${provider}] chat payload ready`, {
    payloadBytes: JSON.stringify(payload).length,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const res = await postChat(settings, payload);

  console.info(`[${provider}] chat response received from HTTP`, {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
    elapsedMs: elapsedMsSince(startedAt)
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[${provider}] chat HTTP error`, {
      status: res.status,
      bodyPreview: preview(errorBody),
      elapsedMs: elapsedMsSince(startedAt)
    });
    throw new Error(`${provider} 请求失败：${res.status} ${errorBody}`);
  }

  console.info(`[${provider}] chat reading response JSON...`, { elapsedMs: elapsedMsSince(startedAt) });
  const data = await res.json();

  console.info(`[${provider}] chat response JSON read`, {
    hasChoices: !!(data as Record<string, unknown>)?.choices,
    choiceCount: Array.isArray((data as Record<string, unknown>)?.choices) ? ((data as Record<string, unknown>).choices as unknown[]).length : 0,
    responseDataBytes: JSON.stringify(data).length,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const content = extractContent(data);
  console.info(`[${provider}] chat content extracted`, {
    contentChars: content.length,
    contentPreview: preview(content),
    elapsedMs: elapsedMsSince(startedAt)
  });

  try {
    const result = parseJson<T>(content);
    console.info(`[${provider}] chat JSON parsed successfully`, {
      schemaName,
      contentChars: content.length,
      resultKeys: typeof result === "object" && result !== null ? Object.keys(result).join(", ") : "non-object",
      elapsedMs: elapsedMsSince(startedAt)
    });
    return result;
  } catch (error) {
    console.error(`[${provider}] chat structured output parse failed`, {
      schemaName,
      contentChars: content.length,
      contentPreview: preview(content),
      responsePreview: preview(data),
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: elapsedMsSince(startedAt)
    });
    throw error;
  }
}

async function chatText(settings: Settings, messages: ChatMessage[]): Promise<string> {
  const startedAt = Date.now();
  const runtimeSettings = settings as RuntimeSettings;
  const provider = providerLabel(runtimeSettings);
  const model = isPersonalProvider(runtimeSettings) ? runtimeSettings.personalModel : settings.model;

  console.info(`[${provider}] chatText begin`, {
    model,
    temperature: settings.temperature,
    messageCount: messages.length,
    endpoint: chatEndpoint(runtimeSettings),
    elapsedMs: elapsedMsSince(startedAt)
  });

  console.info(`[${provider}] chatText messages preview`, {
    messages: formatChatMessagesForLog(messages).slice(0, 2000),
    elapsedMs: elapsedMsSince(startedAt)
  });

  ensureChatSettings(runtimeSettings);
  console.info(`[${provider}] chatText settings validated`, { elapsedMs: elapsedMsSince(startedAt) });

  const payload: ChatPayload = {
    model,
    temperature: settings.temperature,
    messages,
    thinking: { type: "disabled" }
  };

  console.info(`[${provider}] chatText payload ready`, {
    payloadBytes: JSON.stringify(payload).length,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const res = await postChat(settings, payload);

  console.info(`[${provider}] chatText response received from HTTP`, {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
    elapsedMs: elapsedMsSince(startedAt)
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[${provider}] chatText HTTP error`, {
      status: res.status,
      bodyPreview: preview(errorBody),
      elapsedMs: elapsedMsSince(startedAt)
    });
    throw new Error(`${provider} 请求失败：${res.status} ${errorBody}`);
  }

  console.info(`[${provider}] chatText reading response JSON...`, { elapsedMs: elapsedMsSince(startedAt) });
  const data = await res.json();

  console.info(`[${provider}] chatText response JSON read`, {
    responseDataBytes: JSON.stringify(data).length,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const content = stripThinking(extractContent(data)).trim();

  console.info(`[${provider}] chatText completed`, {
    contentChars: content.length,
    contentPreview: preview(content),
    elapsedMs: elapsedMsSince(startedAt)
  });

  if (!content) throw new Error("AI 没有返回追问解答");
  return content;
}

async function chatTextStream(settings: Settings, messages: ChatMessage[], onProgress?: (progress: TextStreamProgress) => void): Promise<string> {
  const startedAt = Date.now();
  const runtimeSettings = settings as RuntimeSettings;
  const provider = providerLabel(runtimeSettings);
  const model = isPersonalProvider(runtimeSettings) ? runtimeSettings.personalModel : settings.model;

  console.info(`[${provider}] chatTextStream begin`, {
    model,
    temperature: settings.temperature,
    messageCount: messages.length,
    endpoint: chatEndpoint(runtimeSettings),
    elapsedMs: elapsedMsSince(startedAt)
  });

  console.info(`[${provider}] chatTextStream messages preview`, {
    messages: formatChatMessagesForLog(messages).slice(0, 2000),
    elapsedMs: elapsedMsSince(startedAt)
  });

  ensureChatSettings(runtimeSettings);
  console.info(`[${provider}] chatTextStream settings validated`, { elapsedMs: elapsedMsSince(startedAt) });

  const payload: ChatPayload = {
    model,
    temperature: settings.temperature,
    messages,
    thinking: { type: "disabled" },
    stream: true
  };

  console.info(`[${provider}] chatTextStream payload ready`, {
    payloadBytes: JSON.stringify(payload).length,
    elapsedMs: elapsedMsSince(startedAt)
  });

  const res = await postChat(settings, payload);

  console.info(`[${provider}] chatTextStream response received from HTTP`, {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
    elapsedMs: elapsedMsSince(startedAt)
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[${provider}] chatTextStream HTTP error`, {
      status: res.status,
      bodyPreview: preview(errorBody),
      elapsedMs: elapsedMsSince(startedAt)
    });
    throw new Error(`${provider} 请求失败：${res.status} ${errorBody}`);
  }

  console.info(`[${provider}] chatTextStream starting to read stream...`, { elapsedMs: elapsedMsSince(startedAt) });

  const streamed = await readChatStream(res, (progress) => {
    const content = stripThinking(progress.deltaContent || "");
    if (content || progress.finalTokens !== undefined) {
      console.info(`[${provider}] chatTextStream delta`, {
        deltaChars: content.length,
        generatedChars: progress.generatedChars,
        estimatedTokens: progress.estimatedTokens,
        tokensPerSecond: progress.tokensPerSecond,
        finalTokens: progress.finalTokens,
        delta: preview(content),
        elapsedMs: elapsedMsSince(startedAt)
      });
    }
    onProgress?.({
      content,
      generatedChars: progress.generatedChars,
      estimatedTokens: progress.estimatedTokens,
      tokensPerSecond: progress.tokensPerSecond,
      finalTokens: progress.finalTokens,
      deltaContent: content || undefined,
      deltaReasoning: progress.deltaReasoning
    });
  });

  const content = stripThinking(streamed.content).trim();

  console.info(`[${provider}] chatTextStream completed`, {
    contentChars: content.length,
    finalTokens: streamed.finalTokens,
    elapsedMs: elapsedMsSince(startedAt),
    contentPreview: preview(content)
  });

  if (!content) throw new Error("AI 没有返回追问解答");
  return content;
}

export async function testConnection(settings: RuntimeSettings) {
  ensureChatSettings(settings);
  const tests: ConnectionTestItem[] = [];

  console.log("[testConnection] Start — model:", settings.model, "provider:", providerLabel(settings));

  async function runTest(key: string, label: string, test: () => Promise<string>) {
    console.log(`[testConnection] Running test: ${label}`);
    try {
      const detail = await test();
      tests.push({ key, label, ok: true, detail });
      console.log(`[testConnection] ✅ ${label}: ${detail}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "测试失败";
      tests.push({ key, label, ok: false, detail: msg });
      console.error(`[testConnection] ❌ ${label}: ${msg}`);
    }
  }

  await runTest("structured_json", "JSON 模式结构化输出", async () => {
    console.log("[testConnection][structured_json] Calling chat with JSON schema...");
    const result = await chat<{ ok: boolean }>(settings, [
      { role: "system", content: "你是 AI 模型。请严格按要求的 JSON 格式返回结果，不要输出额外文本。" },
      { role: "user", content: "返回连接状态 ok 为 true。" }
    ], "connection_test", connectionSchema);
    console.log("[testConnection][structured_json] chat response:", JSON.stringify(result));
    if (result.ok !== true) throw new Error("ok 字段不是 true");
    return "结构化 JSON 响应与解析成功";
  });

  await runTest("structured_thinking", "thinking 结构化输出", async () => {
    console.log("[testConnection][structured_thinking] Calling chat with thinking enabled...");
    const result = await chat<AssessmentNarrative>(settings, [
      { role: "system", content: "你是一位英语写作测评老师。请按要求返回中文 JSON。" },
      { role: "user", content: "生成一个极短测评摘要：指出时态需要练习，并给 1 条薄弱点和 1 条建议。" }
    ], "assessment_narrative", assessmentNarrativeSchema, { thinking: true });
    console.log("[testConnection][structured_thinking] chat response keys:", Object.keys(result).join(", "));
    validateAssessmentNarrative(result);
    console.log("[testConnection][structured_thinking] validation passed");
    return "thinking 请求与结构化字段校验通过";
  });

  await runTest("plain_text", "普通文本追问", async () => {
    console.log("[testConnection][plain_text] Calling chatText...");
    const text = await chatText(settings, [
      { role: "system", content: "你是英语写作教练。回答必须简短。" },
      { role: "user", content: "用中文回答：连接测试正常。" }
    ]);
    console.log(`[testConnection][plain_text] received ${text.trim().length} chars`);
    if (!text.trim()) throw new Error("普通文本返回为空");
    return `无 response_format 的文本回复可读取，返回 ${text.trim().length} 个字符`;
  });

  await runTest("streaming", "流式结构化输出", async () => {
    console.log("[testConnection][streaming] Building messages and sending streaming request...");
    const model = isPersonalProvider(settings) ? settings.personalModel : settings.model;
    const messages = withJsonSchemaInstruction(assessmentNarrativeMessages({
      total_questions: 1,
      matrix: DIMENSIONS.map((dimension, index) => ({
        dimension,
        score: index === 0 ? 55 : 80,
        confidence: index === 0 ? 0.4 : 0.8,
        evidence_count: 1
      })),
      weakest_dimensions: [{ dimension: "时态", score: 55, confidence: 0.4, evidence_count: 1 }],
      insufficient_evidence_dimensions: ["时态"],
      top_error_tags: [{ tag: "tense_error", count: 1 }],
      top_skill_findings: [{ skill: "过去式不稳定", count: 1 }]
    }), "assessment_narrative", assessmentNarrativeSchema);
    console.log("[testConnection][streaming] Messages built, calling postChat with stream:true...");
    const response = await postChat(settings, {
      model,
      temperature: settings.temperature,
      response_format: jsonResponseFormat(settings, "assessment_narrative", assessmentNarrativeSchema),
      messages,
      thinking: { type: "enabled" },
      stream: true
    });
    console.log(`[testConnection][streaming] HTTP response: ${response.status} ${response.ok ? 'OK' : 'FAIL'}`);
    if (!response.ok) throw new Error(`流式请求失败：${response.status} ${await response.text()}`);
    console.log("[testConnection][streaming] Reading stream...");
    const streamed = await readChatStream(response);
    console.log(`[testConnection][streaming] Stream done — content: ${streamed.content?.length ?? 0} chars, reasoning: ${streamed.reasoning?.length ?? 0} chars`);
    const content = streamed.content.trim() ? streamed.content : streamed.reasoning;
    const parsed = parseJson<AssessmentNarrative>(content);
    console.log("[testConnection][streaming] JSON parsed, validating...");
    validateAssessmentNarrative(parsed);
    return "JSON 流解析成功";
  });

  console.log("[testConnection] Summary:", tests.map(t => `${t.label}: ${t.ok ? 'PASS' : 'FAIL'}`).join(", "));

  if (tests.some((item) => !item.ok)) {
    const failed = tests.filter((item) => !item.ok).map((item) => `${item.label}：${item.detail}`).join("；");
    throw Object.assign(new Error(`${providerLabel(settings as RuntimeSettings)} 连接测试未全部通过：${failed}`), {
      connectionTestResult: { tests } satisfies ConnectionTestResult
    });
  }

  console.log("[testConnection] All tests passed");
  return { tests };
}

export async function generateQuestion(
  settings: Settings,
  dimension: Dimension,
  difficulty: number,
  includeVocabularyTips = false,
  previousQuestions: string[] = [],
  regenerateReason = "",
  paperPosition = "",
  options: { thinking?: boolean; focusSkills?: string[] } = {}
): Promise<Question> {
  const parsed = await chat<GeneratedQuestionPayload>(settings, [
    {
      role: "system",
      content:
        "你是一位专业的英语写作训练出题老师，母语为中文。请按结构化输出 schema 填写字段。"
    },
    {
      role: "user",
      content: questionGenerationPrompt({
        count: 1,
        includeVocabularyTips,
        previousQuestions,
        regenerateReason,
        specs: [{ dimension, difficulty, paperPosition, focusSkills: options.focusSkills }]
      })
    }
  ], includeVocabularyTips ? "assessment_question" : "practice_question", questionSchema(includeVocabularyTips), options);
  return normalizeGeneratedQuestion(parsed, dimension, difficulty, includeVocabularyTips);
}

export async function generateQuestions(
  settings: Settings,
  specs: QuestionGenerationSpec[],
  includeVocabularyTips = false,
  previousQuestions: string[] = [],
  regenerateReason = "",
  options: { thinking?: boolean } = {}
): Promise<Question[]> {
  const normalizedSpecs = specs
    .filter((spec) => DIMENSIONS.includes(spec.dimension))
    .map((spec) => ({
      ...spec,
      difficulty: Math.max(1, Math.min(100, Math.round(Number(spec.difficulty) || 50))),
      focusSkills: spec.focusSkills?.filter(Boolean).slice(0, 5) ?? []
    }));
  if (normalizedSpecs.length < 1) return [];
  const parsed = await chat<{ questions?: GeneratedQuestionPayload[] }>(settings, [
    {
      role: "system",
      content:
        "你是一位专业的英语写作训练出题老师，母语为中文。请一次性完成整张试卷出题，并按结构化输出 schema 填写字段。"
    },
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
  ], includeVocabularyTips ? "assessment_question_batch" : "practice_question_batch", questionBatchSchema(includeVocabularyTips, normalizedSpecs.length), options);
  const questions = parsed.questions ?? [];
  if (questions.length !== normalizedSpecs.length) {
    throw new Error(`AI 返回的题目数量不正确：需要 ${normalizedSpecs.length} 道，实际 ${questions.length} 道`);
  }
  return questions
    .map((question, index) => normalizeGeneratedQuestion(
      question,
      normalizedSpecs[index].dimension,
      normalizedSpecs[index].difficulty,
      includeVocabularyTips
    ));
}

function questionGenerationPrompt(input: {
  count: number;
  includeVocabularyTips: boolean;
  previousQuestions: string[];
  regenerateReason?: string;
  specs: QuestionGenerationSpec[];
}) {
  const avoidList = input.previousQuestions
    .filter(Boolean)
    .slice(-20)
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
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
1. 中文句子必须像日常微信、课堂、办公室、家里、路上、购物、吃饭、约时间、请假、催进度、邻里闲聊中真实会说的话；先保证生活化，再考虑语法覆盖。
2. 尽量使用初级英语词汇和常见生活场景，避免生僻词、抽象名词、复杂专业表达。题目必须贴近实际生活场景，不要生搬硬套。
3. 主要难点必须来自语法结构，而不是词汇理解。
4. 每题围绕 1 个主维度即可；只有在不破坏日常表达的前提下，才自然嵌入 1-2 个可独立评分的次要维度。禁止为了凑考点把多个语法结构硬塞进一句话。
5. 中文题干建议 12-28 个汉字；最多 2 个分句。宁可短而真实，也不要写成长段、复杂叙事或阅读理解题。
6. 英文参考答案以短句或中等长度句子为主，优先使用常见词；不要为了提高难度使用高级词汇。
7. 让多个考点共同服务同一个真实表达场景。例如主考被动语态时，可同时嵌入时态、冠词或介词搭配；主考连接词时，可同时嵌入时态、冠词或定语从句。
8. 避免把多个互不相关的短句机械拼接成一道题；每个次要维度都必须能从用户译文中明确判断对错。
9. answers 必须且只能给 1 个最佳英文参考答案，不要给第二个变体；即使存在多种自然译法，也只选择最适合作为本题标准答案的一种。
10. grammar_focus 必须说明主考点和自然嵌入的次要考点，例如“一般过去时 + 时间介词 + 特指冠词”。
${input.includeVocabularyTips ? "11. vocabulary_tips 只给 0-5 个关键英文单词原型，例如 go、make、book；禁止给短语、变形、介词搭配、冠词、时态形式、从句结构或任何会透露语法答案的内容。" : "11. 不要返回 vocabulary_tips。"}
12. 不要生成和已生成题目语义相同、场景相同或句式结构高度相似的题目；本次返回的多道题之间也必须更换人物、动作、场景和句法结构。
13. 生成前先在内部规划整张试卷：家庭、学校、工作、购物、出行、健康、约定、通知、邻里、学习等场景尽量分散；不要连续使用同一种人物关系、时间状语、开头结构或谓语动作。
14. 每道题的中文题干首词、核心动词、时间表达和英文句型骨架都应尽量不同；禁止通过替换人名或地点来制造表面差异。
15. secondary_dimensions 给 1-2 个本题自然涉及且可独立评分的次要维度，只能从：${DIMENSIONS.join("、")} 中选择，且不能包含主维度；如果强行加入会让题目像教材例句，宁可只给 1 个。
16. skills 会在做题前展示给用户，必须公平但不能泄题。写成 2-4 个短中文抽象能力点，禁止出现任何英文字母、英文答案片段、具体介词短语、具体动词变形、过去分词、be 动词选项、完整公式或当前句子的专有内容。例如可写“一般过去时被动语态”“施事者引出”“副词修饰谓语”“习惯表达辨析”，不要写“was/were + past participle”“pass 的过去分词 passed”“by all the shareholders”“because + 主谓结构”“am/is/are doing”“By + 过去时间”“read three chapters”。
17. 如果某个句式是硬性要求，skills 只能用中文概念点提示，例如“原因状语从句”“现在进行时”“习惯表达辨析”，不要给出完整英文套用公式；rubric_points 可包含内部细则，但不要把 skills 没有明确展示的特定参考句式设为唯一正确答案，自然等价表达应允许得分。
18. 禁止生成明显教材化、百科化、脱离日常的模板句，例如“世界上最高的山”“2010 年修建的桥”“我见过最漂亮的花”“桌子上有一支红色的笔”“正在唱歌的女孩”“经常穿红衣服的女孩”“这封信由我父亲写的”。如果需要考查同类语法，改成真实场景，例如快递、会议、作业、请假、邻居借东西、同事改文件、朋友约饭、家人提醒等。
19. 避免连续使用“他/她/那个/这座/这封/当我/虽然/尽管/因为”开头；同一批题要有口语化动作和具体但普通的生活细节。
${avoidList ? `已生成题目，必须避开：\n${avoidList}` : "本轮还没有已生成题目。"}
${input.regenerateReason ? `用户要求重生成的原因：${input.regenerateReason}` : ""}`;
}

function normalizeGeneratedQuestion(
  parsed: GeneratedQuestionPayload,
  dimension: Dimension,
  difficulty: number,
  includeVocabularyTips: boolean
): Question {
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
  return {
    ...question,
    difficulty_b: calibration.difficulty_b,
    calibration_issues: calibration.issues,
    calibration_passed: calibration.passed
  };
}

function normalizeDrillCard(parsed: DrillCardPayload, sourceCn: string): DrillCard {
  const standard = toText(parsed.standard).trim();
  const dimension = (DIMENSIONS as readonly string[]).includes(String(parsed.grammar_dimension))
    ? parsed.grammar_dimension as Dimension
    : "连接词";
  if (!isMeaningfulText(sourceCn)) throw new Error("中文场景内容过短");
  if (!isMeaningfulText(standard)) throw new Error("AI 返回的 standard 为空或过短");
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

export async function generateDrillCard(settings: Settings, sourceCn: string): Promise<DrillCard> {
  const trimmedSource = sourceCn.trim();
  const parsed = await chat<DrillCardPayload>(settings, [
    {
      role: "system",
      content: "你是一位面向中文母语者的英语表达教练。请只输出符合 schema 的 JSON，不要输出 markdown、解释文字或代码块。你的任务是把用户的中文个人场景，转成可练习的英文表达卡。"
    },
    {
      role: "user",
      content: `中文个人场景：
${trimmedSource}

请生成一个中译英表达 Drill Card。

要求：
1. casual 是自然口语版本，适合朋友、同事轻松交流。
2. standard 是标准版本，清楚、通用、语法稳定；它会作为 reference_en。
3. vivid 是更生动但不过度高级的版本。
4. source_cn 必须保留用户原始中文场景，不要改写。
5. reference_en 必须等于 standard。
6. grammar_dimension 只能从以下 6 个值中选 1 个：${DIMENSIONS.join("、")}。
7. common_mistake 写一个中文母语者表达这个场景时最容易犯的具体错误。
8. memory_hook 写一个和中文概念绑定的简短记忆钩子，帮助用户下次想起正确英文。
9. 英文表达优先自然、生活化、可复用；不要写教材腔或复杂长句。
10. 只返回 JSON，结构必须完全如下：

{
  "casual": "...",
  "standard": "...",
  "vivid": "...",
  "source_cn": "...",
  "reference_en": "...",
  "grammar_dimension": "...",
  "common_mistake": "...",
  "memory_hook": "..."
}`
    }
  ], "drill_card", drillCardSchema);
  return normalizeDrillCard(parsed, trimmedSource);
}

export async function gradeAnswer(settings: Settings, question: Question, userAnswer: string): Promise<GradeResult> {
  const parsed = await chat<GradeResult>(settings, [
    {
      role: "system",
      content: `你是一位专业的英语语法教师，母语为中文。
用户正在练习将中文句子翻译成英文。
请按结构化输出 schema 填写批改结果。memory_tip 如无必要可返回空字符串。`
    },
    {
      role: "user",
      content: `中文原句：${question.chinese}
考查维度：${question.dimension}
次要维度：${question.secondary_dimensions?.join("、") || "无"}
考查语法点（内部参考，做题前不一定展示）：${question.grammar_focus}
做题前可见技能标签：${question.skills?.join("、") || "无"}
批改要点（内部参考，做题前不一定展示）：${question.rubric_points?.join("；") || "按题目语法点批改"}
参考答案：${question.answers.join(" / ")}
用户译文：${userAnswer}

请判断：正确、基本正确（仅限非核心小瑕疵）或错误。即使意思接近，也要指出语法、搭配、冠词、时态、语序等问题。
reference_answers 必须且只能给 1 个最佳英文参考答案，不要给第二个变体；如果原参考答案可用，优先沿用原参考答案，禁止返回空数组。
dimension_scores 必须覆盖主维度；如果次要维度有明确证据，也要分别给出。score 表示该维度本题表现，不是总能力分，必须使用 0-100 百分制。
skill_findings 尽量对应“本题技能标签”中的具体技能；如果用户暴露了更具体的薄弱点，也可以补充短标签，不要只写大类薄弱。
score、verdict、severity 和 notes 必须一致：correct 通常为 80-100，partial 通常为 45-79，wrong 通常为 0-44。
公平性原则：评分以中文原句、考查维度、做题前可见技能标签为硬标准。grammar_focus、rubric_points 和参考答案只能帮助理解题意，不能把做题前不可见的特定参考句式当成唯一正确答案。
如果可见技能标签没有明确写出某个固定句式，用户使用自然、语义等价且符合考查维度的表达时，不要仅因未使用参考答案句式而判 wrong。例如“习惯每天做某事”可用 usually do 或 be used to doing；只有可见技能标签明确写出“be used to doing”时，才把该结构作为硬要求。
冠词/限定词评分要看英文是否自然且语义是否保持，不要机械要求和参考答案完全相同。the/that/this/these/those/my 等限定词可能都能表达特指；例如 “that girl who always wears a red dress” 可以自然对应“那个总是穿红裙子的女孩”，不能仅因参考答案是 “the girl who...” 就判错。
如果用户漏用了做题前可见且明确要求的核心语法结构、固定搭配、必要介词/冠词/时态，或改用了题目没有要求的句式，即使意思接近也必须判 wrong，不要判 partial。
partial 只用于核心考点已经正确、但存在不影响目标结构的小拼写、自然度或次要表达瑕疵。`
    }
  ], "grade_result", gradeSchema(question.dimension));
  const dimensionScores = normalizeDimensionScores(parsed.dimension_scores, question.dimension);
  const verdict = ["correct", "partial", "wrong"].includes(parsed.verdict) ? parsed.verdict : "wrong";
  const rawErrorTypes = toTextArray(parsed.error_types);
  return {
    verdict: normalizeGradeVerdict(verdict, dimensionScores, question.dimension),
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

export async function answerQuestionFollowUp(
  settings: Settings,
  question: Question,
  userAnswer: string,
  result: GradeResult,
  messages: FollowUpMessage[],
  prompt: string
): Promise<string> {
  const safeMessages = messages
    .filter((message) => message.content.trim())
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 1200)
    }));
  const chatMessages: ChatMessage[] = [
    {
      role: "system",
      content: `你是一位耐心、严格的中译英写作教练，母语为中文。
只围绕当前题目、用户译文、参考答案和批改结果回答追问。
回答要简洁具体，必要时给出改写后的英文句子和原因；不要生成新题，不要改写能力报告。`
    },
    {
      role: "user",
      content: `当前题目上下文：
中文原句：${question.chinese}
考查维度：${question.dimension}
次要维度：${question.secondary_dimensions?.join("、") || "无"}
考查语法点：${question.grammar_focus}
批改要点：${question.rubric_points?.join("；") || "按题目语法点批改"}
最佳参考答案：${result.reference_answers[0] || question.answers[0] || "无"}
用户译文：${userAnswer}
批改结论：${result.verdict}
错误类型：${result.error_types.join("、") || "无"}
差异：${result.differences.join("；") || "无"}
解释：${result.explanations.join("；") || "无"}
记忆技巧：${result.memory_tip || "无"}`
    },
    ...safeMessages.map((message): ChatMessage => ({
      role: message.role,
      content: message.content
    })),
    {
      role: "user",
      content: prompt.trim().slice(0, 1200)
    }
  ];
  return chatText(settings, chatMessages);
}

export async function answerQuestionFollowUpStream(
  settings: Settings,
  question: Question,
  userAnswer: string,
  result: GradeResult,
  messages: FollowUpMessage[],
  prompt: string,
  onProgress?: (progress: TextStreamProgress) => void
): Promise<string> {
  const safeMessages = messages
    .filter((message) => message.content.trim())
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 1200)
    }));
  const chatMessages: ChatMessage[] = [
    {
      role: "system",
      content: `你是一位耐心、严格的中译英写作教练，母语为中文。
只围绕当前题目、用户译文、参考答案和批改结果回答追问。
回答要简洁具体，必要时给出改写后的英文句子和原因；不要生成新题，不要改写能力报告。
如果适合用列表、代码块或 JSON 展示，请输出标准 Markdown 或合法 JSON，前端会流式格式化。`
    },
    {
      role: "user",
      content: `当前题目上下文：
中文原句：${question.chinese}
考查维度：${question.dimension}
次要维度：${question.secondary_dimensions?.join("、") || "无"}
考查语法点：${question.grammar_focus}
批改要点：${question.rubric_points?.join("；") || "按题目语法点批改"}
最佳参考答案：${result.reference_answers[0] || question.answers[0] || "无"}
用户译文：${userAnswer}
批改结论：${result.verdict}
错误类型：${result.error_types.join("、") || "无"}
差异：${result.differences.join("；") || "无"}
解释：${result.explanations.join("；") || "无"}
记忆技巧：${result.memory_tip || "无"}`
    },
    ...safeMessages.map((message): ChatMessage => ({
      role: message.role,
      content: message.content
    })),
    {
      role: "user",
      content: prompt.trim().slice(0, 1200)
    }
  ];
  return chatTextStream(settings, chatMessages, onProgress);
}

export async function generateStudyGuide(
  settings: Settings,
  outlines: StudyGuideQuestionOutline[]
): Promise<StudyGuide> {
  const safeOutlines = outlines.map((item) => ({
    dimension: item.dimension,
    secondary_dimensions: item.secondary_dimensions?.filter((dimension) => (DIMENSIONS as readonly string[]).includes(dimension)).slice(0, 3),
    grammar_focus: toText(item.grammar_focus).slice(0, 120),
    skills: toTextArray(item.skills).slice(0, 4),
    rubric_points: toTextArray(item.rubric_points).slice(0, 4),
    difficulty: Math.max(1, Math.min(100, Math.round(Number(item.difficulty) || 50)))
  })).slice(0, 50);
  if (safeOutlines.length < 1) return fallbackStudyGuide([]);

  try {
    const parsed = await chat<StudyGuide>(settings, [
      {
        role: "system",
        content: "你是一位面向中文母语者的英语写作课老师。请按结构化输出 schema 生成中文专项学习材料。"
      },
      {
        role: "user",
        content: `请根据今天试卷涉及的知识点，生成做题前专项学习材料。
只允许使用以下知识点元数据，不得猜测、复述、改写或透露原试卷题目和参考答案：
${JSON.stringify(safeOutlines)}

要求：
1. overview 用 3-5 句话说明今天需要先学哪些知识点，以及这些知识点之间可能如何组合。
2. sections 必须尽量贴合 grammar_focus、skills、rubric_points 中出现的具体知识点，不要只写“时态、冠词”这种大类标题；相近知识点可以合并成一个深入专题。
3. 每个 section 都要深入：why_it_matters 说明为什么今天需要学；explanation 讲清规则、判断步骤、结构边界和中文母语者容易误判的原因，至少 120 个汉字。
4. key_points 给 5-8 条可执行规则，必须包含判断顺序、结构边界、常见替换误区和检查方法；patterns 给 4-8 条句型模板；contrast 给 3-6 条相近结构辨析；examples 给 3-4 个“同类知识点的新例句”；pitfalls 给 3-4 个易错点。
5. drills 给 3-4 个新练习，每个练习必须包含 prompt、answer、explanation。prompt 是中文待译句，answer 是英文参考答案，explanation 说明为什么这样写以及对应哪个规则。
6. examples 和 drills 必须使用全新的句子，不得出现“原题、试卷、答案、参考答案”等字样，也不得暗示今天原题内容。
7. 本接口已启用 thinking 模式，请先在内部分析所有 grammar_focus、skills、rubric_points 的重合点和差异，再输出最终 JSON；最终 JSON 不要写推理过程。
8. checklist 应该是做题前最后检查清单，覆盖今天材料中的关键结构。`
      }
    ], "study_guide", studyGuideSchema, { thinking: true });
    return normalizeStudyGuide(parsed, safeOutlines);
  } catch (error) {
    console.error(`${providerLabel(settings as RuntimeSettings)} study guide failed, using fallback`, error);
    return fallbackStudyGuide(safeOutlines);
  }
}

export async function generateAssessmentNarrative(
  settings: Settings,
  payload: AssessmentNarrativePayload
) {
  if (settings.llmProvider === "webllm") {
    return fallbackAssessmentNarrative(payload);
  }
  try {
    const parsed = await chat<{ summary?: string; weak_points?: string[]; recommendations?: string[] }>(
      settings,
      assessmentNarrativeMessages(payload),
      "assessment_narrative",
      assessmentNarrativeSchema,
      { thinking: true }
    );
    return normalizeAssessmentNarrative(parsed, payload);
  } catch (error) {
    console.error(`${providerLabel(settings as RuntimeSettings)} assessment narrative failed, using fallback`, error);
    return fallbackAssessmentNarrative(payload);
  }
}

export async function generateAssessmentNarrativeStream(
  settings: Settings,
  payload: AssessmentNarrativePayload,
  onProgress?: (progress: AssessmentNarrativeStreamProgress) => void
): Promise<AssessmentNarrative> {
  if (settings.llmProvider === "webllm") {
    onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
    return fallbackAssessmentNarrative(payload);
  }
  ensureChatSettings(settings);
  const runtimeSettings = settings as RuntimeSettings;
  const model = isPersonalProvider(runtimeSettings) ? runtimeSettings.personalModel : settings.model;
  const messages = withJsonSchemaInstruction(assessmentNarrativeMessages(payload), "assessment_narrative", assessmentNarrativeSchema);
  const startedAt = Date.now();
  let lastLogAt = startedAt;
  let pendingStreamLog = "";
  const logPrefix = `${providerLabel(settings as RuntimeSettings)} assessment narrative stream`;
  console.info(`${logPrefix} started`, {
    model,
    totalQuestions: payload.total_questions,
    topErrorTags: payload.top_error_tags.length,
    topSkillFindings: payload.top_skill_findings.length,
    prompt: formatChatMessagesForLog(messages)
  });
  const res = await postChat(settings, {
    model,
    temperature: settings.temperature,
    response_format: jsonResponseFormat(settings, "assessment_narrative", assessmentNarrativeSchema),
    messages,
    thinking: { type: "enabled" },
    stream: true
  });
  console.info(`${logPrefix} response received`, {
    status: res.status,
    ok: res.ok,
    elapsedMs: elapsedMsSince(startedAt)
  });
  if (!res.ok) {
    const errorText = await res.text();
    console.error(`${logPrefix} failed, using non-stream fallback`, {
      status: res.status,
      elapsedMs: elapsedMsSince(startedAt),
      errorText
    });
    onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
    return generateAssessmentNarrative(settings, payload);
  }

  try {
    const { content, reasoning, finalTokens } = await readChatStream(res, (progress) => {
      onProgress?.(progress);
      pendingStreamLog += `${progress.deltaContent || ""}${progress.deltaReasoning || ""}`;
      const now = Date.now();
      if (!pendingStreamLog || (!progress.finalTokens && now - lastLogAt < 5000 && pendingStreamLog.length < 1000)) return;
      lastLogAt = now;
      console.info(`${logPrefix} body chunk`, {
        generatedChars: progress.generatedChars,
        estimatedTokens: progress.estimatedTokens,
        tokensPerSecond: progress.tokensPerSecond,
        finalTokens: progress.finalTokens,
        elapsedMs: elapsedMsSince(startedAt),
        text: pendingStreamLog
      });
      pendingStreamLog = "";
    });
    const narrativeContent = content.trim() ? content : reasoning;
    console.info(`${logPrefix} completed`, {
      contentChars: content.length,
      reasoningChars: reasoning.length,
      finalTokens,
      elapsedMs: elapsedMsSince(startedAt),
      content,
      reasoning
    });
    if (finalTokens !== undefined) {
      onProgress?.({
        generatedChars: (content + reasoning).length,
        estimatedTokens: finalTokens,
        tokensPerSecond: 0,
        finalTokens
      });
    }
    if (!narrativeContent.trim()) {
      console.warn(`${logPrefix} returned empty content; retrying non-stream thinking request`, {
        elapsedMs: elapsedMsSince(startedAt)
      });
      onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
      return generateAssessmentNarrative(settings, payload);
    }
    try {
      return normalizeAssessmentNarrative(parseJson<{ summary?: string; weak_points?: string[]; recommendations?: string[] }>(narrativeContent), payload);
    } catch (parseError) {
      console.error(`${logPrefix} parse failed, using non-stream fallback`, {
        elapsedMs: elapsedMsSince(startedAt),
        error: parseError
      });
      onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
      return generateAssessmentNarrative(settings, payload);
    }
  } catch (error) {
    console.error(`${logPrefix} failed, using non-stream fallback`, {
      elapsedMs: elapsedMsSince(startedAt),
      error
    });
    onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
    return generateAssessmentNarrative(settings, payload);
  }
}

export function chooseAdaptiveDifficulty(score: number) {
  const offset = 5 + Math.floor(Math.random() * 11);
  return Math.max(1, Math.min(100, Math.round(score + offset)));
}

export function chooseLowestDimension(scores: Array<{ dimension: Dimension; score: number }>) {
  return [...scores].sort((a, b) => a.score - b.score)[0]?.dimension ?? DIMENSIONS[0];
}
