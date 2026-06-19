import { NextResponse } from "next/server";
import { getRuntimeSettings, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { answerQuestionFollowUp, answerQuestionFollowUpStream } from "@/lib/llm";
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

function logPreview(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
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

    if (body.stream === true) {
      const encoder = new TextEncoder();
      const runtimeSettings = getRuntimeSettings(user.id);
      const requestId = `followup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      console.info("POST /api/followup stream started", {
        requestId,
        userId: user.id,
        provider: runtimeSettings.llmProvider,
        model: runtimeSettings.personalProviderEnabled ? runtimeSettings.personalModel : runtimeSettings.model,
        promptChars: prompt.length,
        prompt: logPreview(prompt),
        priorMessages: messages.length,
        question: logPreview(question.chinese),
        userAnswerChars: userAnswer.length
      });
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            const payload = JSON.stringify(data);
            console.info("POST /api/followup SSE send", {
              requestId,
              event,
              payloadChars: payload.length,
              payload: logPreview(payload)
            });
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
          };
          try {
            const answer = await answerQuestionFollowUpStream(runtimeSettings, question, userAnswer, result, messages, prompt, (progress) => {
              console.info("POST /api/followup upstream delta", {
                requestId,
                deltaChars: progress.deltaContent?.length ?? 0,
                generatedChars: progress.generatedChars,
                estimatedTokens: progress.estimatedTokens,
                tokensPerSecond: progress.tokensPerSecond,
                finalTokens: progress.finalTokens,
                delta: logPreview(progress.deltaContent || "")
              });
              send("delta", {
                content: progress.deltaContent || "",
                generatedChars: progress.generatedChars,
                estimatedTokens: progress.estimatedTokens,
                tokensPerSecond: progress.tokensPerSecond,
                finalTokens: progress.finalTokens
              });
            });
            console.info("POST /api/followup stream completed", {
              requestId,
              answerChars: answer.length,
              answer: logPreview(answer)
            });
            send("done", { answer });
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : "追问失败";
            console.error("POST /api/followup stream failed", {
              requestId,
              error
            });
            send("error", { message });
            controller.close();
          }
        }
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        }
      });
    }

    const answer = await answerQuestionFollowUp(getRuntimeSettings(user.id), question, userAnswer, result, messages, prompt);
    return NextResponse.json({ answer });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("POST /api/followup failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "追问失败" }, { status: 500 });
  }
}
