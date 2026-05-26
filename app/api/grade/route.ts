import { NextResponse } from "next/server";
import { addMistake, getAbilities, getSettings, initDb, setAbility, updateMistakeStreak, updateSession } from "@/lib/db";
import { gradeAnswer } from "@/lib/llm";
import { Question } from "@/lib/types";

function abilityDelta(verdict: string, difficulty: number) {
  if (verdict === "correct") return difficulty >= 70 ? 5 : difficulty >= 45 ? 4 : 2;
  if (verdict === "partial") return 1;
  return difficulty >= 70 ? -1 : difficulty >= 45 ? -2 : -3;
}

export async function POST(request: Request) {
  try {
    initDb();
    const { question, answer, sessionId } = (await request.json()) as {
      question: Question;
      answer: string;
      sessionId?: number;
    };
    const result = await gradeAnswer(getSettings(), question, answer);
    const correct = result.verdict === "correct";
    const abilities = getAbilities();
    const current = abilities.find((item) => item.dimension === question.dimension)?.score ?? 0;
    setAbility(question.dimension, current + abilityDelta(result.verdict, question.difficulty));

    if (question.source === "mistake" && question.mistakeId) {
      updateMistakeStreak(question.mistakeId, correct);
    } else if (!correct) {
      addMistake({
        chinese: question.chinese,
        answers: result.reference_answers?.length ? result.reference_answers : question.answers,
        grammar_focus: question.grammar_focus,
        dimension: question.dimension,
        difficulty: question.difficulty,
        error_types: result.error_types ?? []
      });
    }

    if (sessionId) updateSession(sessionId, correct);
    return NextResponse.json({ result, abilities: getAbilities() });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "批改失败" }, { status: 500 });
  }
}
