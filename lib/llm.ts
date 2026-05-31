import { DIMENSIONS, Dimension, DimensionScore, GradeResult, Question, Settings, StudyGuide } from "./types";

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

type AssessmentNarrativePayload = {
  totalQuestions: number;
  matrix: Array<{ dimension: Dimension; score: number; confidence: number; evidence_count: number }>;
  findings: string[];
};

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
  const missing = payload.matrix.filter((item) => item.evidence_count === 0).map((item) => item.dimension);
  const evidence = payload.findings
    .map((item) => item.replaceAll("_", " ").trim())
    .filter(Boolean)
    .slice(0, 3);

  const summaryParts = [
    `本次测评共完成 ${payload.totalQuestions} 题，当前最需要优先处理的是${weakest.dimension}，测评分为 ${weakest.score}。`,
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
  if (!primaryScore) return verdict;
  if (primaryScore.score >= 80 && primaryScore.verdict === "correct") return verdict === "wrong" ? "partial" : verdict;
  return primaryScore.score < 45 || primaryScore.verdict === "wrong" ? "wrong" : "partial";
}

type ChatMessage = { role: "system" | "user"; content: string };

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: false;
};

type ChatPayload = {
  model: string;
  temperature: number;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: JsonSchema;
    };
  };
  messages: ChatMessage[];
  enable_thinking?: boolean;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
    continuous_usage_stats?: boolean;
  };
};

type AssessmentNarrative = {
  summary: string;
  weak_points: string[];
  recommendations: string[];
};

export type AssessmentNarrativeStreamProgress = {
  generatedChars: number;
  estimatedTokens: number;
  tokensPerSecond: number;
  finalTokens?: number;
  fallback?: boolean;
};

function withoutThinking(messages: ChatMessage[]) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return messages;
  return messages.map((message, index) => index === lastUserIndex
    ? { ...message, content: `/no_think\n${message.content}\n/no_think` }
    : message
  );
}

function unsupportedThinkingParam(errorText: string) {
  return /enable_?thinking/i.test(errorText);
}

function unsupportedStreamOptions(errorText: string) {
  return /stream_options|include_usage|continuous_usage_stats/i.test(errorText);
}

async function postChat(endpoint: string, payload: ChatPayload) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
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

function schemaResponseFormat(name: string, schema: JsonSchema): ChatPayload["response_format"] {
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema
    }
  };
}

const dimensionSchema = { type: "string", enum: DIMENSIONS };
const stringArraySchema = { type: "array", items: { type: "string" } };

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
    answers: { type: "array", items: { type: "string" } },
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

function gradeSchema(primary: Dimension): JsonSchema {
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
      error_types: stringArraySchema,
      reference_answers: { type: "array", items: { type: "string" } },
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

function assessmentNarrativeMessages(payload: AssessmentNarrativePayload): ChatMessage[] {
  return [
    {
      role: "system",
      content: "你是一位英语写作能力测评老师。请按结构化输出 schema 生成中文总结报告。"
    },
    {
      role: "user",
      content: `请根据以下结构化测评结果，生成中文总结报告。
题量：${payload.totalQuestions}
能力矩阵：${JSON.stringify(payload.matrix)}
典型证据：${JSON.stringify(payload.findings.slice(0, 30))}

要求：
1. summary 用 2-4 句话概括当前中译英写作能力。
2. weak_points 给 3-6 条最需要优先处理的薄弱点。
3. recommendations 给 3-6 条具体训练建议。`
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

async function readChatStream(
  res: Response,
  onProgress?: (progress: AssessmentNarrativeStreamProgress) => void
) {
  if (!res.body) throw new Error("LM Studio 流式响应为空");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finalTokens: number | undefined;

  async function handleEvent(rawEvent: string) {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return false;
    const dataText = dataLines.join("\n").trim();
    if (!dataText || dataText === "[DONE]") return dataText === "[DONE]";
    const data = JSON.parse(dataText);
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
      finalTokens
    });
    return false;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (await handleEvent(event)) return { content, reasoning, finalTokens };
      }
    }
    if (done) break;
  }
  if (buffer.trim()) await handleEvent(buffer);
  return { content, reasoning, finalTokens };
}

async function chat<T>(settings: Settings, messages: ChatMessage[], schemaName: string, schema: JsonSchema, options: { thinking?: boolean } = {}): Promise<T> {
  if (!settings.model) throw new Error("请先在设置页填写 LM Studio 模型名称");
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const thinking = Boolean(options.thinking);
  const payload: ChatPayload = {
    model: settings.model,
    temperature: settings.temperature,
    response_format: schemaResponseFormat(schemaName, schema),
    messages: thinking ? messages : withoutThinking(messages),
    enable_thinking: thinking
  };
  let activePayload = payload;
  let res = await postChat(endpoint, activePayload);
  let errorText = "";
  if (!res.ok) {
    errorText = await res.text();
    // 部分 OpenAI-compatible 服务会拒绝 LM Studio/Qwen thinking 扩展字段。
    if (unsupportedThinkingParam(errorText)) {
      activePayload = {
        model: activePayload.model,
        temperature: activePayload.temperature,
        response_format: activePayload.response_format,
        messages: activePayload.messages
      };
      res = await postChat(endpoint, activePayload);
      errorText = res.ok ? "" : await res.text();
    }
  }
  if (!res.ok) {
    throw new Error(`LM Studio 请求失败：${res.status} ${errorText}`);
  }
  const data = await res.json();
  const content = extractContent(data);
  try {
    return parseJson<T>(content);
  } catch (error) {
    console.error("LM Studio structured output parse failed", {
      schemaName,
      content: preview(content),
      response: preview(data)
    });
    throw error;
  }
}

export async function testConnection(settings: Settings) {
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/v1/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`无法连接 LM Studio：${res.status}`);
  const models = await res.json();
  if (settings.model) {
    await chat<{ ok: boolean }>(settings, [
      { role: "system", content: "你用于测试 LM Studio 结构化输出连接。" },
      { role: "user", content: "返回连接状态 ok 为 true。" }
    ], "connection_test", connectionSchema);
  }
  return models;
}

export async function generateQuestion(
  settings: Settings,
  dimension: Dimension,
  difficulty: number,
  includeVocabularyTips = false,
  previousQuestions: string[] = [],
  regenerateReason = "",
  paperPosition = "",
  options: { thinking?: boolean } = {}
): Promise<Question> {
  const avoidList = previousQuestions
    .filter(Boolean)
    .slice(-20)
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
  const parsed = await chat<{ chinese: string; answers: string[]; vocabulary_tips?: string[]; grammar_focus: string; secondary_dimensions?: string[]; skills?: string[]; rubric_points?: string[] }>(settings, [
    {
      role: "system",
      content:
        "你是一位专业的英语写作训练出题老师，母语为中文。请按结构化输出 schema 填写字段。"
    },
    {
      role: "user",
      content: `请生成 1 道中译英练习题。
考查维度：${dimension}
难度：${difficulty}/100
要求：
1. 中文句子自然、适合中文母语者练习英语写作。
2. 尽量使用初级英语词汇和常见生活场景，避免生僻词、抽象名词、复杂专业表达。题目尽量贴近实际生活场景，不要生搬硬套。
3. 主要难点必须来自语法结构，而不是词汇理解。
4. 英文参考答案以短句或中等长度句子为主，不要为了提高难度使用高级词汇。
5. 参考答案给 1-2 个英文变体；明确说明考查语法点。
${includeVocabularyTips ? "6. vocabulary_tips 只给 0-5 个关键英文单词原型，例如 go、make、book；禁止给短语、变形、介词搭配、冠词、时态形式、从句结构或任何会透露语法答案的内容。" : "6. 不要返回 vocabulary_tips。"}
7. 不要生成和已生成题目语义相同、场景相同或句式结构高度相似的题目；更换人物、动作、场景和句法结构。
8. secondary_dimensions 给 1-3 个本题自然涉及的次要维度，只能从：${DIMENSIONS.join("、")} 中选择，且不能包含主维度。
9. skills 给 2-4 个具体能力标签，例如“过去完成时识别”“特指冠词”“原因连接”。
10. rubric_points 给 2-4 条批改要点，覆盖主维度和关键次维度。
${avoidList ? `已生成题目，必须避开：\n${avoidList}` : "本轮还没有已生成题目。"}
${regenerateReason ? `用户要求重生成的原因：${regenerateReason}` : ""}
${paperPosition ? `试卷位置：${paperPosition}。请让本题与同一试卷中其它题在人物、场景、动作和句法结构上明显不同。` : ""}`
    }
  ], includeVocabularyTips ? "assessment_question" : "practice_question", questionSchema(includeVocabularyTips), options);
  return {
    chinese: toText(parsed.chinese, "题目生成失败，请重新生成。"),
    answers: toTextArray(parsed.answers).slice(0, 2),
    vocabulary_tips: includeVocabularyTips ? toVocabularyTips(parsed.vocabulary_tips) : undefined,
    grammar_focus: toText(parsed.grammar_focus, "本题考查指定语法维度。"),
    dimension,
    secondary_dimensions: toDimensions(parsed.secondary_dimensions, dimension),
    skills: toTextArray(parsed.skills).slice(0, 4),
    rubric_points: toTextArray(parsed.rubric_points).slice(0, 4),
    difficulty,
    source: "ai"
  };
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
考查语法点：${question.grammar_focus}
批改要点：${question.rubric_points?.join("；") || "按题目语法点批改"}
参考答案：${question.answers.join(" / ")}
用户译文：${userAnswer}

请判断：正确、基本正确（有小瑕疵）或错误。即使意思接近，也要指出语法、搭配、冠词、时态、语序等问题。
dimension_scores 必须覆盖主维度；如果次要维度有明确证据，也要分别给出。score 表示该维度本题表现，不是总能力分，必须使用 0-100 百分制。
score、verdict、severity 和 notes 必须一致：correct 通常为 80-100，partial 通常为 45-79，wrong 通常为 0-44。如果 notes 指出用户漏用了本题要求的核心语法结构或搭配，不要给 correct。`
    }
  ], "grade_result", gradeSchema(question.dimension));
  const dimensionScores = normalizeDimensionScores(parsed.dimension_scores, question.dimension);
  const verdict = ["correct", "partial", "wrong"].includes(parsed.verdict) ? parsed.verdict : "wrong";
  return {
    verdict: normalizeGradeVerdict(verdict, dimensionScores, question.dimension),
    error_types: toTextArray(parsed.error_types),
    reference_answers: toTextArray(parsed.reference_answers, question.answers).slice(0, 2),
    differences: toTextArray(parsed.differences),
    explanations: toTextArray(parsed.explanations),
    memory_tip: parsed.memory_tip ? toText(parsed.memory_tip) : undefined,
    dimension_scores: dimensionScores,
    skill_findings: toTextArray(parsed.skill_findings).slice(0, 6)
  };
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
    console.error("LM Studio study guide failed, using fallback", error);
    return fallbackStudyGuide(safeOutlines);
  }
}

export async function generateAssessmentNarrative(
  settings: Settings,
  payload: AssessmentNarrativePayload
) {
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
    console.error("LM Studio assessment narrative failed, using fallback", error);
    return fallbackAssessmentNarrative(payload);
  }
}

export async function generateAssessmentNarrativeStream(
  settings: Settings,
  payload: AssessmentNarrativePayload,
  onProgress?: (progress: AssessmentNarrativeStreamProgress) => void
): Promise<AssessmentNarrative> {
  if (!settings.model) throw new Error("请先在设置页填写 LM Studio 模型名称");
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const messages = assessmentNarrativeMessages(payload);
  const basePayload: ChatPayload = {
    model: settings.model,
    temperature: settings.temperature,
    response_format: schemaResponseFormat("assessment_narrative", assessmentNarrativeSchema),
    messages,
    enable_thinking: true,
    stream: true,
    stream_options: { include_usage: true }
  };
  let activePayload = basePayload;
  let res = await postChat(endpoint, activePayload);
  let errorText = "";
  if (!res.ok) {
    errorText = await res.text();
    if (unsupportedStreamOptions(errorText)) {
      activePayload = {
        model: settings.model,
        temperature: settings.temperature,
        response_format: basePayload.response_format,
        messages,
        enable_thinking: true,
        stream: true
      };
      res = await postChat(endpoint, activePayload);
      errorText = res.ok ? "" : await res.text();
    }
    if (!res.ok && unsupportedThinkingParam(errorText)) {
      activePayload = {
        model: settings.model,
        temperature: settings.temperature,
        response_format: basePayload.response_format,
        messages,
        stream: true
      };
      res = await postChat(endpoint, activePayload);
      errorText = res.ok ? "" : await res.text();
    }
  }
  if (!res.ok) {
    console.error("LM Studio streaming narrative failed, using non-stream fallback", { status: res.status, errorText });
    onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
    return generateAssessmentNarrative(settings, payload);
  }

  try {
    const { content, reasoning, finalTokens } = await readChatStream(res, onProgress);
    const narrativeContent = content.trim() ? content : reasoning;
    if (finalTokens !== undefined) {
      onProgress?.({
        generatedChars: (content + reasoning).length,
        estimatedTokens: finalTokens,
        tokensPerSecond: 0,
        finalTokens
      });
    }
    if (!narrativeContent.trim()) {
      console.warn("LM Studio streaming narrative returned only reasoning_content; retrying non-stream thinking request");
      onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
      return generateAssessmentNarrative(settings, payload);
    }
    try {
      return normalizeAssessmentNarrative(parseJson<{ summary?: string; weak_points?: string[]; recommendations?: string[] }>(narrativeContent), payload);
    } catch (parseError) {
      console.error("LM Studio streaming narrative parse failed, using non-stream fallback", parseError);
      onProgress?.({ generatedChars: 0, estimatedTokens: 0, tokensPerSecond: 0, fallback: true });
      return generateAssessmentNarrative(settings, payload);
    }
  } catch (error) {
    console.error("LM Studio streaming narrative failed, using non-stream fallback", error);
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
