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

    if (mode === "错题重练") {
      const mistake = getMistakes(true)[0];
      if (!mistake) return NextResponse.json({ done: true });
      const question: Question = { ...mistake, source: "mistake", mistakeId: mistake.id };
      return NextResponse.json({ question });
    }

    if (mode === "每日练习") {
      const mistake = getMistakes(true)[0];
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
    const question = await generateQuestion(getSettings(), dimension, difficulty);
    return NextResponse.json({ question });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "题目生成失败" }, { status: 500 });
  }
}
