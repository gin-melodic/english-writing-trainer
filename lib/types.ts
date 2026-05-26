export const DIMENSIONS = ["时态", "介词搭配", "定语从句", "连接词", "被动语态", "冠词"] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type Settings = {
  baseUrl: string;
  model: string;
  temperature: number;
  dailyCount: number;
};

export type Ability = {
  dimension: Dimension;
  score: number;
};

export type Question = {
  id?: number;
  chinese: string;
  answers: string[];
  grammar_focus: string;
  dimension: Dimension;
  difficulty: number;
  source?: "ai" | "mistake";
  mistakeId?: number;
};

export type GradeResult = {
  verdict: "correct" | "partial" | "wrong";
  error_types: string[];
  reference_answers: string[];
  differences: string[];
  explanations: string[];
  memory_tip?: string;
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
