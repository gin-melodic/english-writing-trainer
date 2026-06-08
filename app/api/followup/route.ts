import { NextResponse } from "next/server";
import { getSettings, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { answerQuestionFollowUp } from "@/lib/llm";
import { FollowUpMessage, GradeResult, Question } from "@/lib/types";

function toMessages(value: unknown): FollowUpMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const raw = item as Record<string, unknown>;
      const role = raw.role === "assistant" ? "assistant" : raw.role === "user" ? "user" : undefined;
      const content = typeof raw.content === "string" ? raw.content.trim() : "";
      return role && content ? { role, content } : undefined;
    })
    .filter((item): item is FollowUpMessage => Boolean(item))
    .slice(-8);
}

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json();
    const question = body.question as Question | undefined;
    const result = body.result as GradeResult | undefined;
    const userAnswer = typeof body.userAnswer === "string" ? body.userAnswer : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const messages = toMessages(body.messages);

    if (!question?.chinese || !result?.reference_answers || !userAnswer.trim()) {
      return NextResponse.json({ message: "缺少题目、用户答案或批改结果。" }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ message: "请输入要追问的问题。" }, { status: 400 });
    }

    const answer = await answerQuestionFollowUp(getSettings(user.id), question, userAnswer, result, messages, prompt);
    return NextResponse.json({ answer });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("POST /api/followup failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "追问失败" }, { status: 500 });
  }
}
