"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, BookOpenCheck, ClipboardList, Dumbbell, RotateCcw, Settings as SettingsIcon, Target } from "lucide-react";
import { Ability, AbilityHistory, DIMENSIONS, Dimension, GradeResult, Mistake, Question, Settings, TrainingRecord } from "@/lib/types";

type View = "每日练习" | "专项训练" | "错题重练" | "数据统计" | "设置";
type AppState = {
  settings: Settings;
  abilities: Ability[];
  history: AbilityHistory[];
  mistakes: Mistake[];
  records: TrainingRecord[];
  streak: number;
  needsAssessment: boolean;
};

const emptyState: AppState = {
  settings: { baseUrl: "http://localhost:1234", model: "", temperature: 0.3, dailyCount: 20 },
  abilities: DIMENSIONS.map((dimension) => ({ dimension, score: 0 })),
  history: [],
  mistakes: [],
  records: [],
  streak: 0,
  needsAssessment: true
};

const navItems: Array<{ name: View; icon: React.ReactNode }> = [
  { name: "每日练习", icon: <BookOpenCheck size={18} /> },
  { name: "专项训练", icon: <Target size={18} /> },
  { name: "错题重练", icon: <RotateCcw size={18} /> },
  { name: "数据统计", icon: <BarChart3 size={18} /> },
  { name: "设置", icon: <SettingsIcon size={18} /> }
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data as T;
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

function verdictText(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return "✅ 正确";
  if (verdict === "partial") return "⚠️ 基本正确";
  return "❌ 错误";
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
  const [question, setQuestion] = useState<Question>();
  const [sessionStarted, setSessionStarted] = useState(false);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<GradeResult>();
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 20 });
  const [beforeScores, setBeforeScores] = useState<Ability[]>(emptyState.abilities);
  const [showDelta, setShowDelta] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(emptyState.settings);
  const [trendDimension, setTrendDimension] = useState<Dimension>("时态");

  const refresh = useCallback(async () => {
    const next = await api<AppState>("/api/state");
    setState(next);
    setSettingsDraft(next.settings);
    setBeforeScores(next.abilities);
    if (next.needsAssessment) setAssessment(true);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [refresh]);

  const mode = assessment ? "能力测评" : view;
  const currentDimension = assessment ? DIMENSIONS[Math.floor(progress.current / 4)] : specialDimension;
  const total = assessment ? 24 : view === "每日练习" ? state.settings.dailyCount : view === "错题重练" ? Math.max(1, state.mistakes.filter((x) => x.correct_streak < 2).length) : 20;

  async function startSession(nextView = view) {
    try {
      setError("");
      setResult(undefined);
      setAnswer("");
      setQuestion(undefined);
      setSessionStarted(true);
      const nextTotal = assessment ? 24 : nextView === "每日练习" ? state.settings.dailyCount : nextView === "错题重练" ? Math.max(1, state.mistakes.length) : 20;
      const session = await api<{ id: number }>("/api/session", {
        method: "POST",
        body: JSON.stringify({ mode: assessment ? "能力测评" : nextView, total: nextTotal })
      });
      setSessionId(session.id);
      setProgress({ current: 0, total: nextTotal });
      setBeforeScores(state.abilities);
      await loadQuestion(assessment ? "能力测评" : nextView, 0);
    } catch (err) {
      setSessionStarted(false);
      setError(errorMessage(err, "训练启动失败，请检查 LM Studio 设置后重试。"));
    }
  }

  async function loadQuestion(nextMode = mode, current = progress.current) {
    setLoading("AI 正在生成题目…");
    setError("");
    setResult(undefined);
    setAnswer("");
    try {
      const dimension = nextMode === "能力测评" ? DIMENSIONS[Math.floor(current / 4)] : nextMode === "专项训练" ? specialDimension : undefined;
      const difficulty = nextMode === "能力测评" ? 20 + (current % 4) * 20 : undefined;
      const data = await api<{ question?: Question; done?: boolean }>("/api/question", {
        method: "POST",
        body: JSON.stringify({ mode: nextMode, dimension, difficulty })
      });
      if (data.done) {
        setQuestion(undefined);
        setError("当前没有需要重练的错题。");
      } else {
        setQuestion(data.question);
      }
    } catch (err) {
      setError(errorMessage(err, "题目生成失败，请检查 LM Studio 设置。"));
    } finally {
      setLoading("");
    }
  }

  async function submit() {
    if (!question || !answer.trim() || result) return;
    setLoading("AI 正在批改中…");
    setError("");
    try {
      const data = await api<{ result: GradeResult; abilities: Ability[] }>("/api/grade", {
        method: "POST",
        body: JSON.stringify({ question, answer, sessionId })
      });
      setResult(data.result);
      setState((prev) => ({ ...prev, abilities: data.abilities }));
    } catch (err) {
      setError(errorMessage(err, "批改失败，请检查 LM Studio 设置。"));
    } finally {
      setLoading("");
    }
  }

  async function nextQuestion() {
    try {
      if (progress.current + 1 >= total) {
        if (sessionId) await api("/api/session", { method: "POST", body: JSON.stringify({ action: "end", sessionId }) });
        setAssessment(false);
        setSessionStarted(false);
        setSessionId(undefined);
        setQuestion(undefined);
        setResult(undefined);
        await refresh();
        setView("数据统计");
        return;
      }
      const next = progress.current + 1;
      setProgress({ current: next, total });
      await loadQuestion(mode, next);
    } catch (err) {
      setError(errorMessage(err, "进入下一题失败，请重试。"));
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (!event.ctrlKey && event.key === "Enter" && result) {
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
        {assessment && !sessionStarted && (
          <section>
            <h1 className="title">能力测评</h1>
            <p className="muted">首次使用建议完成 24 题测评，覆盖 6 个语法维度。也可以跳过，之后能力图谱会从训练中逐步生成。</p>
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button className="primary" onClick={() => startSession("每日练习")}><ClipboardList size={16} /> 开始测评</button>
              <button onClick={() => setAssessment(false)}>跳过测评</button>
            </div>
            {error && <div className="notice">{error}</div>}
          </section>
        )}

        {(question || loading || sessionStarted || (view !== "数据统计" && view !== "设置" && !assessment)) && (
          <section style={{ position: "relative" }}>
            <div className="topbar">
              <div>
                <h1 className="title">{assessment ? `${currentDimension} ${progress.current % 4 + 1}/4` : view}</h1>
                <div className="muted">{assessment ? "能力测评" : `本次训练进度 ${Math.min(progress.current + 1, total)}/${total}`}</div>
              </div>
              <div className="row">
                {view === "专项训练" && !assessment && (
                  <select value={specialDimension} onChange={(event) => setSpecialDimension(event.target.value as Dimension)}>
                    {DIMENSIONS.map((dimension) => <option key={dimension}>{dimension}</option>)}
                  </select>
                )}
                <button onClick={() => startSession(view)} className="primary"><Dumbbell size={16} /> 开始</button>
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
            {question && (
              <>
                <div className="question"><h2>{question.chinese}</h2></div>
                <p className="muted">考查维度：{question.dimension}</p>
                <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} readOnly={Boolean(result)} placeholder="请输入你的英文翻译…" />
                <div className="actions">
                  {!result ? <button className="primary" onClick={submit} disabled={Boolean(loading) || !answer.trim()}>提交</button> : <button className="primary" onClick={nextQuestion}>下一题</button>}
                </div>
                {result && <p className="muted">语法点说明：{question.grammar_focus}</p>}
                {result && <Feedback result={result} />}
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
      </main>
    </div>
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
