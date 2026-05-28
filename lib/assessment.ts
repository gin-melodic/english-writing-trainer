import { AssessmentMatrixItem, DIMENSIONS, GradeResult, QuestionAnswerRecord } from "./types";

function fallbackScore(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") return 100;
  if (verdict === "partial") return 60;
  return 20;
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

export function mergeAssessmentScore(current: number, assessed: number, confidence: number, initializing: boolean) {
  if (initializing) return assessed;
  const assessmentWeight = Math.min(0.8, 0.35 + confidence * 0.45);
  return Math.round(current * (1 - assessmentWeight) + assessed * assessmentWeight);
}

export function assessmentFindings(records: QuestionAnswerRecord[]) {
  return records.flatMap((record) => {
    const prefix = `第 ${record.question_index + 1} 题 ${record.question.dimension}`;
    const dimensionNotes = record.result.dimension_scores?.map((item) => `${item.dimension}:${item.verdict}/${item.score} ${item.notes}`) ?? [];
    const skillNotes = record.result.skill_findings ?? [];
    return [...dimensionNotes, ...skillNotes].map((item) => `${prefix} - ${item}`);
  });
}
