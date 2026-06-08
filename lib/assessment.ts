import { Ability, AssessmentMatrixItem, DIMENSIONS, Dimension, DimensionScore, GradeResult, PracticeReport, Question, QuestionAnswerRecord, SkillAbility } from "./types";

function fallbackScore(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return 100;
  if (verdict === "partial") return 40;
  return 20;
}

function reportFallbackScore(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return 92;
  if (verdict === "partial") return 65;
  return 25;
}

function calibrateReportScore(score: number, verdict: GradeResult["verdict"] | DimensionScore["verdict"]) {
  const normalized = Math.max(0, Math.min(100, Number(score) || 0));
  if (verdict === "correct") return Math.max(80, normalized);
  if (verdict === "partial") return Math.min(79, Math.max(45, normalized));
  return Math.min(44, normalized);
}

function normalizeSkillLabel(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[，。；、,.!?！？：:]+$/g, "")
    .trim()
    .slice(0, 32);
}

export function normalizeSkillLabels(values: unknown[], fallback = "") {
  const normalized = values
    .map((item) => typeof item === "string" ? normalizeSkillLabel(item) : "")
    .filter((item) => item.length >= 2);
  if (!normalized.length && fallback) {
    const fallbackLabel = normalizeSkillLabel(fallback);
    if (fallbackLabel.length >= 2) normalized.push(fallbackLabel);
  }
  return [...new Set(normalized)].slice(0, 8);
}

function evidenceFor(record: QuestionAnswerRecord) {
  const fromResult = record.result.dimension_scores?.length
    ? record.result.dimension_scores.map((item) => ({
        dimension: item.dimension,
        score: item.score,
        weight: item.dimension === record.question.dimension ? 1 : 0.55,
        note: item.notes
      }))
    : [];
  if (fromResult.length) return fromResult;
  const secondary = record.question.secondary_dimensions ?? [];
  return [
    { dimension: record.question.dimension, score: fallbackScore(record.result.verdict), weight: 1, note: record.result.explanations[0] ?? "" },
    ...secondary.map((dimension) => ({ dimension, score: fallbackScore(record.result.verdict), weight: 0.45, note: "" }))
  ];
}

function primaryReportScore(record: QuestionAnswerRecord) {
  const explicit = record.result.dimension_scores?.find((item) => item.dimension === record.question.dimension);
  if (explicit) return calibrateReportScore(explicit.score, explicit.verdict);
  return reportFallbackScore(record.result.verdict);
}

export function calculateAssessmentMatrix(records: QuestionAnswerRecord[]): AssessmentMatrixItem[] {
  return DIMENSIONS.map((dimension) => {
    let weighted = 0;
    let totalWeight = 0;
    let evidenceCount = 0;
    for (const record of records) {
      for (const item of evidenceFor(record)) {
        if (item.dimension !== dimension) continue;
        weighted += item.score * item.weight;
        totalWeight += item.weight;
        evidenceCount += 1;
      }
    }
    const score = totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
    const confidence = Math.round(Math.min(1, totalWeight / 4) * 100) / 100;
    return { dimension, score, confidence, evidence_count: evidenceCount };
  });
}

export function calculatePracticeReport(records: QuestionAnswerRecord[]): PracticeReport | null {
  if (records.length < 1) return null;
  const sorted = [...records].sort((a, b) => a.question_index - b.question_index || a.id - b.id);
  const first = sorted[0];
  const verdictCounts = sorted.reduce((counts, record) => {
    counts[record.result.verdict] += 1;
    return counts;
  }, { correct: 0, partial: 0, wrong: 0 });
  const totalScore = sorted.reduce((sum, record) => sum + primaryReportScore(record), 0);
  const averageDuration = sorted.reduce((sum, record) => sum + Math.max(0, Number(record.duration_seconds) || 0), 0) / sorted.length;
  const errorCounts = new Map<string, number>();
  const skillCounts = new Map<string, number>();
  sorted.forEach((record) => {
    record.result.error_types.forEach((item) => errorCounts.set(item, (errorCounts.get(item) ?? 0) + 1));
    (record.result.skill_findings ?? []).forEach((item) => skillCounts.set(item, (skillCounts.get(item) ?? 0) + 1));
  });

  const dimensionReports = DIMENSIONS.map((dimension) => {
    const dimensionRecords = sorted.filter((record) => record.question.dimension === dimension);
    if (dimensionRecords.length < 1) return null;
    const counts = dimensionRecords.reduce((acc, record) => {
      acc[record.result.verdict] += 1;
      return acc;
    }, { correct: 0, partial: 0, wrong: 0 });
    const score = dimensionRecords.reduce((sum, record) => sum + primaryReportScore(record), 0) / dimensionRecords.length;
    const notes = dimensionRecords
      .flatMap((record) => [
        ...(record.result.skill_findings ?? []),
        ...record.result.explanations,
        ...record.result.differences
      ])
      .map((item) => compactText(item, 80))
      .filter(Boolean);
    return {
      dimension,
      total: dimensionRecords.length,
      correct: counts.correct,
      partial: counts.partial,
      wrong: counts.wrong,
      accuracy: Math.round((counts.correct / dimensionRecords.length) * 100),
      average_score: Math.round(score),
      evidence_count: dimensionRecords.length,
      notes: [...new Set(notes)].slice(0, 3)
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));

  const strengths = dimensionReports
    .filter((item) => item.average_score >= 80 || (item.accuracy >= 70 && item.total >= 2))
    .sort((a, b) => b.average_score - a.average_score)
    .slice(0, 3)
    .map((item) => `${item.dimension}：本次均分 ${item.average_score}，正确率 ${item.accuracy}%`);
  const weaknesses = dimensionReports
    .filter((item) => item.average_score < 70 || item.wrong > 0)
    .sort((a, b) => a.average_score - b.average_score || b.wrong - a.wrong)
    .slice(0, 4)
    .map((item) => `${item.dimension}：${item.correct}/${item.total} 正确，均分 ${item.average_score}${item.notes[0] ? `；${item.notes[0]}` : ""}`);
  const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const recommendations = [
    ...dimensionReports
      .filter((item) => item.average_score < 70 || item.partial + item.wrong > 0)
      .sort((a, b) => a.average_score - b.average_score)
      .slice(0, 2)
      .map((item) => `优先复盘 ${item.dimension}，从本次 ${item.partial + item.wrong} 道非完全正确题开始重写。`),
    ...topSkills.map(([skill, count]) => `针对“${skill}”做 ${Math.max(3, count * 2)} 句专项替换练习。`),
    topErrors.length ? `常见错误集中在：${topErrors.map(([type, count]) => `${type} ${count} 次`).join("、")}。` : ""
  ].filter(Boolean).slice(0, 5);

  return {
    session_id: first.session_id,
    date: first.created_at,
    mode: first.mode,
    total: sorted.length,
    correct: verdictCounts.correct,
    partial: verdictCounts.partial,
    wrong: verdictCounts.wrong,
    accuracy: Math.round((verdictCounts.correct / sorted.length) * 100),
    average_score: Math.round(totalScore / sorted.length),
    average_duration_seconds: Math.round(averageDuration),
    dimension_reports: dimensionReports,
    strengths: strengths.length ? strengths : ["本次练习已形成可复盘证据，继续积累后判断会更稳定。"],
    weaknesses: weaknesses.length ? weaknesses : ["本次没有明显薄弱维度。"],
    recommendations: recommendations.length ? recommendations : ["保持当前节奏，下一次练习可提高题目难度或增加专项训练。"]
  };
}

export function mergeAssessmentScore(current: number, assessed: number, confidence: number, initializing: boolean) {
  if (initializing) return assessed;
  const assessmentWeight = Math.min(0.8, 0.35 + confidence * 0.45);
  return Math.round(current * (1 - assessmentWeight) + assessed * assessmentWeight);
}

function clampScore(score: number) {
  return Number(Math.max(0, Math.min(100, score)).toFixed(2));
}

function verdictForScore(score: number): DimensionScore["verdict"] {
  if (score >= 80) return "correct";
  if (score >= 45) return "partial";
  return "wrong";
}

function severityWeight(severity: DimensionScore["severity"]) {
  if (severity === "major") return 1.15;
  if (severity === "minor") return 1;
  return 0.9;
}

function abilityEvidence(question: Question, result: GradeResult) {
  if (result.dimension_scores?.length) {
    return result.dimension_scores.map((item) => ({
      dimension: item.dimension,
      score: item.score,
      verdict: item.verdict,
      severity: item.severity,
      weight: item.dimension === question.dimension ? 1 : 0.55
    }));
  }
  const score = fallbackScore(result.verdict);
  const secondary = question.secondary_dimensions ?? [];
  return [
    { dimension: question.dimension, score, verdict: result.verdict, severity: "minor" as const, weight: 1 },
    ...secondary.map((dimension) => ({ dimension, score, verdict: result.verdict, severity: "minor" as const, weight: 0.45 }))
  ];
}

function scoreForDimension(question: Question, result: GradeResult, dimension: Dimension) {
  const explicit = result.dimension_scores?.find((item) => item.dimension === dimension);
  if (explicit) return {
    score: explicit.score,
    verdict: explicit.verdict,
    severity: explicit.severity
  };
  return {
    score: fallbackScore(result.verdict),
    verdict: result.verdict,
    severity: result.verdict === "correct" ? "none" as const : result.verdict === "partial" ? "minor" as const : "major" as const
  };
}

function calibratedTarget(score: number, difficulty: number) {
  return Math.max(0, Math.min(100, difficulty + (score - 50) * 0.9));
}

export function calculatePracticeAbilityUpdates(
  abilities: Ability[],
  question: Question,
  result: GradeResult,
  mode = "每日练习"
): Ability[] {
  const currentByDimension = new Map<Dimension, Ability>(abilities.map((item) => [item.dimension, item]));
  const updates = new Map<Dimension, Ability>();
  const difficulty = Math.max(1, Math.min(100, Number(question.difficulty) || 50));
  const difficultyInformation = 0.75 + difficulty / 200;
  const modeWeight = mode === "错题重练" || question.source === "mistake" ? 0.75 : 1;

  for (const item of abilityEvidence(question, result)) {
    const current = updates.get(item.dimension) ?? currentByDimension.get(item.dimension) ?? {
      dimension: item.dimension,
      score: 50,
      evidence_count: 0
    };
    const score = clampScore(item.score);
    const verdict = item.verdict ?? verdictForScore(score);
    const target = calibratedTarget(score, difficulty);
    const learningRate = Math.min(0.01, 0.006 * item.weight * difficultyInformation * severityWeight(item.severity) * modeWeight);
    const blended = current.score + (target - current.score) * learningRate;
    const next = verdict === "correct"
      ? Math.max(current.score, blended)
      : verdict === "wrong" || verdict === "partial"
        ? Math.min(current.score, blended)
        : blended;
    updates.set(item.dimension, {
      dimension: item.dimension,
      score: clampScore(next),
      evidence_count: Math.max(0, Math.round(Number(current.evidence_count) || 0)) + 1
    });
  }

  return [...updates.values()];
}

function skillEvidence(question: Question, result: GradeResult) {
  const questionSkills = normalizeSkillLabels(question.skills ?? [], question.grammar_focus);
  const findingSkills = normalizeSkillLabels(result.skill_findings ?? []);
  const dimensions = [
    { dimension: question.dimension, weight: 1 },
    ...(question.secondary_dimensions ?? []).map((dimension) => ({ dimension, weight: 0.55 }))
  ];
  const evidence: Array<{ dimension: Dimension; skill: string; score: number; verdict: GradeResult["verdict"] | DimensionScore["verdict"]; severity: DimensionScore["severity"]; weight: number }> = [];

  for (const item of dimensions) {
    const scored = scoreForDimension(question, result, item.dimension);
    for (const skill of questionSkills) {
      evidence.push({ ...item, skill, score: scored.score, verdict: scored.verdict, severity: scored.severity });
    }
    for (const skill of findingSkills) {
      const matched = questionSkills.find((candidate) => skill.includes(candidate) || candidate.includes(skill));
      evidence.push({
        ...item,
        skill: matched ?? skill,
        score: scored.score,
        verdict: scored.verdict,
        severity: scored.severity === "none" ? "minor" : scored.severity,
        weight: item.weight * 0.75
      });
    }
  }

  return evidence;
}

export function calculatePracticeSkillAbilityUpdates(
  skills: SkillAbility[],
  question: Question,
  result: GradeResult,
  mode = "每日练习"
): Array<Pick<SkillAbility, "dimension" | "skill" | "score" | "evidence_count">> {
  const currentByKey = new Map(skills.map((item) => [`${item.dimension}\u0000${item.skill}`, item]));
  const updates = new Map<string, Pick<SkillAbility, "dimension" | "skill" | "score" | "evidence_count">>();
  const difficulty = Math.max(1, Math.min(100, Number(question.difficulty) || 50));
  const modeWeight = mode === "错题重练" || question.source === "mistake" ? 0.75 : 1;

  for (const item of skillEvidence(question, result)) {
    const key = `${item.dimension}\u0000${item.skill}`;
    const current = updates.get(key) ?? currentByKey.get(key) ?? {
      dimension: item.dimension,
      skill: item.skill,
      score: 50,
      evidence_count: 0
    };
    const score = clampScore(item.score);
    const target = item.verdict === "wrong" ? score : calibratedTarget(score, difficulty);
    const rate = Math.min(0.18, 0.085 * item.weight * severityWeight(item.severity) * modeWeight);
    const blended = current.score + (target - current.score) * rate;
    const nextScore = item.verdict === "correct"
      ? Math.max(current.score, blended)
      : item.verdict === "wrong" || item.verdict === "partial"
        ? Math.min(current.score, blended)
        : blended;
    updates.set(key, {
      dimension: item.dimension,
      skill: item.skill,
      score: clampScore(nextScore),
      evidence_count: current.evidence_count + 1
    });
  }

  return [...updates.values()];
}

export function calculateAssessmentSkillAbilityUpdates(
  skills: SkillAbility[],
  records: QuestionAnswerRecord[]
): Array<Pick<SkillAbility, "dimension" | "skill" | "score" | "evidence_count">> {
  let current = skills;
  for (const record of records) {
    const updates = calculatePracticeSkillAbilityUpdates(current, record.question, record.result, "能力测评");
    const byKey = new Map(current.map((item) => [`${item.dimension}\u0000${item.skill}`, item]));
    updates.forEach((item) => byKey.set(`${item.dimension}\u0000${item.skill}`, {
      ...item,
      updated_at: new Date().toISOString()
    }));
    current = [...byKey.values()];
  }
  const original = new Map(skills.map((item) => [`${item.dimension}\u0000${item.skill}`, item]));
  return current
    .filter((item) => {
      const previous = original.get(`${item.dimension}\u0000${item.skill}`);
      return !previous || previous.score !== item.score || previous.evidence_count !== item.evidence_count;
    })
    .map(({ dimension, skill, score, evidence_count }) => ({ dimension, skill, score, evidence_count }));
}

export function assessmentFindings(records: QuestionAnswerRecord[]) {
  return records.flatMap((record) => {
    const prefix = `第 ${record.question_index + 1} 题 ${record.question.dimension}`;
    const dimensionNotes = record.result.dimension_scores?.map((item) => `${item.dimension}:${item.verdict}/${item.score} ${item.notes}`) ?? [];
    const skillNotes = record.result.skill_findings ?? [];
    return [...dimensionNotes, ...skillNotes].map((item) => `${prefix} - ${item}`);
  });
}

function compactText(value: string, maxLength = 180) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function assessmentEvidenceDetails(records: QuestionAnswerRecord[]) {
  return records.map((record) => ({
    question_index: record.question_index + 1,
    dimension: record.question.dimension,
    secondary_dimensions: record.question.secondary_dimensions ?? [],
    difficulty: record.question.difficulty,
    grammar_focus: record.question.grammar_focus,
    skills: record.question.skills ?? [],
    rubric_points: record.question.rubric_points ?? [],
    chinese: compactText(record.question.chinese),
    user_answer: compactText(record.user_answer),
    reference_answer: compactText(record.result.reference_answers[0] || record.question.answers[0] || ""),
    verdict: record.result.verdict,
    error_types: record.result.error_types,
    dimension_scores: (record.result.dimension_scores ?? []).map((item) => ({
      dimension: item.dimension,
      score: item.score,
      verdict: item.verdict,
      severity: item.severity,
      notes: compactText(item.notes, 120)
    })),
    differences: record.result.differences.map((item) => compactText(item, 140)).slice(0, 3),
    explanations: record.result.explanations.map((item) => compactText(item, 140)).slice(0, 3),
    skill_findings: (record.result.skill_findings ?? []).map((item) => compactText(item, 120)).slice(0, 5)
  }));
}
