import { NextResponse } from "next/server";
import { getAbilities, getMistakes, getSettings, initDb } from "@/lib/db";
import { chooseAdaptiveDifficulty, chooseLowestDimension, generateQuestion } from "@/lib/llm";
import { DIMENSIONS, Dimension, Question } from "@/lib/types";

function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  try {
    initDb();
    const body = await request.json();
    const abilities = getAbilities();
    const mode = String(body.mode || "每日练习");
    const excludeMistakeIds = Array.isArray(body.excludeMistakeIds)
      ? body.excludeMistakeIds.map((id: unknown) => Number(id)).filter(Number.isFinite)
      : [];
    const previousQuestions = Array.isArray(body.previousQuestions)
      ? body.previousQuestions.map((item: unknown) => String(item)).filter(Boolean)
      : [];
    const regenerateReason = typeof body.regenerateReason === "string" ? body.regenerateReason : "";
    const batchIndex = Number(body.batchIndex);
    const batchTotal = Number(body.batchTotal);
    const paperPosition = Number.isFinite(batchIndex) && Number.isFinite(batchTotal)
      ? `第 ${batchIndex}/${batchTotal} 题`
      : "";
    const forceAi = Boolean(body.forceAi);

    if (mode === "错题重练" && !forceAi) {
      const mistake = getMistakes(true).find((item) => !excludeMistakeIds.includes(item.id));
      if (!mistake) return NextResponse.json({ done: true });
      const question: Question = { ...mistake, source: "mistake", mistakeId: mistake.id };
      return NextResponse.json({ question });
    }

    if (mode === "每日练习" && !forceAi) {
      const mistake = getMistakes(true).find((item) => !excludeMistakeIds.includes(item.id));
      if (mistake) {
        const question: Question = { ...mistake, source: "mistake", mistakeId: mistake.id };
        return NextResponse.json({ question });
      }
    }

    const dimension = isDimension(body.dimension)
      ? body.dimension
      : mode === "专项训练"
        ? "时态"
        : chooseLowestDimension(abilities);
    const score = abilities.find((item) => item.dimension === dimension)?.score ?? 30;
    const difficulty = Number(body.difficulty) || chooseAdaptiveDifficulty(score || 30);
    const useThinking = mode === "能力测评" && Boolean(body.thinking);
    const question = await generateQuestion(getSettings(), dimension, difficulty, true, previousQuestions, regenerateReason, paperPosition, { thinking: useThinking });
    return NextResponse.json({ question });
  } catch (error) {
    console.error("POST /api/question failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "题目生成失败" }, { status: 500 });
  }
}
