"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { BarChart3, BookOpenCheck, CheckCircle2, ClipboardList, Dumbbell, Eye, GraduationCap, History, LogOut, MessageCircle, MessageSquarePlus, RotateCcw, Send, Settings as SettingsIcon, Shield, Target, Trash2, X } from "lucide-react";
import AbilityMotionField from "./AbilityMotionField";
import { publicQuestionSkills } from "@/lib/questionSafety";
import { Ability, AbilityHistory, AssessmentReport, CapturedDrill, DIMENSIONS, Dimension, DrillCard, FollowUpMessage, GradeResult, Mistake, PracticeReport, Question, Settings, SkillAbility, StudyGuide, TrainingRecord } from "@/lib/types";

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
  skillAbilities?: SkillAbility[];
};
type ConnectionTestItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};
type ConnectionTestResult = {
  tests: ConnectionTestItem[];
};
type ConnectionTestResponse = ConnectionTestResult & {
  ok: boolean;
  message?: string;
  result?: ConnectionTestResult;
};
type SettingsTestTarget = "global" | "personal";
type CaptureResponse = {
  id?: number;
  card: DrillCard;
};
type CaptureState = {
  open: boolean;
  sourceCn: string;
  card?: DrillCard;
  loading: string;
  error: string;
  saved: boolean;
};
type LlmQueueSnapshot = {
  state: "idle" | "processing" | "queued";
  pendingCount: number;
  runningCount: number;
  myPosition: number | null;
  completedCount: number;
  failedCount: number;
};
type SettingsDraft = Settings & {
  personalApiKey?: string;
  clearPersonalApiKey?: boolean;
};
type CurrentUser = {
  id: number;
  username: string;
  role: "admin" | "user";
};
type QuestionResponse = {
  question?: Question;
  questions?: Question[];
  done?: boolean;
};
type AppState = {
  user: CurrentUser | null;
  settings: Settings;
  abilities: Ability[];
  skillAbilities: SkillAbility[];
  history: AbilityHistory[];
  mistakes: Mistake[];
  capturedDrills: CapturedDrill[];
  capturedDrillCount: number;
  activeCapturedDrillCount: number;
  records: TrainingRecord[];
  latestPracticeReport: PracticeReport | null;
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
  user: null,
  settings: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7-flash",
    temperature: 0.3,
    dailyCount: 20,
    maxConcurrentPredictions: 20,
    personalProviderEnabled: false,
    personalBaseUrl: "https://api.siliconflow.cn/v1",
    personalModel: "deepseek-ai/DeepSeek-V4-Flash",
    hasPersonalApiKey: false
  },
  abilities: DIMENSIONS.map((dimension) => ({ dimension, score: 50, evidence_count: 0 })),
  skillAbilities: [],
  history: [],
  mistakes: [],
  capturedDrills: [],
  capturedDrillCount: 0,
  activeCapturedDrillCount: 0,
  records: [],
  latestPracticeReport: null,
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

const ASSESSMENT_MIN = 12;
const ASSESSMENT_MAX = 18;
const ASSESSMENT_MIN_WEIGHTED_EVIDENCE = 2.2;
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
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
  }
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
  if (verdict === "partial") return 40;
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
    const uncertain = totalWeight < ASSESSMENT_MIN_WEIGHTED_EVIDENCE || (score >= 45 && score <= 75 && mixed);
    const weak = score > 0 && score < 70;
    return { dimension, score, evidence, weightedEvidence: totalWeight, uncertain, weak };
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
      target.uncertain ? `加权证据 ${target.weightedEvidence.toFixed(1)}，仍不足以稳定判断该维度。` : "",
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

function formatAbilityScore(score: number) {
  return score.toFixed(2).replace(/\.?0+$/, "");
}

function abilityScoreLabel(ability: Ability) {
  return ability.evidence_count > 0 ? formatAbilityScore(ability.score) : "待测";
}

function abilityEvidenceLabel(ability: Ability) {
  return ability.evidence_count > 0 ? `证据 ${ability.evidence_count}` : "证据不足";
}

function weakSkillsForDimension(skillAbilities: SkillAbility[], dimension: Dimension, limit = 5) {
  return skillAbilities
    .filter((item) => item.dimension === dimension && item.evidence_count > 0 && item.score < 70)
    .sort((a, b) => a.score - b.score || b.evidence_count - a.evidence_count)
    .slice(0, limit);
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

function Feedback({ question, userAnswer, result }: { question: Question; userAnswer: string; result: GradeResult }) {
  const [messages, setMessages] = useState<FollowUpMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function askFollowUp() {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || loading) return;
    const nextMessages: FollowUpMessage[] = [...messages, { role: "user", content: nextPrompt }];
    setMessages(nextMessages);
    setPrompt("");
    setError("");
    setLoading(true);
    try {
      const data = await api<{ answer: string }>("/api/followup", {
        method: "POST",
        body: JSON.stringify({
          question,
          userAnswer,
          result,
          messages,
          prompt: nextPrompt
        })
      });
      setMessages([...nextMessages, { role: "assistant", content: data.answer }]);
    } catch (err) {
      setMessages(messages);
      setPrompt(nextPrompt);
      setError(errorMessage(err, "追问失败"));
    } finally {
      setLoading(false);
    }
  }

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
      {(Boolean(question.skills?.length) || Boolean(result.skill_findings?.length)) && (
        <div className="skill-feedback">
          {Boolean(question.skills?.length) && (
            <div>
              <strong>本题技能</strong>
              <div>{question.skills?.map((item) => <span className="tag skill-tag" key={item}>{item}</span>)}</div>
            </div>
          )}
          {Boolean(result.skill_findings?.length) && (
            <div>
              <strong>技能诊断</strong>
              <div>{result.skill_findings?.map((item) => <span className="tag finding-tag" key={item}>{item}</span>)}</div>
            </div>
          )}
        </div>
      )}
      {result.memory_tip && <div><strong>记忆技巧</strong><p>{result.memory_tip}</p></div>}
      <div className="followup-panel">
        <div className="followup-title"><MessageCircle size={17} /><strong>继续追问</strong></div>
        {messages.length > 0 && (
          <div className="followup-thread">
            {messages.map((message, index) => (
              <div className={`followup-message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === "user" ? "我" : "LLM"}</span>
                <p>{message.content}</p>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="followup-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：为什么这里不能用现在完成时？"
          disabled={loading}
        />
        {error && <div className="notice compact">{error}</div>}
        <div className="actions">
          <button className="primary icon-button-text" onClick={askFollowUp} disabled={loading || !prompt.trim()}>
            <Send size={16} />
            {loading ? "追问中…" : "追问"}
          </button>
        </div>
      </div>
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
  const [studyGuide, setStudyGuide] = useState<StudyGuide>();
  const [studyGuideOpen, setStudyGuideOpen] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 20 });
  const [beforeScores, setBeforeScores] = useState<Ability[]>(emptyState.abilities);
  const [showDelta, setShowDelta] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(emptyState.settings);
  const [llmStatus, setLlmStatus] = useState<LlmQueueSnapshot>({
    state: "idle",
    pendingCount: 0,
    runningCount: 0,
    myPosition: null,
    completedCount: 0,
    failedCount: 0
  });
  const [assessmentOptions, setAssessmentOptions] = useState<AssessmentOptions>(DEFAULT_ASSESSMENT_OPTIONS);
  const [assessmentExtension, setAssessmentExtension] = useState<AssessmentExtensionState>({ phase: "idle" });
  const [, setAssessmentProgress] = useState<AssessmentProgress>();
  const [assessmentReportPage, setAssessmentReportPage] = useState(1);
  const [assessmentReportPageSize] = useState(10);
  const [trendDimension, setTrendDimension] = useState<Dimension>("时态");
  const [questionStartedAt, setQuestionStartedAt] = useState(Date.now());
  const [capture, setCapture] = useState<CaptureState>({
    open: false,
    sourceCn: "",
    loading: "",
    error: "",
    saved: false
  });

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

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const readStatus = async () => {
      try {
        const next = await api<LlmQueueSnapshot>("/api/llm/status");
        if (!cancelled) setLlmStatus(next);
      } catch {
        // Auth redirects and transient status failures are handled elsewhere.
      }
    };
    if (typeof EventSource === "undefined") {
      void readStatus();
      interval = setInterval(readStatus, 5000);
      return () => {
        cancelled = true;
        if (interval) clearInterval(interval);
      };
    }
    const source = new EventSource("/api/llm/events");
    source.addEventListener("status", (event) => {
      setLlmStatus(JSON.parse((event as MessageEvent).data) as LlmQueueSnapshot);
    });
    source.onerror = () => {
      source.close();
      void readStatus();
      interval = setInterval(readStatus, 5000);
    };
    return () => {
      cancelled = true;
      source.close();
      if (interval) clearInterval(interval);
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

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
      questions.push(...state.capturedDrills
        .filter((item) => item.correct_streak < 2)
        .slice(0, nextTotal)
        .map((item) => ({
          chinese: item.source_cn,
          answers: [item.reference_en],
          grammar_focus: item.common_mistake,
          dimension: item.grammar_dimension,
          skills: item.common_mistake ? [item.common_mistake] : [],
          rubric_points: [
            `自然口语：${item.casual}`,
            `标准表达：${item.standard}`,
            `生动表达：${item.vivid}`,
            `记忆钩子：${item.memory_hook}`
          ],
          difficulty: item.difficulty,
          origin: "user_capture",
          captureId: item.id
        }) satisfies Question));
      if (questions.length > 0) {
        setPaperGenerationProgress(nextMode, questions.length, nextTotal, `已加入 ${questions.length} 张快速捕捉卡，正在补齐本次练习试卷。`);
      }
      // 每日练习包含错题
      // questions.push(...activeMistakes.slice(0, nextTotal).map((mistake) => ({ ...mistake, source: "mistake", mistakeId: mistake.id }) satisfies Question));
      // if (questions.length > 0) {
      //   setPaperGenerationProgress(nextMode, questions.length, nextTotal, `已加入 ${questions.length} 道错题，正在补齐本次练习试卷。`);
      // }
    }

    const aiTotal = nextTotal - questions.length;
    if (aiTotal < 1) return questions;
    const from = questions.length + 1;
    const to = nextTotal;
    setLoading(`AI 正在生成题目 ${from}-${to}/${nextTotal}…`);
    setPaperGenerationProgress(nextMode, questions.length, nextTotal, `AI 正在规划并生成第 ${from}-${to} 题。`);
    const previousQuestions = questions.map((question) => question.chinese);
    const specs = Array.from({ length: aiTotal }, (_, offset) => {
      const index = questions.length + offset;
      const nextAssessmentStep = assessmentStepAt(index);
      const dimension = nextMode === "能力测评" ? nextAssessmentStep.dimension : nextMode === "专项训练" ? specialDimension : undefined;
      const difficulty = nextMode === "能力测评" ? nextAssessmentStep.difficulty : undefined;
      const focusSkills = dimension ? weakSkillsForDimension(state.skillAbilities, dimension).map((item) => item.skill) : [];
      return {
        dimension,
        difficulty,
        focusSkills,
        batchIndex: index + 1,
        batchTotal: nextTotal
      };
    });
    const data = await api<QuestionResponse>("/api/question", {
      method: "POST",
      body: JSON.stringify({
        mode: nextMode,
        questions: specs,
        previousQuestions,
        forceAi: true
      })
    });
    if (data.done) return questions;
    questions.push(...(data.questions ?? (data.question ? [data.question] : [])));
    setPaperGenerationProgress(nextMode, questions.length, nextTotal, `已生成 ${questions.length}/${nextTotal} 题。`);
    return questions;
  }

  async function generatePaper(nextMode: TrainingMode = startMode) {
    try {
      setError("");
      setQuestionQueue([]);
      setAnswerRecords({});
      setPaperNotes({});
      setStudyGuide(undefined);
      setStudyGuideOpen(false);
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
      setError(errorMessage(err, "试卷生成失败，请检查 GLM 设置后重试。"));
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
      const data = await api<QuestionResponse>("/api/question", {
        method: "POST",
        body: JSON.stringify({
          mode: activeMode,
          dimension: current.dimension,
          difficulty: current.difficulty,
          focusSkills: activeMode === "专项训练" ? weakSkillsForDimension(state.skillAbilities, current.dimension).map((item) => item.skill) : [],
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
      setStudyGuide(undefined);
      setStudyGuideOpen(false);
    }
  }

  async function generatePaperStudyGuide() {
    if (questionQueue.length < 1) return;
    if (studyGuide) {
      setStudyGuideOpen(true);
      return;
    }
    setError("");
    setLoading("AI 正在生成专项学习内容…");
    try {
      const data = await api<{ guide: StudyGuide }>("/api/study", {
        method: "POST",
        body: JSON.stringify({
          questions: questionQueue.map((question) => ({
            dimension: question.dimension,
            secondary_dimensions: question.secondary_dimensions,
            grammar_focus: question.grammar_focus,
            skills: question.skills,
            rubric_points: question.rubric_points,
            difficulty: question.difficulty
          }))
        })
      });
      setStudyGuide(data.guide);
      setStudyGuideOpen(true);
    } catch (err) {
      setError(errorMessage(err, "专项学习内容生成失败，请重试。"));
    } finally {
      setLoading("");
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
      setStudyGuide(undefined);
      setStudyGuideOpen(false);
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
    setStudyGuide(undefined);
    setStudyGuideOpen(false);
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
      const data = await api<{ result: GradeResult; abilities: Ability[]; skillAbilities: SkillAbility[] }>("/api/grade", {
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
      setState((prev) => ({ ...prev, abilities: data.abilities, skillAbilities: data.skillAbilities ?? prev.skillAbilities }));
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
      setError(errorMessage(err, "批改失败，请检查 GLM 设置。"));
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
      setLoading(`AI 正在生成扩展题 1-${plan.length}/${plan.length}…`);
      const previousQuestions = questionQueue.map((item) => item.chinese);
      const data = await api<QuestionResponse>("/api/question", {
        method: "POST",
        body: JSON.stringify({
          mode: activeMode,
          questions: plan.map((item, offset) => ({
            dimension: item.dimension,
            difficulty: item.difficulty,
            batchIndex: questionQueue.length + offset + 1,
            batchTotal: questionQueue.length + plan.length
          })),
          previousQuestions,
          forceAi: true,
          thinking: true
        })
      });
      extensionQuestions.push(...(data.questions ?? (data.question ? [data.question] : [])));
      if (extensionQuestions.length < 1) {
        setError("扩展题生成失败，请稍后重试。");
        return;
      }
      setAssessmentExtension({ phase: "preview", plan, questions: extensionQuestions, notes: {} });
      setSessionStarted(false);
    } catch (err) {
      setError(errorMessage(err, "扩展题生成失败，请检查 GLM 设置。"));
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
        if (data.abilities || data.skillAbilities) {
          setState((prev) => ({
            ...prev,
            abilities: data.abilities || prev.abilities,
            skillAbilities: data.skillAbilities || prev.skillAbilities
          }));
        }
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

  function openCapture() {
    setCapture({
      open: true,
      sourceCn: "",
      loading: "",
      error: "",
      saved: false
    });
  }

  async function generateCaptureCard() {
    const sourceCn = capture.sourceCn.trim();
    if (!sourceCn) {
      setCapture((prev) => ({ ...prev, error: "请先输入中文个人场景" }));
      return;
    }
    setCapture((prev) => ({ ...prev, loading: "正在生成表达卡…", error: "", saved: false }));
    try {
      const data = await api<CaptureResponse>("/api/capture", {
        method: "POST",
        body: JSON.stringify({ action: "generate", source_cn: sourceCn })
      });
      setCapture((prev) => ({ ...prev, card: data.card, sourceCn: data.card.source_cn, loading: "", error: "", saved: false }));
    } catch (err) {
      setCapture((prev) => ({ ...prev, loading: "", error: errorMessage(err, "表达卡生成失败") }));
    }
  }

  async function saveCaptureCard() {
    if (!capture.card) return;
    setCapture((prev) => ({ ...prev, loading: "正在保存表达卡…", error: "" }));
    try {
      await api<CaptureResponse>("/api/capture", {
        method: "POST",
        body: JSON.stringify({ action: "save", card: capture.card })
      });
      await refresh();
      setCapture((prev) => ({ ...prev, loading: "", error: "", saved: true }));
    } catch (err) {
      setCapture((prev) => ({ ...prev, loading: "", error: errorMessage(err, "表达卡保存失败") }));
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
        setStudyGuide(undefined);
        setStudyGuideOpen(false);
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
        {state.user && (
          <div className="user-strip">
            <span>{state.user.username}</span>
            <div className="user-actions">
              {state.user.role === "admin" && <a href="/admin" aria-label="管理员"><Shield size={16} /></a>}
              <button type="button" onClick={logout} aria-label="退出登录"><LogOut size={16} /></button>
            </div>
          </div>
        )}
        <div className="streak">连续训练 {state.streak} 天</div>
        <div className="nav">
          {navItems.map((item) => (
            <button key={item.name} className={view === item.name && !assessment ? "active" : ""} onClick={() => { setAssessment(false); setView(item.name); }}>
              {item.icon}{item.name}
            </button>
          ))}
        </div>
        <SystemStatus status={llmStatus} settings={state.settings} onOpenSettings={() => { setAssessment(false); setView("设置"); }} />
      </aside>

      <main className="main">
        <button className="mobile-capture-entry" type="button" onClick={openCapture}>
          <span><MessageSquarePlus size={22} />快速捕捉表达</span>
          <small>先记下你的中文场景，生成可练习的英文表达卡</small>
        </button>

        {assessment && !activeTraining && !paperPreview && (
          <StartPage
            mode="能力测评"
            state={state}
            total={normalizedAssessmentOptions.initialCount}
            specialDimension={specialDimension}
            setSpecialDimension={setSpecialDimension}
            skillAbilities={state.skillAbilities}
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
            skillAbilities={state.skillAbilities}
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

        {paperPreview && visibleTrainingView && activeMode && studyGuideOpen && studyGuide && (
          <StudyGuidePage
            mode={activeMode}
            guide={studyGuide}
            loading={loading}
            error={error}
            onBack={() => setStudyGuideOpen(false)}
            onBegin={beginAnswering}
          />
        )}

        {paperPreview && visibleTrainingView && activeMode && (!studyGuideOpen || !studyGuide) && (
          <PaperPreview
            mode={activeMode}
            questions={questionQueue}
            notes={paperNotes}
            setNotes={setPaperNotes}
            loading={loading}
            error={error}
            onRegenerate={regenerateQuestion}
            onStudy={generatePaperStudyGuide}
            onBegin={beginAnswering}
            onAbandon={abandonPaper}
          />
        )}

        {activeTraining && visibleTrainingView && (
          <section className="training-stage">
            {activeQuestion && (
              <AbilityMotionField
                dimension={activeQuestion.dimension}
                progress={progress.current + 1}
                total={progress.total}
                verdict={activeResult?.verdict}
              />
            )}
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
                  const before = beforeScores.find((x) => x.dimension === item.dimension) ?? { dimension: item.dimension, score: 50, evidence_count: 0 };
                  return <p key={item.dimension}>{item.dimension}：{abilityScoreLabel(before)} → {abilityScoreLabel(item)} · {before.evidence_count} → {item.evidence_count} 条证据</p>;
                })}
              </div>
            )}

            {loading && <p className="loading"><span className="spinner" />{loading}</p>}
            {error && <div className="notice">{error}</div>}
            {activeQuestion && (
              <>
                <div className="question"><h2>{activeQuestion.chinese}</h2></div>
                <div className="question-meta">
                  <span>考查维度：{activeQuestion.dimension}</span>
                  {publicQuestionSkills(activeQuestion.skills).map((skill) => <span className="question-skill" key={skill}>{skill}</span>)}
                </div>
                {Boolean(activeQuestion.vocabulary_tips?.length) && (
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
                {activeMode !== "能力测评" && activeResult && <Feedback question={activeQuestion} userAnswer={activeRecord.answer} result={activeResult} />}
              </>
            )}
          </section>
        )}

        {view === "数据统计" && !assessment && (
          <Stats state={state} trend={trend} trendDimension={trendDimension} setTrendDimension={setTrendDimension} errorDistribution={errorDistribution} onPickDimension={(dimension) => { setSpecialDimension(dimension); setView("专项训练"); }} />
        )}

        {view === "设置" && !assessment && (
          <SettingsPanel draft={settingsDraft} setDraft={setSettingsDraft} refresh={refresh} setError={setError} error={error} isAdmin={state.user?.role === "admin"} />
        )}

        <button className="capture-fab" type="button" onClick={openCapture} aria-label="快速捕捉表达">
          <MessageSquarePlus size={22} />
        </button>
        {capture.open && (
          <QuickCaptureModal
            capture={capture}
            setCapture={setCapture}
            onGenerate={generateCaptureCard}
            onSave={saveCaptureCard}
          />
        )}
      </main>
    </div>
  );
}

function SystemStatus({ status, settings, onOpenSettings }: {
  status: LlmQueueSnapshot;
  settings: Settings;
  onOpenSettings: () => void;
}) {
  const personalReady = settings.hasPersonalApiKey;
  const statusText = personalReady
    ? "个人模型已启用"
    : status.runningCount > 0
      ? "处理中"
      : status.pendingCount > 0 ? "排队中" : "空闲";
  return (
    <div className="system-status">
      <strong>系统运行状态</strong>
      <div className="status-pill">{statusText}</div>
      <p>平台队列：{status.runningCount ? "处理中" : "空闲"} · 排队 {status.pendingCount}</p>
      <p>我的排位：{status.myPosition === 0 ? "正在处理" : status.myPosition ? `第 ${status.myPosition} 位` : "无排队任务"}</p>
      <p>独享模型：{personalReady ? "已启用" : "未启用"}</p>
      {!personalReady && status.pendingCount > 0 && (
        <button type="button" onClick={onOpenSettings}>配置 SiliconFlow 免平台排队</button>
      )}
    </div>
  );
}

function QuickCaptureModal({ capture, setCapture, onGenerate, onSave }: {
  capture: CaptureState;
  setCapture: Dispatch<SetStateAction<CaptureState>>;
  onGenerate: () => void;
  onSave: () => void;
}) {
  const busy = Boolean(capture.loading);
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => setCapture((prev) => ({ ...prev, open: false }))}>
      <section className="modal capture-modal" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title" onClick={(event) => event.stopPropagation()}>
        <div className="topbar">
          <div>
            <h2 id="quick-capture-title">快速捕捉表达</h2>
            <p className="muted">输入一个中文个人场景，先生成预览，再保存到你的练习卡池。</p>
          </div>
          <button aria-label="关闭快速捕捉" onClick={() => setCapture((prev) => ({ ...prev, open: false }))}><X size={16} /></button>
        </div>
        <textarea
          className="capture-input"
          value={capture.sourceCn}
          onChange={(event) => setCapture((prev) => ({ ...prev, sourceCn: event.target.value, saved: false }))}
          placeholder="例如：我想跟同事说，我今天可能要晚一点交报告，因为上午一直在开会。"
          disabled={busy}
        />
        <div className="actions">
          <button onClick={onGenerate} disabled={busy || !capture.sourceCn.trim()}>
            <RotateCcw size={16} /> {capture.card ? "重新生成" : "生成预览"}
          </button>
          <button className="primary" onClick={onSave} disabled={busy || !capture.card || capture.saved}>
            {capture.saved ? "已保存" : "保存到练习"}
          </button>
        </div>
        {capture.loading && <p className="loading"><span className="spinner" />{capture.loading}</p>}
        {capture.error && <div className="notice">{capture.error}</div>}
        {capture.saved && <div className="notice">表达卡已保存，会出现在每日练习中。</div>}
        {capture.card && (
          <div className="capture-preview">
            <div className="capture-expression">
              <span>Casual</span>
              <p>{capture.card.casual}</p>
            </div>
            <div className="capture-expression standard">
              <span>Standard</span>
              <p>{capture.card.standard}</p>
            </div>
            <div className="capture-expression">
              <span>Vivid</span>
              <p>{capture.card.vivid}</p>
            </div>
            <div className="capture-meta-grid">
              <div>
                <strong>语法维度</strong>
                <p>{capture.card.grammar_dimension}</p>
              </div>
              <div>
                <strong>常见错误</strong>
                <p>{capture.card.common_mistake}</p>
              </div>
              <div>
                <strong>记忆钩子</strong>
                <p>{capture.card.memory_hook}</p>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function StartPage({ mode, state, total, specialDimension, setSpecialDimension, skillAbilities, assessmentOptions, setAssessmentOptions, loading, error, onGenerate, onSkipAssessment }: {
  mode: TrainingMode;
  state: AppState;
  total: number;
  specialDimension: Dimension;
  setSpecialDimension: (value: Dimension) => void;
  skillAbilities: SkillAbility[];
  assessmentOptions: AssessmentOptions;
  setAssessmentOptions: Dispatch<SetStateAction<AssessmentOptions>>;
  loading: string;
  error: string;
  onGenerate: () => void;
  onSkipAssessment?: () => void;
}) {
  const activeMistakes = state.mistakes.filter((item) => item.correct_streak < 2).length;
  const weakSpecialSkills = weakSkillsForDimension(skillAbilities, specialDimension);
  const disabled = Boolean(loading) || (mode === "错题重练" && total < 1);
  const normalizedAssessmentOptions = normalizeAssessmentOptions(assessmentOptions);
  const description = mode === "能力测评"
    ? assessmentOptions.autoExtend
      ? `开始后会先生成 ${normalizedAssessmentOptions.initialCount} 道测评题；系统会根据薄弱和不确定维度最多追加到 ${normalizedAssessmentOptions.maxCount} 题，结束后统一生成能力报告。`
      : `开始后只生成 ${normalizedAssessmentOptions.initialCount} 道测评题，不自动追加题目，结束后统一生成能力报告。`
    : mode === "每日练习"
      ? `开始后会生成 ${total} 道题，优先加入 ${state.activeCapturedDrillCount} 张快速捕捉卡，再根据当前能力选择薄弱维度。`
      : mode === "专项训练"
        ? `开始后会生成 ${total} 道 ${specialDimension} 题，集中训练单一语法维度。`
        : activeMistakes > 0
          ? `开始后会生成 ${total} 道错题重练，答对两次的错题会从重练列表移除。`
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

      {mode === "专项训练" && (
        <section className="section weak-skill-panel">
          <h2>{specialDimension}薄弱技能</h2>
          {weakSpecialSkills.length === 0 && <p className="muted">当前没有足够的二级技能证据，系统会先按一级维度生成题目。</p>}
          {weakSpecialSkills.length > 0 && (
            <div className="skill-list">
              {weakSpecialSkills.map((item) => (
                <span className="skill-pill weak" key={`${item.dimension}-${item.skill}`}>
                  {item.skill} <strong>{formatAbilityScore(item.score)}</strong> <em>证据 {item.evidence_count}</em>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="section radar-wrap">
        <Radar abilities={state.abilities} />
        <div className="bars">
          <h2>当前能力预览</h2>
          {state.abilities.map((item) => (
            <div className="ability-stat" key={item.dimension}>
              <div className={`bar-row${item.evidence_count === 0 ? " no-evidence" : ""}`}>
                <span>{item.dimension}</span><div className="bar"><span style={{ width: `${item.score}%` }} /></div><strong>{abilityScoreLabel(item)}</strong><em>{abilityEvidenceLabel(item)}</em>
              </div>
              <div className="skill-list compact">
                {weakSkillsForDimension(state.skillAbilities, item.dimension, 3).map((skill) => (
                  <span className="skill-pill weak" key={`${skill.dimension}-${skill.skill}`}>
                    {skill.skill} <strong>{formatAbilityScore(skill.score)}</strong> <em>证据 {skill.evidence_count}</em>
                  </span>
                ))}
              </div>
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

function PaperPreview({ mode, questions, notes, setNotes, loading, error, onRegenerate, onStudy, onBegin, onAbandon }: {
  mode: TrainingMode;
  questions: Question[];
  notes: Record<number, PaperNote>;
  setNotes: Dispatch<SetStateAction<Record<number, PaperNote>>>;
  loading: string;
  error: string;
  onRegenerate: (index: number) => void;
  onStudy: () => void;
  onBegin: () => void;
  onAbandon: () => void;
}) {
  const canStudy = mode === "每日练习";
  return (
    <section>
      <div className="topbar">
        <div>
          <h1 className="title">{mode} · 试卷预览</h1>
          <p className="muted">共 {questions.length} 题。可以为单题填写调整原因并重新生成，确认后再开始答题。</p>
        </div>
        <div className="row">
          {canStudy && <button onClick={onStudy} disabled={Boolean(loading)}><GraduationCap size={16} /> 专项学习</button>}
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

function StudyGuidePage({ mode, guide, loading, error, onBack, onBegin }: {
  mode: TrainingMode;
  guide: StudyGuide;
  loading: string;
  error: string;
  onBack: () => void;
  onBegin: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleDrillAnswers, setVisibleDrillAnswers] = useState<Record<string, boolean>>({});
  const activeSection = guide.sections[activeIndex] ?? guide.sections[0];
  return (
    <section className="study-page">
      <div className="topbar">
        <div>
          <h1 className="title">{mode} · 做题前专项学习</h1>
          <p className="muted">{guide.overview}</p>
        </div>
        <div className="row">
          <button onClick={onBack}>返回试卷</button>
          <button className="primary" onClick={onBegin} disabled={Boolean(loading)}>开始答题</button>
        </div>
      </div>
      {loading && <p className="loading"><span className="spinner" />{loading}</p>}
      {error && <div className="notice">{error}</div>}
      <div className="study-layout">
        <aside className="study-nav" aria-label="专项学习目录">
          <strong>学习目录</strong>
          {guide.sections.map((section, index) => (
            <button key={`${section.title}-${index}`} className={index === activeIndex ? "active" : ""} onClick={() => setActiveIndex(index)}>
              <span>{index + 1}</span>
              {section.title}
            </button>
          ))}
          <div className="study-note">不展示原题和答案</div>
        </aside>

        <div className="study-main">
          {activeSection && (
            <article className="study-lesson">
              <div className="study-lesson-head">
                <span className="tag">专题 {activeIndex + 1}</span>
                <h2>{activeSection.title}</h2>
                <p>{activeSection.why_it_matters}</p>
              </div>
              <section>
                <h3>深入讲解</h3>
                <p>{activeSection.explanation}</p>
              </section>
              <section>
                <h3>核心规则</h3>
                <ul>{activeSection.key_points.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
              <section>
                <h3>句型模板</h3>
                <ul>{activeSection.patterns.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
              <section>
                <h3>对比辨析</h3>
                <ul>{activeSection.contrast.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
              <section>
                <h3>同类例句</h3>
                {activeSection.examples.map((example, index) => <p className="example-line" key={index}>{example}</p>)}
              </section>
              <section>
                <h3>易错点</h3>
                <ul>{activeSection.pitfalls.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </section>
              <section>
                <h3>练习句</h3>
                <div className="drill-list">
                  {activeSection.drills.map((item, index) => {
                    const key = `${activeIndex}-${index}`;
                    const visible = Boolean(visibleDrillAnswers[key]);
                    return (
                      <div className="drill-item" key={key}>
                        <p>{item.prompt}</p>
                        <button onClick={() => setVisibleDrillAnswers((prev) => ({ ...prev, [key]: !prev[key] }))}>
                          {visible ? "隐藏答案" : "显示答案"}
                        </button>
                        {visible && (
                          <div className="drill-answer">
                            <strong>{item.answer}</strong>
                            {item.explanation && <p>{item.explanation}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </article>
          )}
          <aside className="study-checklist">
            <strong>答题前检查</strong>
            <ul>{guide.checklist.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </aside>
        </div>
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
          <p className="muted">系统已完成基础题组批改。下面这些维度仍缺少稳定判断依据，确认后会生成 {plan.length} 道扩展题。</p>
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
  const weakSkills = state.skillAbilities
    .filter((item) => item.evidence_count > 0)
    .sort((a, b) => a.score - b.score || b.evidence_count - a.evidence_count)
    .slice(0, 12);
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
            <div className="ability-stat" key={item.dimension}>
              <div className={`bar-row${item.evidence_count === 0 ? " no-evidence" : ""}`}>
                <span>{item.dimension}</span><div className="bar"><span style={{ width: `${item.score}%` }} /></div><strong>{abilityScoreLabel(item)}</strong><em>{abilityEvidenceLabel(item)}</em>
              </div>
              <div className="skill-list compact">
                {weakSkillsForDimension(state.skillAbilities, item.dimension, 3).map((skill) => (
                  <button className="skill-pill weak" key={`${skill.dimension}-${skill.skill}`} onClick={() => onPickDimension(item.dimension)}>
                    {skill.skill} <strong>{formatAbilityScore(skill.score)}</strong> <em>证据 {skill.evidence_count}</em>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="grid">
        <section className="section">
          <h2>最近每日练习报告</h2>
          {!state.latestPracticeReport && <p className="muted">完成一次每日练习后会生成客观报告。</p>}
          {state.latestPracticeReport && <PracticeReportView report={state.latestPracticeReport} />}
        </section>
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
        <section className="section">
          <h2>二级技能诊断</h2>
          {weakSkills.length === 0 && <p className="muted">暂无二级技能证据。完成一次新批改或打开状态接口后，系统会从历史答题记录中回填。</p>}
          {weakSkills.length > 0 && (
            <div className="skill-diagnosis-list">
              {weakSkills.map((item) => (
                <button className="skill-diagnosis-item" key={`${item.dimension}-${item.skill}`} onClick={() => onPickDimension(item.dimension)}>
                  <span>{item.dimension}</span>
                  <strong>{item.skill}</strong>
                  <em>{formatAbilityScore(item.score)} / 证据 {item.evidence_count}</em>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="section">
        <h2>训练记录</h2>
        <table className="table"><thead><tr><th>日期</th><th>模式</th><th>题数</th><th>正确率</th></tr></thead><tbody>{state.records.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.mode}</td><td>{r.total}</td><td>{r.accuracy}%</td></tr>)}</tbody></table>
      </section>
    </>
  );
}

function PracticeReportView({ report }: { report: PracticeReport }) {
  return (
    <div className="practice-report">
      <p className="muted">{new Date(report.date).toLocaleString()} · Session #{report.session_id}</p>
      <div className="report-metrics">
        <div><span>题数</span><strong>{report.total}</strong></div>
        <div><span>正确率</span><strong>{report.accuracy}%</strong></div>
        <div><span>客观均分</span><strong>{report.average_score}</strong></div>
        <div><span>平均用时</span><strong>{report.average_duration_seconds}s</strong></div>
      </div>
      <div className="verdict-stack">
        <span className="verdict-chip correct">正确 {report.correct}</span>
        <span className="verdict-chip partial">基本正确 {report.partial}</span>
        <span className="verdict-chip wrong">错误 {report.wrong}</span>
      </div>
      <strong>维度表现</strong>
      <div className="dimension-report-list">
        {report.dimension_reports.map((item) => (
          <div className="dimension-report-item" key={item.dimension}>
            <div className="row"><strong>{item.dimension}</strong><span>{item.average_score} / {item.accuracy}%</span></div>
            <p className="muted">{item.correct} 正确 · {item.partial} 基本正确 · {item.wrong} 错误 · 证据 {item.evidence_count}</p>
            {item.notes[0] && <p>{item.notes[0]}</p>}
          </div>
        ))}
      </div>
      <strong>优势</strong>
      {report.strengths.map((item, index) => <p key={`practice-strength-${index}`}>{index + 1}. {item}</p>)}
      <strong>待改进</strong>
      {report.weaknesses.map((item, index) => <p key={`practice-weak-${index}`}>{index + 1}. {item}</p>)}
      <strong>建议</strong>
      {report.recommendations.map((item, index) => <p key={`practice-rec-${index}`}>{index + 1}. {item}</p>)}
    </div>
  );
}

function SettingsPanel({ draft, setDraft, refresh, setError, error, isAdmin }: {
  draft: SettingsDraft;
  setDraft: (value: SettingsDraft) => void;
  refresh: () => Promise<void>;
  setError: (value: string) => void;
  error: string;
  isAdmin: boolean;
}) {
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<{ target: SettingsTestTarget; result: ConnectionTestResult } | null>(null);
  const [showPersonalGuide, setShowPersonalGuide] = useState(false);
  const canTestPersonalModel = Boolean(draft.hasPersonalApiKey || draft.personalApiKey?.trim());
  const renderConnectionTestResult = (target: SettingsTestTarget) => testResult?.target === target && (
    <div className="connection-test-list">
      {testResult.result.tests.map((item) => (
        <div key={item.key} className={item.ok ? "connection-test-item ok" : "connection-test-item failed"}>
          {item.ok ? <CheckCircle2 size={17} /> : <X size={17} />}
          <div>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
  async function save() {
    setTestResult(null);
    const personalKeyChanged = Boolean(draft.personalApiKey?.trim());
    setMessage(personalKeyChanged ? "正在验证个人 API Key…" : "正在保存设置…");
    try {
      const saved = await api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(draft) });
      setMessage(personalKeyChanged ? "API Key 验证通过，独享模型已启用" : "设置已保存");
      setDraft({ ...saved, personalApiKey: "", clearPersonalApiKey: false });
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存设置失败");
    }
  }
  async function test(target: SettingsTestTarget) {
    setMessage(target === "personal" ? "正在验证独享模型…" : "正在测试免费模型…");
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, target })
      });
      const data = await res.json().catch(() => ({})) as ConnectionTestResponse;
      const result = res.ok ? data : data.result;
      if (result) setTestResult({ target, result });
      if (!res.ok) throw new Error(data.message || "连接失败");
      setMessage(target === "personal" ? "独享模型验证成功，所有测试项已通过" : "免费模型连接成功，所有测试项已通过");
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
        {isAdmin && (
          <>
            <label>GLM API 地址<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
            <label>模型名称<input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="glm-4.7-flash" /></label>
            <label>Temperature<input type="number" min="0" max="1" step="0.1" value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} /></label>
          </>
        )}
        <label>每日练习题数<input type="number" min="10" max="50" value={draft.dailyCount} onChange={(e) => setDraft({ ...draft, dailyCount: Number(e.target.value) })} /></label>
        {isAdmin && (
          <label>应用并发生成数<input type="number" min="1" max={draft.hasPersonalApiKey || draft.personalApiKey?.trim() ? "20" : "1"} value={draft.hasPersonalApiKey || draft.personalApiKey?.trim() ? draft.maxConcurrentPredictions : 1} disabled={!draft.hasPersonalApiKey && !draft.personalApiKey?.trim()} onChange={(e) => setDraft({ ...draft, maxConcurrentPredictions: Number(e.target.value) })} /><span className="field-hint">{draft.hasPersonalApiKey || draft.personalApiKey?.trim() ? "独享模型启用后支持并发生成，范围 1-20，默认 20。" : "GLM-4.7-Flash 免费模型并发限制为 1；启用独享模型后可调整到 20。"}</span></label>
        )}
      </div>
      <div className="section personal-model-section">
        <div className="section-heading">
          <div>
            <h2>独享模型</h2>
            <p className="muted">填写 SiliconFlow API Key 并验证通过后自动启用；清除 Key 后自动关闭。</p>
          </div>
          <div className="status-pill">{draft.hasPersonalApiKey ? "已启用" : draft.personalApiKey?.trim() ? "待验证" : "未启用"}</div>
        </div>
        <div className="form-grid">
          <label>SiliconFlow API 地址<input value={draft.personalBaseUrl} onChange={(e) => setDraft({ ...draft, personalBaseUrl: e.target.value })} placeholder="https://api.siliconflow.cn/v1" /></label>
          <label>模型名称<input value={draft.personalModel} onChange={(e) => setDraft({ ...draft, personalModel: e.target.value })} placeholder="deepseek-ai/DeepSeek-V4-Flash" /></label>
          <label>
            API Key
            <input
              type="password"
              value={draft.personalApiKey || ""}
              onChange={(e) => setDraft({ ...draft, personalApiKey: e.target.value, clearPersonalApiKey: false })}
              placeholder={draft.hasPersonalApiKey ? "已保存，输入新 Key 可替换" : "粘贴 SiliconFlow API Key"}
            />
            <span className="field-hint">保存时会先验证，验证通过后服务器加密保存个人 Key</span>
          </label>
        </div>
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="primary" onClick={() => test("personal")} disabled={!canTestPersonalModel}>验证独享模型</button>
          <button type="button" onClick={() => setShowPersonalGuide((value) => !value)}>{showPersonalGuide ? "收起教程" : "查看 SiliconFlow 教程"}</button>
          {draft.hasPersonalApiKey && <button type="button" onClick={() => setDraft({ ...draft, personalProviderEnabled: false, personalApiKey: "", clearPersonalApiKey: true, hasPersonalApiKey: false })}>清除个人 Key</button>}
        </div>
        {renderConnectionTestResult("personal")}
        {showPersonalGuide && (
          <div className="personal-guide">
            <p>注册链接：<a href="https://cloud.siliconflow.cn/i/x77lxErl" target="_blank" rel="noreferrer">https://cloud.siliconflow.cn/i/x77lxErl</a></p>
            <ol>
              <li>注册或登录 SiliconFlow。</li>
              <li>领取免费可用额度。</li>
              <li>创建 API Key。</li>
              <li>粘贴到这里并保存，验证通过后会自动启用。</li>
            </ol>
          </div>
        )}
      </div>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button className="primary" onClick={save}>保存设置</button>
        {isAdmin && <button onClick={() => test("global")}>测试免费模型</button>}
        <button onClick={() => reset("assessment")}>重置能力评估</button>
        <button className="danger" onClick={() => reset("all")}>清除所有数据</button>
      </div>
      {(message || error) && <div className="notice">{message || error}</div>}
      {renderConnectionTestResult("global")}
    </section>
  );
}
