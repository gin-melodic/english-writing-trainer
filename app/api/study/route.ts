import { NextResponse } from "next/server";
import { getSettings, initDb } from "@/lib/db";
import { generateStudyGuide } from "@/lib/llm";
import { DIMENSIONS, Dimension, Question } from "@/lib/types";

function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

function toTextArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export async function POST(request: Request) {
  try {
    initDb();
    const body = await request.json();
    const questions = Array.isArray(body.questions) ? body.questions as Partial<Question>[] : [];
    const outlines = questions
      .map((question) => {
        if (!isDimension(question.dimension)) return undefined;
        return {
          dimension: question.dimension,
          secondary_dimensions: toTextArray(question.secondary_dimensions).filter(isDimension),
          grammar_focus: typeof question.grammar_focus === "string" ? question.grammar_focus : question.dimension,
          skills: toTextArray(question.skills),
          rubric_points: toTextArray(question.rubric_points),
          difficulty: Number(question.difficulty) || 50
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    if (outlines.length < 1) {
      return NextResponse.json({ message: "缺少可用于生成学习内容的试卷知识点。" }, { status: 400 });
    }

    const guide = await generateStudyGuide(getSettings(), outlines);
    return NextResponse.json({ guide });
  } catch (error) {
    console.error("POST /api/study failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "学习内容生成失败" }, { status: 500 });
  }
}
