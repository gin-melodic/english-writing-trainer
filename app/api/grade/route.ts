import { NextResponse } from "next/server";
import { calculatePracticeAbilityUpdates, calculatePracticeSkillAbilityUpdates } from "@/lib/assessment";
import { addMistake, getAbilities, getSettings, getSkillAbilities, initDb, recordQuestionAnswer, setAbility, setSkillAbility, updateCapturedDrillStreak, updateMistakeStreak, updateSession } from "@/lib/db";
import { gradeAnswer } from "@/lib/llm";
import { publicQuestionSkills } from "@/lib/questionSafety";
import { Question } from "@/lib/types";

export async function POST(request: Request) {
  try {
    initDb();
    const { question, answer, sessionId, mode, questionIndex, durationSeconds } = (await request.json()) as {
      question: Question;
      answer: string;
      sessionId?: number;
      mode?: string;
      questionIndex?: number;
      durationSeconds?: number;
    };
    const safeQuestion: Question = { ...question, skills: publicQuestionSkills(question.skills) };
    const result = await gradeAnswer(getSettings(), safeQuestion, answer);
    const correct = result.verdict === "correct";
    const normalizedMode = String(mode || "每日练习");

    if (sessionId) {
      recordQuestionAnswer({
        sessionId,
        mode: normalizedMode,
        questionIndex: Number.isFinite(Number(questionIndex)) ? Number(questionIndex) : 0,
        question: safeQuestion,
        userAnswer: answer,
        result,
        durationSeconds
      });
    }

    if (normalizedMode === "能力测评") {
      if (sessionId) updateSession(sessionId, correct);
      return NextResponse.json({ result, abilities: getAbilities(), skillAbilities: getSkillAbilities() });
    }

    const abilities = getAbilities();
    for (const update of calculatePracticeAbilityUpdates(abilities, safeQuestion, result, normalizedMode)) {
      setAbility(update.dimension, update.score, update.evidence_count);
    }
    for (const update of calculatePracticeSkillAbilityUpdates(getSkillAbilities(), safeQuestion, result, normalizedMode)) {
      setSkillAbility(update);
    }

    if (safeQuestion.origin === "user_capture" && safeQuestion.captureId) {
      updateCapturedDrillStreak(safeQuestion.captureId, correct);
    }

    if (safeQuestion.source === "mistake" && safeQuestion.mistakeId) {
      updateMistakeStreak(safeQuestion.mistakeId, correct);
    } else if (!correct) {
      addMistake({
        chinese: safeQuestion.chinese,
        answers: result.reference_answers?.length ? result.reference_answers : safeQuestion.answers,
        vocabulary_tips: safeQuestion.vocabulary_tips ?? [],
        grammar_focus: safeQuestion.grammar_focus,
        dimension: safeQuestion.dimension,
        skills: safeQuestion.skills ?? [],
        difficulty: safeQuestion.difficulty,
        error_types: result.error_types ?? []
      });
    }

    if (sessionId) updateSession(sessionId, correct);
    return NextResponse.json({ result, abilities: getAbilities(), skillAbilities: getSkillAbilities() });
  } catch (error) {
    console.error("POST /api/grade failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "批改失败" }, { status: 500 });
  }
}
