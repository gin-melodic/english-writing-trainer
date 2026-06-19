import { DIMENSIONS, Dimension, Question } from "./types";

export type QuestionCalibrationResult = {
  passed: boolean;
  difficulty_b: number;
  issues: string[];
};

const DIMENSION_KEYWORDS: Record<Dimension, RegExp[]> = {
  "时态": [/时态|过去|现在|将来|完成|进行|动词|谓语|tense/i],
  "介词搭配": [/介词|搭配|短语|方位|时间介词|preposition/i],
  "定语从句": [/定语从句|关系词|关系代词|先行词|who|which|that|where|relative/i],
  "连接词": [/连接词|连词|从句|原因|条件|让步|转折|because|although|if|when|conjunction/i],
  "被动语态": [/被动|语态|承受者|过去分词|passive/i],
  "冠词": [/冠词|限定词|特指|泛指|可数|article|determiner/i]
};

function clampDifficulty(value: number) {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function textMatchesDimension(text: string, dimension: Dimension) {
  return DIMENSION_KEYWORDS[dimension].some((pattern) => pattern.test(text));
}

export function calibrateGeneratedQuestion(question: Question, targetDifficulty: number): QuestionCalibrationResult {
  const issues: string[] = [];
  const chinese = String(question.chinese || "");
  const structuralSignals = (chinese.match(/[，,；;。]/g) ?? []).length
    + (chinese.match(/因为|虽然|如果|当|把|被|的|但是|所以|而且|直到|已经|正在/g) ?? []).length;
  const secondaryCount = question.secondary_dimensions?.length ?? 0;
  const skillCount = question.skills?.length ?? 0;
  const rubricCount = question.rubric_points?.length ?? 0;

  const lengthScore = Math.min(38, chinese.replace(/\s/g, "").length * 1.15);
  const structureScore = Math.min(28, structuralSignals * 5.5);
  const dimensionScore = Math.min(14, secondaryCount * 5 + Math.max(0, skillCount - 1) * 1.5 + Math.min(3, rubricCount));
  const dimensionBase = question.dimension === "定语从句" || question.dimension === "被动语态"
    ? 12
    : question.dimension === "连接词"
      ? 10
      : 6;
  const difficulty_b = clampDifficulty(8 + lengthScore + structureScore + dimensionScore + dimensionBase);
  const target = clampDifficulty(Number(targetDifficulty) || Number(question.difficulty) || 50);

  const dimensionText = [
    question.grammar_focus,
    ...(question.skills ?? []),
    ...(question.rubric_points ?? [])
  ].join(" ");
  if (!textMatchesDimension(dimensionText, question.dimension)) issues.push("dimension_mismatch");
  if (Math.abs(difficulty_b - target) > 15) issues.push("difficulty_out_of_range");

  return {
    passed: issues.length === 0,
    difficulty_b,
    issues
  };
}
