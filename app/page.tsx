"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { BarChart3, BookOpenCheck, CheckCircle2, ClipboardList, Dumbbell, Eye, History, RotateCcw, Settings as SettingsIcon, Target, Trash2, X } from "lucide-react";
import { Ability, AbilityHistory, AssessmentReport, DIMENSIONS, Dimension, GradeResult, Mistake, Question, Settings, TrainingRecord } from "@/lib/types";

type View = "能力测评" | "每日练习" | "专项训练" | "错题重练" | "数据统计" | "设置";
type TrainingMode = "能力测评" | "每日练习" | "专项训练" | "错题重练";
type AnswerRecord = {
  answer: string;
  result?: GradeResult;
};
type PaperNote = {
  reason: string;
  loading?: boolean;
};
type AssessmentOptions = {
  initialCount: number;
  autoExtend: boolean;
  maxCount: number;
};
type AssessmentExtensionPlanItem = {
  dimension: Dimension;
  difficulty: number;
  reason: string;
  evidence: number;
  score: number;
};
type AssessmentExtensionState =
  | { phase: "idle" }
  | { phase: "decision"; plan: AssessmentExtensionPlanItem[] }
  | { phase: "preview"; plan: AssessmentExtensionPlanItem[]; questions: Question[]; notes: Record<number, PaperNote> };
type AssessmentProgress = {
  title: string;
  detail: string;
  meta: string;
  completed: number;
  total: number;
  percent: number;
  status?: "loading" | "complete";
  generatedChars?: number;
  estimatedTokens?: number;
  tokensPerSecond?: number;
  finalTokens?: number;
};
type AssessmentFinalizeEvent = {
  title?: string;
  detail?: string;
  percent?: number;
  generatedChars?: number;
  estimatedTokens?: number;
  tokensPerSecond?: number;
  finalTokens?: number;
  message?: string;
  report?: AssessmentReport;
  abilities?: Ability[];
};
type AppState = {
  settings: Settings;
  abilities: Ability[];
  history: AbilityHistory[];
  mistakes: Mistake[];
  records: TrainingRecord[];
  assessmentReports: AssessmentReport[];
  assessmentReportPage: number;
  assessmentReportPageSize: number;
  assessmentReportTotal: number;
  assessmentReportPageCount: number;
  latestAssessmentReport: AssessmentReport | null;
  latestAssessmentAt: string | null;
  streak: number;
  needsAssessment: boolean;
};

const emptyState: AppState = {
  settings: { baseUrl: "http://localhost:1234", model: "", temperature: 0.3, dailyCount: 20, maxConcurrentPredictions: 5 },
  abilities: DIMENSIONS.map((dimension) => ({ dimension, score: 0 })),
  history: [],
  mistakes: [],
  records: [],
  assessmentReports: [],
  assessmentReportPage: 1,
  assessmentReportPageSize: 10,
  assessmentReportTotal: 0,
  assessmentReportPageCount: 1,
  latestAssessmentReport: null,
  latestAssessmentAt: null,
  streak: 0,
  needsAssessment: true
};

const navItems: Array<{ name: View; icon: React.ReactNode }> = [
  { name: "能力测评", icon: <ClipboardList size={18} /> },
  { name: "每日练习", icon: <BookOpenCheck size={18} /> },
  { name: "专项训练", icon: <Target size={18} /> },
  { name: "错题重练", icon: <RotateCcw size={18} /> },
  { name: "数据统计", icon: <BarChart3 size={18} /> },
  { name: "设置", icon: <SettingsIcon size={18} /> }
];

const ASSESSMENT_MIN = 18;
const ASSESSMENT_MAX = 30;
const ASSESSMENT_INPUT_MIN = 1;
const ASSESSMENT_INPUT_MAX = 60;
const DEFAULT_ASSESSMENT_OPTIONS: AssessmentOptions = {
  initialCount: ASSESSMENT_MIN,
  autoExtend: true,
  maxCount: ASSESSMENT_MAX
};
const ASSESSMENT_PLAN: Array<{ dimension: Dimension; difficulty: number }> = [25, 45, 65].flatMap((difficulty) =>
  DIMENSIONS.map((dimension) => ({ dimension, difficulty }))
);
const ASSESSMENT_DIFFICULTIES = [25, 45, 65, 75, 85];
const ASSESSMENT_COMPLETE_ANIMATION_MS = 300;

const DIMENSION_NOTES: Record<Dimension, string> = {
  "时态": "判断动作发生时间、持续状态和完成情况，选择合适的谓语形式。",
  "介词搭配": "关注动词、形容词和名词后常见介词的固定搭配。",
  "定语从句": "练习用关系词连接修饰信息，处理先行词和从句结构。",
  "连接词": "根据因果、转折、条件和并列关系选择自然的连接方式。",
  "被动语态": "识别动作承受者作主语时的 be done 结构和时态变化。",
  "冠词": "区分 a、an、the 和零冠词，处理泛指、特指与固定表达。"
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data as T;
}

async function readSseStream(response: Response, onEvent: (event: string, data: AssessmentFinalizeEvent) => void) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || "请求失败");
  }
  if (!response.body) throw new Error("服务器没有返回进度流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function handleEvent(rawEvent: string) {
    const lines = rawEvent.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!dataText) return;
    onEvent(event, JSON.parse(dataText) as AssessmentFinalizeEvent);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      events.forEach(handleEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) handleEvent(buffer);
}

function errorMessage(err: unknown, fallback: string) {
  if (err instanceof Error) return err.message;
  if (err instanceof Event) return fallback;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return fallback;
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function assessmentProgressPercent(completed: number, total: number, stageOffset = 0) {
  const safeTotal = Math.max(1, total);
  return clampNumber(((completed + stageOffset) / safeTotal) * 100, 0, 100);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeAssessmentOptions(options: AssessmentOptions) {
  const initialCount = clampNumber(options.initialCount, ASSESSMENT_INPUT_MIN, ASSESSMENT_INPUT_MAX);
  const maxCount = clampNumber(options.maxCount, initialCount, ASSESSMENT_INPUT_MAX);
  return { ...options, initialCount, maxCount };
}

function assessmentStepAt(index: number) {
  const planStep = ASSESSMENT_PLAN[index];
  if (planStep) return planStep;
  return {
    dimension: DIMENSIONS[index % DIMENSIONS.length],
    difficulty: ASSESSMENT_DIFFICULTIES[Math.min(Math.floor(index / DIMENSIONS.length), ASSESSMENT_DIFFICULTIES.length - 1)]
  };
}

function verdictText(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return "✅ 正确";
  if (verdict === "partial") return "⚠️ 基本正确";
  return "❌ 错误";
}

function verdictScore(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return 100;
  if (verdict === "partial") return 60;
  return 20;
}

function assessmentEvidence(question: Question, result?: GradeResult) {
  if (!result) return [];
  if (result.dimension_scores?.length) {
    return result.dimension_scores.map((item) => ({
      dimension: item.dimension,
      score: item.score,
      weight: item.dimension === question.dimension ? 1 : 0.55,
      verdict: item.verdict
    }));
  }
  return [
    { dimension: question.dimension, score: verdictScore(result.verdict), weight: 1, verdict: result.verdict },
    ...(question.secondary_dimensions ?? []).map((dimension) => ({ dimension, score: verdictScore(result.verdict), weight: 0.45, verdict: result.verdict }))
  ];
}

function nextAssessmentStep(questions: Question[], answerRecords: Record<number, AnswerRecord>) {
  const target = assessmentExtensionCandidates(questions, answerRecords)[0];
  if (!target) return undefined;
  return {
    dimension: target.dimension,
    difficulty: target.score < 45 ? 35 : target.score < 70 ? 55 : 75
  };
}

function assessmentExtensionCandidates(questions: Question[], answerRecords: Record<number, AnswerRecord>) {
  return DIMENSIONS.map((dimension) => {
    let weighted = 0;
    let totalWeight = 0;
    let evidence = 0;
    let mixed = false;
    let firstVerdict = "";
    questions.forEach((question, index) => {
      assessmentEvidence(question, answerRecords[index]?.result).forEach((item) => {
        if (item.dimension !== dimension) return;
        weighted += item.score * item.weight;
        totalWeight += item.weight;
        evidence += 1;
        if (!firstVerdict) firstVerdict = item.verdict;
        if (firstVerdict !== item.verdict) mixed = true;
      });
    });
    const score = totalWeight ? weighted / totalWeight : 0;
    const uncertain = evidence < 5 || (score >= 45 && score <= 75 && mixed);
    const weak = score > 0 && score < 70;
    return { dimension, score, evidence, uncertain, weak };
  })
    .filter((item) => item.weak || item.uncertain)
    .sort((a, b) => {
      const priority = Number(b.weak) + Number(b.uncertain) - (Number(a.weak) + Number(a.uncertain));
      if (priority !== 0) return priority;
      if (a.evidence !== b.evidence) return a.evidence - b.evidence;
      return a.score - b.score;
    });
}

function buildAssessmentExtensionPlan(questions: Question[], answerRecords: Record<number, AnswerRecord>, maxCount: number): AssessmentExtensionPlanItem[] {
  const slots = Math.max(0, maxCount - questions.length);
  if (slots < 1) return [];
  const candidates = assessmentExtensionCandidates(questions, answerRecords);
  if (!candidates.length) return [];
  return Array.from({ length: slots }, (_, index) => {
    const target = candidates[index % candidates.length];
    const reasons = [
      target.weak ? `当前估算分 ${Math.round(target.score)}，低于稳定掌握线 70。` : "",
      target.uncertain ? `有效证据 ${target.evidence} 条，仍不足以稳定判断该维度。` : "",
      target.score >= 45 && target.score <= 75 ? "表现处在临界区间，需要更多题目区分偶然失误和真实薄弱点。" : ""
    ].filter(Boolean);
    return {
      dimension: target.dimension,
      difficulty: target.score < 45 ? 35 : target.score < 70 ? 55 : 75,
      evidence: target.evidence,
      score: Math.round(target.score),
      reason: reasons.join(" ")
    };
  });
}

function elapsedText(dateText?: string | null) {
  if (!dateText) return "还没有完成过测评";
  const diffMs = Date.now() - new Date(dateText).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "刚刚完成测评";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "刚刚完成测评";
  if (minutes < 60) return `距离上次测评 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `距离上次测评 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `距离上次测评 ${days} 天`;
}

function Radar({ abilities, onPick }: { abilities: Ability[]; onPick?: (dimension: Dimension) => void }) {
  const size = 320;
  const center = size / 2;
  const radius = 118;
  const points = abilities.map((item, index) => {
    const angle = (Math.PI * 2 * index) / abilities.length - Math.PI / 2;
    const r = radius * (item.score / 100);
    return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`;
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="能力雷达图">
      {[25, 50, 75, 100].map((level) => (
        <polygon
          key={level}
          points={abilities
            .map((_, index) => {
              const angle = (Math.PI * 2 * index) / abilities.length - Math.PI / 2;
              const r = radius * (level / 100);
              return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`;
            })
            .join(" ")}
          fill="none"
          stroke="#30363d"
        />
      ))}
      {abilities.map((item, index) => {
        const angle = (Math.PI * 2 * index) / abilities.length - Math.PI / 2;
        const x = center + Math.cos(angle) * (radius + 34);
        const y = center + Math.sin(angle) * (radius + 34);
        return (
          <g key={item.dimension} onClick={() => onPick?.(item.dimension)} style={{ cursor: onPick ? "pointer" : "default" }}>
            <line x1={center} y1={center} x2={center + Math.cos(angle) * radius} y2={center + Math.sin(angle) * radius} stroke="#30363d" />
            <text x={x} y={y} fill="#f5f0df" fontSize="13" textAnchor="middle" dominantBaseline="middle">
              {item.dimension}
            </text>
          </g>
        );
      })}
      <polygon points={points.join(" ")} fill="rgba(231,198,106,.32)" stroke="#e7c66a" strokeWidth="3" />
    </svg>
  );
}

function Feedback({ result }: { result: GradeResult }) {
  return (
    <div className="feedback feedback-grid">
      <div className={`verdict ${result.verdict}`}>{verdictText(result.verdict)}</div>
      <div>
        <strong>参考答案</strong>
        {result.reference_answers.map((answer, index) => (
          <p key={index}>“{answer}”</p>
        ))}
      </div>
      {result.verdict !== "correct" && (
        <div>
          <strong>错误详细解析</strong>
          <div>{result.error_types.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
          {result.differences.map((item, index) => <p key={`d-${index}`}>{item}</p>)}
          {result.explanations.map((item, index) => <p key={`e-${index}`}>{index + 1}. {item}</p>)}
        </div>
      )}
      {result.memory_tip && <div><strong>记忆技巧</strong><p>{result.memory_tip}</p></div>}
    </div>
  );
}

export default function Home() {
  const [state, setState] = useState<AppState>(emptyState);
  const [view, setView] = useState<View>("每日练习");
  const [assessment, setAssessment] = useState(false);
  const [specialDimension, setSpecialDimension] = useState<Dimension>("时态");
  const [sessionId, setSessionId] = useState<number>();
  const [activeMode, setActiveMode] = useState<TrainingMode>();
  const [questionQueue, setQuestionQueue] = useState<Question[]>([]);
  const [answerRecords, setAnswerRecords] = useState<Record<number, AnswerRecord>>({});
  const [paperNotes, setPaperNotes] = useState<Record<number, PaperNote>>({});
  const [sessionStarted, setSessionStarted] = useState(false);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 20 });
  const [beforeScores, setBeforeScores] = useState<Ability[]>(emptyState.abilities);
  const [showDelta, setShowDelta] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(emptyState.settings);
  const [assessmentOptions, setAssessmentOptions] = useState<AssessmentOptions>(DEFAULT_ASSESSMENT_OPTIONS);
  const [assessmentExtension, setAssessmentExtension] = useState<AssessmentExtensionState>({ phase: "idle" });
  const [assessmentProgress, setAssessmentProgress] = useState<AssessmentProgress>();
  const [assessmentReportPage, setAssessmentReportPage] = useState(1);
  const [assessmentReportPageSize] = useState(10);
  const [trendDimension, setTrendDimension] = useState<Dimension>("时态");
  const [questionStartedAt, setQuestionStartedAt] = useState(Date.now());

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({
      assessmentPage: String(assessmentReportPage),
      assessmentPageSize: String(assessmentReportPageSize)
    });
    const next = await api<AppState>(`/api/state?${params.toString()}`);
    setState(next);
    setSettingsDraft(next.settings);
    setBeforeScores(next.abilities);
    if (next.assessmentReportPage !== assessmentReportPage) setAssessmentReportPage(next.assessmentReportPage);
    if (next.needsAssessment) {
      setAssessment(true);
      setView("能力测评");
    }
  }, [assessmentReportPage, assessmentReportPageSize]);

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [refresh]);

  const activeQuestion = questionQueue[progress.current];
  const activeRecord = answerRecords[progress.current] ?? { answer: "" };
  const activeResult = activeRecord.result;
  const activeTraining = sessionStarted && Boolean(activeMode) && questionQueue.length > 0;
  const paperPreview = !sessionStarted && Boolean(activeMode) && questionQueue.length > 0 && assessmentExtension.phase === "idle";
  const visibleTrainingView = view !== "数据统计" && view !== "设置";
  const startMode: TrainingMode = assessment ? "能力测评" : view === "数据统计" || view === "设置" ? "每日练习" : view;
  const normalizedAssessmentOptions = normalizeAssessmentOptions(assessmentOptions);
  const startTotal = startMode === "能力测评"
    ? normalizedAssessmentOptions.initialCount
    : startMode === "每日练习"
      ? state.settings.dailyCount
      : startMode === "错题重练"
        ? state.mistakes.filter((x) => x.correct_streak < 2).length
        : 20;

  async function completeAssessmentProgress(title = "处理完成", detail = "结果已更新，正在进入下一步。") {
    setAssessmentProgress((prev) => prev ? {
      ...prev,
      title,
      detail,
      completed: prev.total,
      percent: 100,
      status: "complete"
    } : prev);
    await sleep(ASSESSMENT_COMPLETE_ANIMATION_MS);
    setAssessmentProgress(undefined);
  }

  function setPaperGenerationProgress(nextMode: TrainingMode, completed: number, total: number, detail?: string) {
    const safeTotal = Math.max(1, total);
    setAssessmentProgress({
      title: "正在生成试卷",
      detail: detail ?? `${nextMode}试卷正在准备中，AI 会按当前训练目标生成题目。`,
      meta: `生成 ${Math.min(completed, total)}/${total}`,
      completed: Math.min(completed, total),
      total: safeTotal,
      percent: assessmentProgressPercent(completed, safeTotal)
    });
  }

  async function generateQuestionsForSession(nextMode: TrainingMode, nextTotal: number) {
    const questions: Question[] = [];
    const activeMistakes = state.mistakes.filter((item) => item.correct_streak < 2);
    if (nextMode === "错题重练") {
      return activeMistakes.slice(0, nextTotal).map((mistake) => ({ ...mistake, source: "mistake", mistakeId: mistake.id }) satisfies Question);
    }

    if (nextMode === "每日练习") {
      questions.push(...activeMistakes.slice(0, nextTotal).map((mistake) => ({ ...mistake, source: "mistake", mistakeId: mistake.id }) satisfies Question));
      if (questions.length > 0) {
        setPaperGenerationProgress(nextMode, questions.length, nextTotal, `已加入 ${questions.length} 道错题，正在补齐本次练习试卷。`);
      }
    }

    const aiTotal = nextTotal - questions.length;
    const concurrency = Math.min(aiTotal, Math.max(1, Math.floor(Number(state.settings.maxConcurrentPredictions) || 1)));
    for (let start = 0; start < aiTotal; start += concurrency) {
      const chunkSize = Math.min(concurrency, aiTotal - start);
      const from = questions.length + 1;
      const to = questions.length + chunkSize;
      setLoading(chunkSize > 1 ? `AI 正在并发生成题目 ${from}-${to}/${nextTotal}…` : `AI 正在生成题目 ${from}/${nextTotal}…`);
      setPaperGenerationProgress(
        nextMode,
        questions.length,
        nextTotal,
        chunkSize > 1 ? `AI 正在并发生成第 ${from}-${to} 题。` : `AI 正在生成第 ${from} 题。`
      );
      const previousQuestions = questions.map((question) => question.chinese);
      const results = await Promise.all(Array.from({ length: chunkSize }, async (_, offset) => {
        const index = questions.length + offset;
        const nextAssessmentStep = assessmentStepAt(index);
        const dimension = nextMode === "能力测评" ? nextAssessmentStep.dimension : nextMode === "专项训练" ? specialDimension : undefined;
        const difficulty = nextMode === "能力测评" ? nextAssessmentStep.difficulty : undefined;
        return api<{ question?: Question; done?: boolean }>("/api/question", {
          method: "POST",
          body: JSON.stringify({
            mode: nextMode,
            dimension,
            difficulty,
            previousQuestions,
            batchIndex: index + 1,
            batchTotal: nextTotal,
            forceAi: true
          })
        });
      }));
      for (const data of results) {
        if (data.done || !data.question) return questions;
        questions.push(data.question);
      }
      setPaperGenerationProgress(nextMode, questions.length, nextTotal, `已生成 ${questions.length}/${nextTotal} 题，正在继续准备试卷。`);
    }
    return questions;
  }

  async function generatePaper(nextMode: TrainingMode = startMode) {
    try {
      setError("");
      setQuestionQueue([]);
      setAnswerRecords({});
      setPaperNotes({});
      setAssessmentExtension({ phase: "idle" });
      setSessionStarted(false);
      setActiveMode(undefined);
      const nextAssessmentOptions = normalizeAssessmentOptions(assessmentOptions);
      const nextTotal = nextMode === "能力测评"
        ? nextAssessmentOptions.initialCount
        : nextMode === "每日练习"
          ? state.settings.dailyCount
          : nextMode === "错题重练"
            ? state.mistakes.filter((x) => x.correct_streak < 2).length
            : 20;
      if (nextTotal < 1) {
        setError("当前没有需要重练的错题。");
        return;
      }
      setLoading("正在生成试卷…");
      setPaperGenerationProgress(nextMode, 0, nextTotal);
      const questions = await generateQuestionsForSession(nextMode, nextTotal);
      if (questions.length < 1) {
        setError(nextMode === "错题重练" ? "当前没有需要重练的错题。" : "题目生成失败，请稍后重试。");
        setAssessmentProgress(undefined);
        return;
      }
      setActiveMode(nextMode);
      setQuestionQueue(questions);
      setProgress({ current: 0, total: questions.length });
      setBeforeScores(state.abilities);
      setAssessment(false);
      await completeAssessmentProgress("试卷生成完成", `已准备好 ${questions.length} 道题，可以预览后开始答题。`);
    } catch (err) {
      setSessionStarted(false);
      setError(errorMessage(err, "试卷生成失败，请检查 LM Studio 设置后重试。"));
      setAssessmentProgress(undefined);
    } finally {
      setLoading("");
    }
  }

  async function regenerateQuestion(index: number) {
    if (!activeMode || !questionQueue[index]) return;
    const current = questionQueue[index];
    setError("");
    setPaperNotes((prev) => ({ ...prev, [index]: { ...prev[index], loading: true } }));
    try {
      const previousQuestions = questionQueue.map((item, itemIndex) => itemIndex === index ? "" : item.chinese).filter(Boolean);
      const data = await api<{ question?: Question; done?: boolean }>("/api/question", {
        method: "POST",
        body: JSON.stringify({
          mode: activeMode,
          dimension: current.dimension,
          difficulty: current.difficulty,
          previousQuestions,
          excludeMistakeIds: questionQueue.map((item) => item.mistakeId).filter((id): id is number => typeof id === "number"),
          regenerateReason: paperNotes[index]?.reason ?? "",
          forceAi: true
        })
      });
      if (!data.question || data.done) {
        setError("没有生成可替换的题目。");
        return;
      }
      setQuestionQueue((prev) => prev.map((item, itemIndex) => itemIndex === index ? data.question! : item));
    } catch (err) {
      setError(errorMessage(err, "单题重生成失败，请重试。"));
    } finally {
      setPaperNotes((prev) => ({ ...prev, [index]: { ...prev[index], loading: false } }));
    }
  }

  async function beginAnswering() {
    if (!activeMode || questionQueue.length < 1) return;
    setLoading("正在创建训练记录…");
    setError("");
    try {
      const session = await api<{ id: number }>("/api/session", {
        method: "POST",
        body: JSON.stringify({ mode: activeMode, total: questionQueue.length })
      });
      setSessionId(session.id);
      setAnswerRecords({});
      setProgress({ current: 0, total: questionQueue.length });
      setBeforeScores(state.abilities);
      setSessionStarted(true);
      setAssessmentExtension({ phase: "idle" });
      setPaperNotes({});
      setQuestionStartedAt(Date.now());
    } catch (err) {
      setError(errorMessage(err, "训练启动失败，请重试。"));
    } finally {
      setLoading("");
    }
  }

  function abandonPaper() {
    setError("");
    setLoading("");
    setSessionStarted(false);
    setSessionId(undefined);
    setActiveMode(undefined);
    setQuestionQueue([]);
    setAnswerRecords({});
    setPaperNotes({});
    setAssessmentExtension({ phase: "idle" });
    setProgress({ current: 0, total: startTotal });
  }

  async function submit() {
    if (!activeQuestion || !activeRecord.answer.trim() || activeResult) return;
    const isAssessmentSubmit = activeMode === "能力测评";
    let completed = false;
    setLoading("AI 正在批改中…");
    setError("");
    if (isAssessmentSubmit) {
      setAssessmentProgress({
        title: `正在批改第 ${progress.current + 1} 题`,
        detail: `本次测评 ${progress.total} 题，已完成 ${progress.current} 题。AI 正在核对答案和维度证据。`,
        meta: `答题 ${progress.current}/${progress.total}`,
        completed: progress.current,
        total: progress.total + 1,
        percent: assessmentProgressPercent(progress.current, progress.total + 1, 0.35)
      });
    }
    try {
      const data = await api<{ result: GradeResult; abilities: Ability[] }>("/api/grade", {
        method: "POST",
        body: JSON.stringify({
          question: activeQuestion,
          answer: activeRecord.answer,
          sessionId,
          mode: activeMode,
          questionIndex: progress.current,
          durationSeconds: Math.round((Date.now() - questionStartedAt) / 1000)
        })
      });
      const nextAnswerRecords = {
        ...answerRecords,
        [progress.current]: { answer: activeRecord.answer, result: data.result }
      };
      setAnswerRecords(nextAnswerRecords);
      setState((prev) => ({ ...prev, abilities: data.abilities }));
      if (isAssessmentSubmit) {
        setAssessmentProgress({
          title: "正在规划后续流程",
          detail: `已完成 ${progress.current + 1}/${progress.total} 题，正在判断进入下一题、扩展题或报告生成。`,
          meta: `答题 ${progress.current + 1}/${progress.total}`,
          completed: progress.current + 1,
          total: progress.total + 1,
          percent: assessmentProgressPercent(progress.current + 1, progress.total + 1)
        });
        await nextQuestion(nextAnswerRecords);
      }
      completed = true;
    } catch (err) {
      setError(errorMessage(err, "批改失败，请检查 LM Studio 设置。"));
    } finally {
      setLoading("");
      if (isAssessmentSubmit) {
        if (completed) {
          await completeAssessmentProgress("批改完成", "结果已保存，正在更新答题界面。");
        } else {
          setAssessmentProgress(undefined);
        }
      }
    }
  }

  async function generateAssessmentExtensionQuestions(plan: AssessmentExtensionPlanItem[]) {
    if (activeMode !== "能力测评" || !sessionId || plan.length < 1) return;
    setError("");
    const extensionQuestions: Question[] = [];
    try {
      const concurrency = Math.min(plan.length, Math.max(1, Math.floor(Number(state.settings.maxConcurrentPredictions) || 1)));
      for (let start = 0; start < plan.length; start += concurrency) {
        const chunk = plan.slice(start, start + concurrency);
        setLoading(`AI 正在一次性生成扩展题 ${start + 1}-${start + chunk.length}/${plan.length}…`);
        const previousQuestions = [...questionQueue, ...extensionQuestions].map((item) => item.chinese);
        const results = await Promise.all(chunk.map((item, offset) => api<{ question?: Question; done?: boolean }>("/api/question", {
          method: "POST",
          body: JSON.stringify({
            mode: activeMode,
            dimension: item.dimension,
            difficulty: item.difficulty,
            previousQuestions,
            batchIndex: questionQueue.length + start + offset + 1,
            batchTotal: questionQueue.length + plan.length,
            forceAi: true,
            thinking: true
          })
        })));
        results.forEach((data) => {
          if (data.question && !data.done) extensionQuestions.push(data.question);
        });
      }
      if (extensionQuestions.length < 1) {
        setError("扩展题生成失败，请稍后重试。");
        return;
      }
      setAssessmentExtension({ phase: "preview", plan, questions: extensionQuestions, notes: {} });
      setSessionStarted(false);
    } catch (err) {
      setError(errorMessage(err, "扩展题生成失败，请检查 LM Studio 设置。"));
    } finally {
      setLoading("");
    }
  }

  function beginAssessmentExtension() {
    if (assessmentExtension.phase !== "preview") return;
    const extensionQuestions = assessmentExtension.questions;
    if (extensionQuestions.length < 1) return;
    setQuestionQueue((prev) => [...prev, ...extensionQuestions]);
    setProgress({ current: questionQueue.length, total: questionQueue.length + extensionQuestions.length });
    setSessionStarted(true);
    setAssessmentExtension({ phase: "idle" });
    setQuestionStartedAt(Date.now());
  }

  async function finalizeAssessment() {
    if (!sessionId) return;
    setLoading("正在生成能力测评报告…");
    const reportTotal = questionQueue.length + 1;
    setAssessmentProgress({
      title: "正在准备能力报告",
      detail: `答题已完成 ${questionQueue.length}/${questionQueue.length} 题，正在建立报告生成进度流。`,
      meta: `整体 ${questionQueue.length}/${reportTotal}`,
      completed: questionQueue.length,
      total: reportTotal,
      percent: assessmentProgressPercent(questionQueue.length, reportTotal)
    });
    let completed = false;
    const response = await fetch("/api/assessment/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    await readSseStream(response, (event, data) => {
      if (event === "error") throw new Error(data.message || "测评报告生成失败");
      setAssessmentProgress({
        title: data.title || "正在生成能力报告",
        detail: data.detail || "正在处理测评报告。",
        meta: event === "llm_delta"
          ? `整体 ${questionQueue.length}/${reportTotal} · LLM 生成中`
          : `整体 ${questionQueue.length}/${reportTotal}`,
        completed: event === "done" ? reportTotal : questionQueue.length,
        total: reportTotal,
        percent: clampNumber(Number(data.percent) || assessmentProgressPercent(questionQueue.length, reportTotal), 0, 100),
        generatedChars: data.generatedChars,
        estimatedTokens: data.estimatedTokens,
        tokensPerSecond: data.tokensPerSecond,
        finalTokens: data.finalTokens
      });
      if (event === "done") {
        completed = true;
        if (data.abilities) setState((prev) => ({ ...prev, abilities: data.abilities || prev.abilities }));
      }
    });
    if (!completed) throw new Error("测评报告生成中断");
    setSessionStarted(false);
    setSessionId(undefined);
    setActiveMode(undefined);
    setQuestionQueue([]);
    setAnswerRecords({});
    setPaperNotes({});
    setAssessmentExtension({ phase: "idle" });
    await refresh();
    setView("能力测评");
  }

  async function skipAssessmentExtension() {
    let completed = false;
    try {
      setError("");
      await finalizeAssessment();
      completed = true;
    } catch (err) {
      setError(errorMessage(err, "测评报告生成失败"));
    } finally {
      setLoading("");
      if (completed) {
        await completeAssessmentProgress("报告生成完成", "能力报告已保存，正在返回测评页面。");
      } else {
        setAssessmentProgress(undefined);
      }
    }
  }

  async function nextQuestion(records: Record<number, AnswerRecord> = answerRecords) {
    try {
      if (progress.current + 1 >= progress.total) {
        if (activeMode === "能力测评" && sessionId) {
          setAssessmentProgress({
            title: "正在分析是否需要扩展",
            detail: `已完成 ${progress.current + 1}/${progress.total} 题，正在检查薄弱和不确定维度。`,
            meta: `答题 ${progress.current + 1}/${progress.total}`,
            completed: progress.current + 1,
            total: progress.total + 1,
            percent: assessmentProgressPercent(progress.current + 1, progress.total + 1)
          });
          const nextAssessmentOptions = normalizeAssessmentOptions(assessmentOptions);
          const extensionPlan = nextAssessmentOptions.autoExtend
            ? buildAssessmentExtensionPlan(questionQueue, records, nextAssessmentOptions.maxCount)
            : [];
          if (extensionPlan.length > 0 && assessmentExtension.phase === "idle") {
            setAssessmentProgress({
              title: "扩展题方案已准备",
              detail: `已完成 ${progress.current + 1}/${progress.total} 题，发现 ${extensionPlan.length} 道候选扩展题。`,
              meta: `答题 ${progress.current + 1}/${progress.total}`,
              completed: progress.current + 1,
              total: progress.total + 1,
              percent: assessmentProgressPercent(progress.current + 1, progress.total + 1)
            });
            setAssessmentExtension({ phase: "decision", plan: extensionPlan });
            setSessionStarted(false);
            return;
          }
          await finalizeAssessment();
          return;
        }
        if (sessionId) await api("/api/session", { method: "POST", body: JSON.stringify({ action: "end", sessionId }) });
        setSessionStarted(false);
        setSessionId(undefined);
        setActiveMode(undefined);
        setQuestionQueue([]);
        setAnswerRecords({});
        setPaperNotes({});
        setAssessmentExtension({ phase: "idle" });
        await refresh();
        setView("数据统计");
        return;
      }
      const next = progress.current + 1;
      if (activeMode === "能力测评") {
        setAssessmentProgress({
          title: `正在进入第 ${next + 1} 题`,
          detail: `已完成 ${next}/${progress.total} 题，下一题准备就绪后会自动显示。`,
          meta: `答题 ${next}/${progress.total}`,
          completed: next,
          total: progress.total + 1,
          percent: assessmentProgressPercent(next, progress.total + 1)
        });
      }
      setProgress((prev) => ({ ...prev, current: next }));
      setQuestionStartedAt(Date.now());
    } catch (err) {
      setError(errorMessage(err, "进入下一题失败，请重试。"));
    } finally {
      setLoading("");
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (!event.ctrlKey && event.key === "Enter" && activeResult) {
      event.preventDefault();
      void nextQuestion();
    }
  }

  const errorDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    state.mistakes.forEach((mistake) => mistake.error_types.forEach((type) => counts.set(type, (counts.get(type) ?? 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [state.mistakes]);

  const trend = state.history.filter((item) => item.dimension === trendDimension);

  return (
    <div className="app" onKeyDown={onKeyDown}>
      <aside className="sidebar">
        <div className="brand">中译英<br />自适应训练系统</div>
        <div className="streak">连续训练 {state.streak} 天</div>
        <div className="nav">
          {navItems.map((item) => (
            <button key={item.name} className={view === item.name && !assessment ? "active" : ""} onClick={() => { setAssessment(false); setView(item.name); }}>
              {item.icon}{item.name}
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {assessment && !activeTraining && !paperPreview && (
          <StartPage
            mode="能力测评"
            state={state}
            total={normalizedAssessmentOptions.initialCount}
            specialDimension={specialDimension}
            setSpecialDimension={setSpecialDimension}
            assessmentOptions={assessmentOptions}
            setAssessmentOptions={setAssessmentOptions}
            loading={loading}
            error={error}
            onGenerate={() => generatePaper("能力测评")}
            onSkipAssessment={() => setAssessment(false)}
          />
        )}

        {!assessment && !activeTraining && assessmentExtension.phase === "decision" && (
          <AssessmentExtensionDecision
            plan={assessmentExtension.plan}
            loading={loading}
            error={error}
            onGenerate={() => generateAssessmentExtensionQuestions(assessmentExtension.plan)}
            onSkip={skipAssessmentExtension}
          />
        )}

        {!assessment && !activeTraining && assessmentExtension.phase === "preview" && (
          <AssessmentExtensionPreview
            questions={assessmentExtension.questions}
            loading={loading}
            error={error}
            onBegin={beginAssessmentExtension}
            onBack={() => setAssessmentExtension({ phase: "decision", plan: assessmentExtension.plan })}
          />
        )}

        {!assessment && !activeTraining && !paperPreview && assessmentExtension.phase === "idle" && visibleTrainingView && (
          <StartPage
            mode={startMode}
            state={state}
            total={startTotal}
            specialDimension={specialDimension}
            setSpecialDimension={setSpecialDimension}
            assessmentOptions={assessmentOptions}
            setAssessmentOptions={setAssessmentOptions}
            loading={loading}
            error={error}
            onGenerate={() => generatePaper(startMode)}
          />
        )}

        {!assessment && !activeTraining && !paperPreview && assessmentExtension.phase === "idle" && view === "能力测评" && (
          <AssessmentHistory
            reports={state.assessmentReports}
            page={state.assessmentReportPage}
            pageSize={state.assessmentReportPageSize}
            total={state.assessmentReportTotal}
            pageCount={state.assessmentReportPageCount}
            latestAssessmentAt={state.latestAssessmentAt}
            onPageChange={setAssessmentReportPage}
            onStartNew={() => generatePaper("能力测评")}
            loading={loading}
          />
        )}

        {paperPreview && visibleTrainingView && activeMode && (
          <PaperPreview
            mode={activeMode}
            questions={questionQueue}
            notes={paperNotes}
            setNotes={setPaperNotes}
            loading={loading}
            error={error}
            onRegenerate={regenerateQuestion}
            onBegin={beginAnswering}
            onAbandon={abandonPaper}
          />
        )}

        {activeTraining && visibleTrainingView && (
          <section style={{ position: "relative" }}>
            <div className="topbar">
              <div>
                <h1 className="title">
                  {activeMode === "能力测评" && activeQuestion ? `${activeQuestion.dimension} ${progress.current + 1}/${progress.total}` : activeMode}
                </h1>
                <div className="muted">本次训练进度 {progress.current + 1}/{progress.total}</div>
              </div>
              <div className="row">
                <button onClick={() => setShowDelta((x) => !x)}>今日能力变化</button>
              </div>
            </div>

            {showDelta && (
              <div className="floating">
                <strong>今日能力变化</strong>
                {state.abilities.map((item) => {
                  const before = beforeScores.find((x) => x.dimension === item.dimension)?.score ?? 0;
                  return <p key={item.dimension}>{item.dimension}：{before} → {item.score}</p>;
                })}
              </div>
            )}

            {loading && <p className="loading"><span className="spinner" />{loading}</p>}
            {error && <div className="notice">{error}</div>}
            {activeQuestion && (
              <>
                <div className="question"><h2>{activeQuestion.chinese}</h2></div>
                <p className="muted">考查维度：{activeQuestion.dimension}</p>
                {activeMode === "能力测评" && Boolean(activeQuestion.vocabulary_tips?.length) && (
                  <div className="tips" aria-label="关键词提示">
                    <strong>TIPS</strong>
                    {activeQuestion.vocabulary_tips?.map((tip) => <span key={tip}>{tip}</span>)}
                  </div>
                )}
                <textarea
                  value={activeRecord.answer}
                  onChange={(event) => {
                    const nextAnswer = event.target.value;
                    setAnswerRecords((prev) => ({
                      ...prev,
                      [progress.current]: { ...prev[progress.current], answer: nextAnswer }
                    }));
                  }}
                  readOnly={Boolean(activeResult)}
                  placeholder="请输入你的英文翻译…"
                />
                <div className="actions">
                  {!activeResult ? <button className="primary" onClick={submit} disabled={Boolean(loading) || !activeRecord.answer.trim()}>提交</button> : <button className="primary" onClick={() => nextQuestion()}>下一题</button>}
                </div>
                {activeMode !== "能力测评" && activeResult && <p className="muted">语法点说明：{activeQuestion.grammar_focus}</p>}
                {activeMode !== "能力测评" && activeResult && <Feedback result={activeResult} />}
              </>
            )}
          </section>
        )}

        {view === "数据统计" && !assessment && (
          <Stats state={state} trend={trend} trendDimension={trendDimension} setTrendDimension={setTrendDimension} errorDistribution={errorDistribution} onPickDimension={(dimension) => { setSpecialDimension(dimension); setView("专项训练"); }} />
        )}

        {view === "设置" && !assessment && (
          <SettingsPanel draft={settingsDraft} setDraft={setSettingsDraft} refresh={refresh} setError={setError} error={error} />
        )}

        {assessmentProgress && <AssessmentProgressModal progress={assessmentProgress} />}
      </main>
    </div>
  );
}

function AssessmentProgressModal({ progress }: { progress: AssessmentProgress }) {
  const complete = progress.status === "complete";
  return (
    <div className="assessment-loading-backdrop" role="presentation">
      <section className={`assessment-loading-modal${complete ? " complete" : ""}`} role="dialog" aria-modal="true" aria-labelledby="assessment-loading-title">
        {complete ? (
          <div className="assessment-complete-mark" aria-hidden="true">
            <CheckCircle2 size={48} strokeWidth={2.4} />
          </div>
        ) : (
          <div className="assessment-loader" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
        <div className="assessment-loading-copy">
          <h2 id="assessment-loading-title">{progress.title}</h2>
          <p>{progress.detail}</p>
        </div>
        <div className="assessment-progress-meta">
          <span>{progress.meta}</span>
          <strong>{progress.percent}%</strong>
        </div>
        <div className="assessment-progress-bar" aria-label={`加载进度 ${progress.percent}%`}>
          <span style={{ width: `${progress.percent}%` }} />
        </div>
        {(progress.estimatedTokens !== undefined || progress.generatedChars !== undefined || progress.tokensPerSecond !== undefined) && (
          <div className="assessment-token-stats" aria-label="LLM 生成统计">
            {progress.estimatedTokens !== undefined && <span>约 {progress.finalTokens ?? progress.estimatedTokens} tokens</span>}
            {progress.tokensPerSecond !== undefined && progress.tokensPerSecond > 0 && <span>{progress.tokensPerSecond} tokens/s</span>}
            {progress.generatedChars !== undefined && <span>{progress.generatedChars} 字符</span>}
          </div>
        )}
      </section>
    </div>
  );
}

function StartPage({ mode, state, total, specialDimension, setSpecialDimension, assessmentOptions, setAssessmentOptions, loading, error, onGenerate, onSkipAssessment }: {
  mode: TrainingMode;
  state: AppState;
  total: number;
  specialDimension: Dimension;
  setSpecialDimension: (value: Dimension) => void;
  assessmentOptions: AssessmentOptions;
  setAssessmentOptions: Dispatch<SetStateAction<AssessmentOptions>>;
  loading: string;
  error: string;
  onGenerate: () => void;
  onSkipAssessment?: () => void;
}) {
  const activeMistakes = state.mistakes.filter((item) => item.correct_streak < 2).length;
  const disabled = Boolean(loading) || (mode === "错题重练" && total < 1);
  const normalizedAssessmentOptions = normalizeAssessmentOptions(assessmentOptions);
  const description = mode === "能力测评"
    ? assessmentOptions.autoExtend
      ? `开始后会先生成 ${normalizedAssessmentOptions.initialCount} 道测评题；系统会根据薄弱和不确定维度最多追加到 ${normalizedAssessmentOptions.maxCount} 题，结束后统一生成能力报告。`
      : `开始后只生成 ${normalizedAssessmentOptions.initialCount} 道测评题，不自动追加题目，结束后统一生成能力报告。`
    : mode === "每日练习"
      ? `开始后会一次性生成 ${total} 道题，优先穿插未掌握错题，再根据当前能力选择薄弱维度。`
      : mode === "专项训练"
        ? `开始后会一次性生成 ${total} 道 ${specialDimension} 题，集中训练单一语法维度。`
        : activeMistakes > 0
          ? `开始后会一次性生成 ${total} 道错题重练，答对两次的错题会从重练列表移除。`
          : "当前没有需要重练的错题。";

  return (
    <section>
      <div className="topbar">
        <div>
          <h1 className="title">{mode}</h1>
          <p className="muted">{description}</p>
        </div>
        {mode === "专项训练" && (
          <select className="compact-select" value={specialDimension} onChange={(event) => setSpecialDimension(event.target.value as Dimension)}>
            {DIMENSIONS.map((dimension) => <option key={dimension}>{dimension}</option>)}
          </select>
        )}
      </div>

      {mode === "能力测评" && (
        <section className="section assessment-controls">
          <label>
            测试题目数量
            <input
              type="number"
              min={ASSESSMENT_INPUT_MIN}
              max={ASSESSMENT_INPUT_MAX}
              value={assessmentOptions.initialCount}
              onChange={(event) => {
                const initialCount = clampNumber(Number(event.target.value), ASSESSMENT_INPUT_MIN, ASSESSMENT_INPUT_MAX);
                setAssessmentOptions((prev) => ({
                  ...prev,
                  initialCount,
                  maxCount: Math.max(initialCount, prev.maxCount)
                }));
              }}
            />
          </label>
          <label>
            扩展上限题目数量
            <input
              type="number"
              min={normalizedAssessmentOptions.initialCount}
              max={ASSESSMENT_INPUT_MAX}
              value={assessmentOptions.maxCount}
              disabled={!assessmentOptions.autoExtend}
              onChange={(event) => {
                const maxCount = clampNumber(Number(event.target.value), normalizedAssessmentOptions.initialCount, ASSESSMENT_INPUT_MAX);
                setAssessmentOptions((prev) => ({ ...prev, maxCount }));
              }}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={assessmentOptions.autoExtend}
              onChange={(event) => setAssessmentOptions((prev) => ({ ...prev, autoExtend: event.target.checked }))}
            />
            自动扩展测试题
          </label>
        </section>
      )}

      <div className="section radar-wrap">
        <Radar abilities={state.abilities} />
        <div className="bars">
          <h2>当前能力预览</h2>
          {state.abilities.map((item) => (
            <div className="bar-row" key={item.dimension}>
              <span>{item.dimension}</span><div className="bar"><span style={{ width: `${item.score}%` }} /></div><strong>{item.score}</strong>
            </div>
          ))}
        </div>
      </div>

      {mode === "能力测评" && (
        <section className="section">
          <h2>测评维度说明</h2>
          <div className="dimension-list">
            {DIMENSIONS.map((dimension) => (
              <div key={dimension}>
                <strong>{dimension}</strong>
                <p className="muted">{DIMENSION_NOTES[dimension]}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button className="primary" onClick={onGenerate} disabled={disabled}>
          {mode === "能力测评" ? <ClipboardList size={16} /> : <Dumbbell size={16} />} 生成试卷
        </button>
        {onSkipAssessment && <button onClick={onSkipAssessment} disabled={Boolean(loading)}>跳过测评</button>}
      </div>
      {loading && <p className="loading"><span className="spinner" />{loading}</p>}
      {error && <div className="notice">{error}</div>}
    </section>
  );
}

function PaperPreview({ mode, questions, notes, setNotes, loading, error, onRegenerate, onBegin, onAbandon }: {
  mode: TrainingMode;
  questions: Question[];
  notes: Record<number, PaperNote>;
  setNotes: Dispatch<SetStateAction<Record<number, PaperNote>>>;
  loading: string;
  error: string;
  onRegenerate: (index: number) => void;
  onBegin: () => void;
  onAbandon: () => void;
}) {
  return (
    <section>
      <div className="topbar">
        <div>
          <h1 className="title">{mode} · 试卷预览</h1>
          <p className="muted">共 {questions.length} 题。可以为单题填写调整原因并重新生成，确认后再开始答题。</p>
        </div>
        <div className="row">
          <button className="danger" onClick={onAbandon} disabled={Boolean(loading)}><Trash2 size={16} /> 放弃试卷</button>
          <button className="primary" onClick={onBegin} disabled={Boolean(loading)}>开始</button>
        </div>
      </div>
      {loading && <p className="loading"><span className="spinner" />{loading}</p>}
      {error && <div className="notice">{error}</div>}
      <div className="paper-list">
        {questions.map((question, index) => (
          <section className="paper-item" key={`${question.chinese}-${index}`}>
            <div className="paper-item-header">
              <div>
                <strong>第 {index + 1} 题</strong>
                <p className="muted">{question.dimension} · 难度 {question.difficulty}</p>
              </div>
              <button onClick={() => onRegenerate(index)} disabled={Boolean(loading) || Boolean(notes[index]?.loading)}>
                <RotateCcw size={16} /> {notes[index]?.loading ? "生成中…" : "重新生成"}
              </button>
            </div>
            <h2>{question.chinese}</h2>
            <p className="muted">语法点：{question.grammar_focus}</p>
            <textarea
              className="reason-input"
              value={notes[index]?.reason ?? ""}
              onChange={(event) => {
                const reason = event.target.value;
                setNotes((prev) => ({ ...prev, [index]: { ...prev[index], reason } }));
              }}
              placeholder="填写重生成原因，例如：场景太重复、句子太简单、希望更贴近工作场景…"
            />
          </section>
        ))}
      </div>
    </section>
  );
}

function AssessmentExtensionDecision({ plan, loading, error, onGenerate, onSkip }: {
  plan: AssessmentExtensionPlanItem[];
  loading: string;
  error: string;
  onGenerate: () => void;
  onSkip: () => void;
}) {
  const grouped = plan.reduce<Record<string, AssessmentExtensionPlanItem[]>>((acc, item) => {
    acc[item.dimension] = [...(acc[item.dimension] ?? []), item];
    return acc;
  }, {});
  return (
    <section>
      <div className="topbar">
        <div>
          <h1 className="title">是否扩展本次测评</h1>
          <p className="muted">系统已完成基础题组批改。下面这些维度仍缺少稳定判断依据，确认后会一次性生成 {plan.length} 道扩展题。</p>
        </div>
      </div>
      <section className="section extension-explain">
        <h2>扩展原因</h2>
        <p>
          能力测评报告会把每道题拆成主维度和次维度证据。如果某个维度的证据数量偏少、分数处在 45-75 的临界区间，或已经呈现明显薄弱趋势，
          直接生成报告容易把偶然失误当成稳定短板。扩展题会优先补齐这些维度，让最终能力矩阵和训练建议更可靠。
        </p>
        <div className="extension-grid">
          {Object.entries(grouped).map(([dimension, items]) => (
            <div key={dimension}>
              <strong>{dimension}</strong>
              <p className="muted">将追加 {items.length} 题 · 当前估算 {items[0].score} · 证据 {items[0].evidence} 条</p>
              <p>{items[0].reason}</p>
            </div>
          ))}
        </div>
      </section>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button className="primary" onClick={onGenerate} disabled={Boolean(loading)}>生成扩展题</button>
        <button onClick={onSkip} disabled={Boolean(loading)}>不扩展，直接生成报告</button>
      </div>
      {loading && <p className="loading"><span className="spinner" />{loading}</p>}
      {error && <div className="notice">{error}</div>}
    </section>
  );
}

function AssessmentExtensionPreview({ questions, loading, error, onBegin, onBack }: {
  questions: Question[];
  loading: string;
  error: string;
  onBegin: () => void;
  onBack: () => void;
}) {
  return (
    <section>
      <div className="topbar">
        <div>
          <h1 className="title">能力测评 · 扩展题预览</h1>
          <p className="muted">共 {questions.length} 道扩展题。确认后会继续本次测评，答完后统一生成能力报告。</p>
        </div>
        <div className="row">
          <button onClick={onBack} disabled={Boolean(loading)}>返回原因页</button>
          <button className="primary" onClick={onBegin} disabled={Boolean(loading)}>确认并继续</button>
        </div>
      </div>
      {loading && <p className="loading"><span className="spinner" />{loading}</p>}
      {error && <div className="notice">{error}</div>}
      <div className="paper-list">
        {questions.map((question, index) => (
          <section className="paper-item" key={`${question.chinese}-${index}`}>
            <div className="paper-item-header">
              <div>
                <strong>扩展题 {index + 1}</strong>
                <p className="muted">{question.dimension} · 难度 {question.difficulty}</p>
              </div>
            </div>
            <h2>{question.chinese}</h2>
            <p className="muted">语法点：{question.grammar_focus}</p>
          </section>
        ))}
      </div>
    </section>
  );
}

function AssessmentHistory({ reports, page, pageSize, total, pageCount, latestAssessmentAt, onPageChange, onStartNew, loading }: {
  reports: AssessmentReport[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  latestAssessmentAt: string | null;
  onPageChange: (page: number) => void;
  onStartNew: () => void;
  loading: string;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const showReports = total > 0;
  const showPagination = total > pageSize;
  const [selectedReport, setSelectedReport] = useState<AssessmentReport | null>(null);

  useEffect(() => {
    if (!selectedReport) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedReport]);

  return (
    <section className="section">
      <div className="topbar">
        <div>
          <h2>能力测评</h2>
          {showReports && <p className="muted">{elapsedText(latestAssessmentAt)}</p>}
          {!showReports && <p className="muted">暂无测评记录，可以先开始一次新测评。</p>}
        </div>
        <button onClick={onStartNew} disabled={Boolean(loading)}><History size={16} /> 开始新测评</button>
      </div>
      {showPagination && (
        <div className="pagination">
          <span className="muted">第 {page}/{pageCount} 页 · 共 {total} 条 · 当前显示 {start}-{end}</span>
          <div className="row">
            <button onClick={() => onPageChange(page - 1)} disabled={Boolean(loading) || page <= 1}>上一页</button>
            <button onClick={() => onPageChange(page + 1)} disabled={Boolean(loading) || page >= pageCount}>下一页</button>
          </div>
        </div>
      )}
      {showReports && (
        <div className="report-list">
          {reports.map((report) => (
            <div className="report-row" key={report.id}>
              <div>
                <strong>{new Date(report.created_at).toLocaleString()}</strong>
                <p className="muted">{report.total_questions} 题 · Session #{report.session_id}</p>
                <p className="report-summary">{report.summary}</p>
              </div>
              <div className="report-side">
                <div className="report-scores">
                  {report.matrix.map((item) => <span key={item.dimension}>{item.dimension} {item.score}</span>)}
                </div>
                <button onClick={() => setSelectedReport(report)}><Eye size={16} /> 查看详情</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {selectedReport && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelectedReport(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="assessment-report-title" onClick={(event) => event.stopPropagation()}>
            <div className="topbar">
              <div>
                <h2 id="assessment-report-title">能力测评详情</h2>
                <p className="muted">{new Date(selectedReport.created_at).toLocaleString()} · {selectedReport.total_questions} 题 · Session #{selectedReport.session_id}</p>
              </div>
              <button aria-label="关闭详情" onClick={() => setSelectedReport(null)}><X size={16} /></button>
            </div>
            <div className="report-detail">
              <strong>概要</strong>
              <p>{selectedReport.summary}</p>
              <strong>能力矩阵</strong>
              <div className="report-scores">
                {selectedReport.matrix.map((item) => <span key={item.dimension}>{item.dimension} {item.score} · 证据 {item.evidence_count}</span>)}
              </div>
              <strong>优先薄弱点</strong>
              {selectedReport.weak_points.map((item, index) => <p key={`modal-weak-${selectedReport.id}-${index}`}>{index + 1}. {item}</p>)}
              <strong>训练建议</strong>
              {selectedReport.recommendations.map((item, index) => <p key={`modal-rec-${selectedReport.id}-${index}`}>{index + 1}. {item}</p>)}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function Stats({ state, trend, trendDimension, setTrendDimension, errorDistribution, onPickDimension }: {
  state: AppState;
  trend: AbilityHistory[];
  trendDimension: Dimension;
  setTrendDimension: (value: Dimension) => void;
  errorDistribution: Array<[string, number]>;
  onPickDimension: (dimension: Dimension) => void;
}) {
  const maxErrors = Math.max(1, ...errorDistribution.map((x) => x[1]));
  const latestReport = state.latestAssessmentReport;
  const points = trend.map((item, index) => {
    const x = trend.length <= 1 ? 10 : (index / (trend.length - 1)) * 280 + 10;
    const y = 160 - item.score * 1.4;
    return `${x},${y}`;
  }).join(" ");
  return (
    <>
      <h1 className="title">数据统计</h1>
      <section className="section radar-wrap">
        <Radar abilities={state.abilities} onPick={onPickDimension} />
        <div className="bars">
          {state.abilities.map((item) => (
            <div className="bar-row" key={item.dimension}>
              <span>{item.dimension}</span><div className="bar"><span style={{ width: `${item.score}%` }} /></div><strong>{item.score}</strong>
            </div>
          ))}
        </div>
      </section>
      <div className="grid">
        <section className="section">
          <h2>最近测评报告</h2>
          {!latestReport && <p className="muted">暂无测评报告</p>}
          {latestReport && (
            <div className="report">
              <p className="muted">{new Date(latestReport.created_at).toLocaleString()} · {latestReport.total_questions} 题</p>
              <p>{latestReport.summary}</p>
              <strong>优先薄弱点</strong>
              {latestReport.weak_points.map((item, index) => <p key={`weak-${index}`}>{index + 1}. {item}</p>)}
              <strong>训练建议</strong>
              {latestReport.recommendations.map((item, index) => <p key={`rec-${index}`}>{index + 1}. {item}</p>)}
            </div>
          )}
        </section>
        <section className="section">
          <div className="row"><h2>最近 30 天趋势</h2><select value={trendDimension} onChange={(e) => setTrendDimension(e.target.value as Dimension)}>{DIMENSIONS.map((d) => <option key={d}>{d}</option>)}</select></div>
          <svg className="mini-chart" viewBox="0 0 300 180">
            <polyline points={points} fill="none" stroke="#75b7ff" strokeWidth="3" />
            {trend.map((item, index) => <circle key={`${item.date}-${index}`} cx={trend.length <= 1 ? 10 : (index / (trend.length - 1)) * 280 + 10} cy={160 - item.score * 1.4} r="4" fill="#75b7ff" />)}
          </svg>
        </section>
        <section className="section">
          <h2>错误分布</h2>
          <div className="bars">
            {errorDistribution.length === 0 && <p className="muted">暂无错误记录</p>}
            {errorDistribution.map(([type, count]) => <div className="bar-row" key={type}><span>{type}</span><div className="bar"><span style={{ width: `${(count / maxErrors) * 100}%` }} /></div><strong>{count}</strong></div>)}
          </div>
        </section>
      </div>
      <section className="section">
        <h2>训练记录</h2>
        <table className="table"><thead><tr><th>日期</th><th>模式</th><th>题数</th><th>正确率</th></tr></thead><tbody>{state.records.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.mode}</td><td>{r.total}</td><td>{r.accuracy}%</td></tr>)}</tbody></table>
      </section>
    </>
  );
}

function SettingsPanel({ draft, setDraft, refresh, setError, error }: {
  draft: Settings;
  setDraft: (value: Settings) => void;
  refresh: () => Promise<void>;
  setError: (value: string) => void;
  error: string;
}) {
  const [message, setMessage] = useState("");
  async function save() {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(draft) });
    setMessage("设置已保存");
    await refresh();
  }
  async function test() {
    setMessage("正在测试连接…");
    try {
      await api("/api/settings/test", { method: "POST" });
      setMessage("连接成功");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "连接失败");
    }
  }
  async function reset(type: "assessment" | "all") {
    if (type === "all" && !confirm("确认清除所有训练数据？此操作不可恢复。")) return;
    if (type === "assessment" && !confirm("确认重置能力评估？能力图谱将清空。")) return;
    await api("/api/reset", { method: "POST", body: JSON.stringify({ type: type === "all" ? "all" : "abilities" }) });
    await refresh();
    setError("");
    setMessage("操作完成");
  }
  return (
    <section>
      <h1 className="title">设置</h1>
      <div className="section form-grid">
        <label>LM Studio 服务地址<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
        <label>模型名称<input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="填写 LM Studio 中加载的模型名" /></label>
        <label>Temperature<input type="number" min="0" max="1" step="0.1" value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} /></label>
        <label>每日练习题数<input type="number" min="10" max="50" value={draft.dailyCount} onChange={(e) => setDraft({ ...draft, dailyCount: Number(e.target.value) })} /></label>
        <label>应用并发生成数<input type="number" min="1" max="10" value={draft.maxConcurrentPredictions} onChange={(e) => setDraft({ ...draft, maxConcurrentPredictions: Number(e.target.value) })} /><span className="field-hint">建议与 LM Studio 的 Max Concurrent Predictions 保持一致。</span></label>
      </div>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button className="primary" onClick={save}>保存设置</button>
        <button onClick={test}>测试连接</button>
        <button onClick={() => reset("assessment")}>重置能力评估</button>
        <button className="danger" onClick={() => reset("all")}>清除所有数据</button>
      </div>
      {(message || error) && <div className="notice">{message || error}</div>}
    </section>
  );
}
