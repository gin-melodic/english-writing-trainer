import { addAssessmentReport, endSession, getAbilities, getQuestionAnswers, getRuntimeSettings, getSkillAbilities, initDb, setAbility, setSkillAbility } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { generateAssessmentNarrativeStream } from "@/lib/llm";
import { assessmentEvidenceDetails, assessmentFindings, calculateAssessmentMatrix, calculateAssessmentSkillAbilityUpdates, mergeAssessmentScore } from "@/lib/assessment";
import { Dimension } from "@/lib/types";

export async function POST(request: Request) {
  initDb();
  let user;
  try {
    user = requireUser(request);
  } catch (error) {
    return authErrorResponse(error) ?? new Response(JSON.stringify({ message: "请先登录。" }), { status: 401 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const { sessionId } = (await request.json()) as { sessionId?: number };
        if (!sessionId) throw new Error("缺少测评 sessionId");

        send("matrix", { title: "正在读取测评记录", detail: "正在汇总本次测评的逐题批改结果。", percent: 80 });
        const records = getQuestionAnswers(Number(sessionId), user.id).filter((item) => item.mode === "能力测评");
        if (records.length < 1) throw new Error("没有可用于生成报告的测评答题记录");

        const matrix = calculateAssessmentMatrix(records);
        const findings = assessmentFindings(records);
        const evidenceDetails = assessmentEvidenceDetails(records);
        send("matrix", {
          title: "能力矩阵已计算",
          detail: `已汇总 ${records.length} 道题和 ${findings.length} 条典型证据。`,
          percent: 84,
          totalQuestions: records.length
        });

        send("llm_start", {
          title: "正在调用 GLM",
          detail: "正在用结构化输出生成详细报告，进度会随流式输出更新。",
          percent: 85,
          totalQuestions: records.length
        });
        let lastProgressAt = 0;
        const narrative = await generateAssessmentNarrativeStream(getRuntimeSettings(user.id), {
          totalQuestions: records.length,
          matrix,
          findings,
          evidence_details: evidenceDetails
        }, (progress) => {
          const now = Date.now();
          if (!progress.finalTokens && now - lastProgressAt < 200) return;
          lastProgressAt = now;
          const tokenBudget = 800;
          const llmPercent = Math.min(96, 85 + Math.round((Math.min(progress.estimatedTokens, tokenBudget) / tokenBudget) * 11));
          send("llm_delta", {
            title: progress.fallback ? "流式不可用，正在使用兼容模式" : "正在生成详细报告",
            detail: progress.fallback ? "GLM 当前响应不支持流式统计，已切换为一次性生成。" : "正在接收 GLM 的流式输出并聚合结构化报告。",
            percent: progress.fallback ? 90 : llmPercent,
            generatedChars: progress.generatedChars,
            estimatedTokens: progress.estimatedTokens,
            tokensPerSecond: progress.tokensPerSecond,
            finalTokens: progress.finalTokens
          });
        });

        send("saving", {
          title: "正在保存报告",
          detail: "详细报告已生成，正在更新能力分并写入测评记录。",
          percent: 98,
          totalQuestions: records.length
        });

        const currentAbilities = getAbilities(user.id);
        const initializing = currentAbilities.every((item) => item.evidence_count === 0);
        for (const item of matrix) {
          const current = currentAbilities.find((ability) => ability.dimension === item.dimension);
          setAbility(
            item.dimension as Dimension,
            mergeAssessmentScore(current?.score ?? 50, item.score, item.confidence, initializing),
            (current?.evidence_count ?? 0) + item.evidence_count,
            user.id
          );
        }
        for (const update of calculateAssessmentSkillAbilityUpdates(getSkillAbilities(user.id), records)) {
          setSkillAbility(update, user.id);
        }

        const createdAt = new Date().toISOString();
        const reportId = addAssessmentReport({
          sessionId: Number(sessionId),
          totalQuestions: records.length,
          matrix,
          summary: narrative.summary,
          weakPoints: narrative.weak_points,
          recommendations: narrative.recommendations
        }, user.id);
        endSession(Number(sessionId), user.id);

        send("done", {
          title: "报告已生成",
          detail: "能力测评报告已保存。",
          percent: 100,
          report: {
            id: reportId,
            session_id: Number(sessionId),
            total_questions: records.length,
            matrix,
            summary: narrative.summary,
            weak_points: narrative.weak_points,
            recommendations: narrative.recommendations,
            created_at: createdAt
          },
          abilities: getAbilities(user.id),
          skillAbilities: getSkillAbilities(user.id)
        });
      } catch (error) {
        console.error("POST /api/assessment/finalize failed", error);
        send("error", { message: error instanceof Error ? error.message : "测评报告生成失败" });
      } finally {
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
