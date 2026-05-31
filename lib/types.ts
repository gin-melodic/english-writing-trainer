export const DIMENSIONS = ["时态", "介词搭配", "定语从句", "连接词", "被动语态", "冠词"] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type Settings = {
  baseUrl: string;
  model: string;
  temperature: number;
  dailyCount: number;
  maxConcurrentPredictions: number;
};

export type Ability = {
  dimension: Dimension;
  score: number;
};

export type Question = {
  id?: number;
  chinese: string;
  answers: string[];
  vocabulary_tips?: string[];
  grammar_focus: string;
  dimension: Dimension;
  secondary_dimensions?: Dimension[];
  skills?: string[];
  rubric_points?: string[];
  difficulty: number;
  source?: "ai" | "mistake";
  mistakeId?: number;
};

export type StudyGuideSection = {
  title: string;
  why_it_matters: string;
  explanation: string;
  key_points: string[];
  patterns: string[];
  contrast: string[];
  examples: string[];
  pitfalls: string[];
  drills: Array<{
    prompt: string;
    answer: string;
    explanation: string;
  }>;
};

export type StudyGuide = {
  overview: string;
  sections: StudyGuideSection[];
  checklist: string[];
};

export type DimensionScore = {
  dimension: Dimension;
  score: number;
  verdict: "correct" | "partial" | "wrong";
  severity: "none" | "minor" | "major";
  notes: string;
};

export type GradeResult = {
  verdict: "correct" | "partial" | "wrong";
  error_types: string[];
  reference_answers: string[];
  differences: string[];
  explanations: string[];
  memory_tip?: string;
  dimension_scores?: DimensionScore[];
  skill_findings?: string[];
};

export type Mistake = {
  id: number;
  chinese: string;
  answers: string[];
  grammar_focus: string;
  dimension: Dimension;
  difficulty: number;
  error_types: string[];
  correct_streak: number;
  created_at: string;
};

export type TrainingRecord = {
  id: number;
  date: string;
  mode: string;
  total: number;
  correct: number;
  accuracy: number;
};

export type AbilityHistory = {
  date: string;
  dimension: Dimension;
  score: number;
};

export type QuestionAnswerRecord = {
  id: number;
  session_id: number;
  mode: string;
  question_index: number;
  question: Question;
  user_answer: string;
  result: GradeResult;
  duration_seconds: number;
  created_at: string;
};

export type AssessmentMatrixItem = {
  dimension: Dimension;
  score: number;
  confidence: number;
  evidence_count: number;
};

export type AssessmentReport = {
  id: number;
  session_id: number;
  total_questions: number;
  matrix: AssessmentMatrixItem[];
  summary: string;
  weak_points: string[];
  recommendations: string[];
  created_at: string;
};
