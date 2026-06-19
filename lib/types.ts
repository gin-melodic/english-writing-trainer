export const DIMENSIONS = ["时态", "介词搭配", "定语从句", "连接词", "被动语态", "冠词"] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type ErrorTag =
  | "tense_error"
  | "missing_article"
  | "wrong_article"
  | "preposition_error"
  | "clause_word_order"
  | "subject_verb_agreement"
  | "passive_voice_error"
  | "relative_clause_error"
  | "conjunction_error"
  | "word_choice"
  | "omission"
  | "spelling_or_punctuation"
  | "other";

export type Settings = {
  llmProvider: "zai" | "openai-compatible" | "webllm";
  baseUrl: string;
  model: string;
  temperature: number;
  dailyCount: number;
  maxConcurrentPredictions: number;
  personalProviderEnabled: boolean;
  personalBaseUrl: string;
  personalModel: string;
  webLlmModelBaseUrl: string;
  hasPersonalApiKey: boolean;
};

export type Ability = {
  dimension: Dimension;
  score: number;
  evidence_count: number;
};

export type SkillAbility = {
  dimension: Dimension;
  skill: string;
  score: number;
  evidence_count: number;
  updated_at: string;
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
  difficulty_b?: number;
  calibration_issues?: string[];
  calibration_passed?: boolean;
  source?: "ai" | "mistake";
  origin?: "ai" | "mistake" | "user_capture";
  mistakeId?: number;
  captureId?: number;
};

export type DrillCard = {
  casual: string;
  standard: string;
  vivid: string;
  source_cn: string;
  reference_en: string;
  grammar_dimension: Dimension;
  common_mistake: string;
  memory_hook: string;
};

export type CapturedDrill = DrillCard & {
  id: number;
  origin: "user_capture";
  difficulty: number;
  correct_streak: number;
  created_at: string;
  updated_at: string;
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
  error_tags?: ErrorTag[];
  reference_answers: string[];
  differences: string[];
  explanations: string[];
  memory_tip?: string;
  dimension_scores?: DimensionScore[];
  skill_findings?: string[];
};

export type FollowUpMessage = {
  role: "user" | "assistant";
  content: string;
};

export type Mistake = {
  id: number;
  chinese: string;
  answers: string[];
  vocabulary_tips?: string[];
  grammar_focus: string;
  dimension: Dimension;
  skills?: string[];
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

export type PracticeDimensionReport = {
  dimension: Dimension;
  total: number;
  correct: number;
  partial: number;
  wrong: number;
  accuracy: number;
  average_score: number;
  evidence_count: number;
  notes: string[];
};

export type PracticeReport = {
  session_id: number;
  date: string;
  mode: string;
  total: number;
  correct: number;
  partial: number;
  wrong: number;
  accuracy: number;
  average_score: number;
  average_duration_seconds: number;
  dimension_reports: PracticeDimensionReport[];
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
};

export type AbilityHistory = {
  date: string;
  dimension: Dimension;
  score: number;
  evidence_count: number;
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

export type ReportFacts = {
  total_questions: number;
  matrix: AssessmentMatrixItem[];
  weakest_dimensions: Array<{
    dimension: Dimension;
    score: number;
    confidence: number;
    evidence_count: number;
  }>;
  insufficient_evidence_dimensions: Dimension[];
  top_error_tags: Array<{
    tag: ErrorTag;
    count: number;
  }>;
  top_skill_findings: Array<{
    skill: string;
    count: number;
  }>;
};
