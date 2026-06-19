import { NextResponse } from "next/server";
import { calculatePracticeAbilityUpdates, calculatePracticeSkillAbilityUpdates } from "@/lib/assessment";
import { addMistake, getAbilities, getRuntimeSettings, getSkillAbilities, initDb, recordQuestionAnswer, setAbility, setSkillAbility, updateCapturedDrillStreak, updateMistakeStreak, updateSession } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { gradeAnswer } from "@/lib/llm";
import { publicQuestionSkills } from "@/lib/questionSafety";
import { GradeResult, Question } from "@/lib/types";

function normalizeClientGradeResult(value: unknown): GradeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GradeResult>;
  if (!["correct", "partial", "wrong"].includes(String(raw.verdict))) return undefined;
  const toArray = (items: unknown) => Array.isArray(items) ? items.map((item) => String(item)).filter(Boolean) : [];
  return {
    verdict: raw.verdict as GradeResult["verdict"],
    error_types: toArray(raw.error_types),
    error_tags: Array.isArray(raw.error_tags) ? raw.error_tags : undefined,
    reference_answers: toArray(raw.reference_answers),
    differences: toArray(raw.differences),
    explanations: toArray(raw.explanations),
    memory_tip: typeof raw.memory_tip === "string" ? raw.memory_tip : undefined,
    dimension_scores: Array.isArray(raw.dimension_scores) ? raw.dimension_scores : undefined,
    skill_findings: toArray(raw.skill_findings)
  };
}

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json() as {
      question: Question;
      answer: string;
      result?: unknown;
      sessionId?: number;
      mode?: string;
      questionIndex?: number;
      durationSeconds?: number;
    };
    const { question, answer, sessionId, mode, questionIndex, durationSeconds } = body;
    const safeQuestion: Question = { ...question, skills: publicQuestionSkills(question.skills) };
    const settings = getRuntimeSettings(user.id);
    const clientResult = normalizeClientGradeResult(body.result);
    if (settings.llmProvider === "webllm" && !clientResult) {
      return NextResponse.json({ message: "WebLLM 模式需要提交浏览器端批改结果" }, { status: 400 });
    }
    const result = clientResult ?? await gradeAnswer(settings, safeQuestion, answer);
    if (!result.reference_answers.length) result.reference_answers = safeQuestion.answers;
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
      }, user.id);
    }

    if (normalizedMode === "能力测评") {
      if (sessionId) updateSession(sessionId, correct, user.id);
      return NextResponse.json({ result, abilities: getAbilities(user.id), skillAbilities: getSkillAbilities(user.id) });
    }

    const abilities = getAbilities(user.id);
    for (const update of calculatePracticeAbilityUpdates(abilities, safeQuestion, result, normalizedMode)) {
      setAbility(update.dimension, update.score, update.evidence_count, user.id);
    }
    for (const update of calculatePracticeSkillAbilityUpdates(getSkillAbilities(user.id), safeQuestion, result, normalizedMode)) {
      setSkillAbility(update, user.id);
    }

    if (safeQuestion.origin === "user_capture" && safeQuestion.captureId) {
      updateCapturedDrillStreak(safeQuestion.captureId, correct, user.id);
    }

    if (safeQuestion.source === "mistake" && safeQuestion.mistakeId) {
      updateMistakeStreak(safeQuestion.mistakeId, correct, user.id);
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
      }, user.id);
    }

    if (sessionId) updateSession(sessionId, correct, user.id);
    return NextResponse.json({ result, abilities: getAbilities(user.id), skillAbilities: getSkillAbilities(user.id) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("POST /api/grade failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "批改失败" }, { status: 500 });
  }
}
