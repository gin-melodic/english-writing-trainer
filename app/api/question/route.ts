import { NextResponse } from "next/server";
import { getAbilities, getCapturedDrillQuestions, getMistakes, getRuntimeSettings, getSkillAbilities, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { chooseAdaptiveDifficulty, chooseLowestDimension, generateQuestion, generateQuestions } from "@/lib/llm";
import { DIMENSIONS, Dimension, Question } from "@/lib/types";

function isDimension(value: unknown): value is Dimension {
  return typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
}

function toFocusSkills(value: unknown) {
  return Array.isArray(value)
    ? value.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 5)
    : [];
}

function chooseBatchDimension(abilities: ReturnType<typeof getAbilities>, index: number) {
  const ranked = [...abilities].sort((a, b) => a.score - b.score || a.evidence_count - b.evidence_count);
  return ranked[index % ranked.length]?.dimension ?? chooseLowestDimension(abilities);
}

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json();
    const abilities = getAbilities(user.id);
    const mode = String(body.mode || "每日练习");
    const excludeMistakeIds = Array.isArray(body.excludeMistakeIds)
      ? body.excludeMistakeIds.map((id: unknown) => Number(id)).filter(Number.isFinite)
      : [];
    const excludeCaptureIds = Array.isArray(body.excludeCaptureIds)
      ? body.excludeCaptureIds.map((id: unknown) => Number(id)).filter(Number.isFinite)
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
    const captureOnly = Boolean(body.captureOnly) || body.origin === "user_capture";

    if (captureOnly && mode !== "能力测评") {
      const captured = getCapturedDrillQuestions(false, user.id).filter((item) => !excludeCaptureIds.includes(item.captureId ?? 0));
      if (!captured.length) return NextResponse.json({ done: true });
      return NextResponse.json({ question: captured[0], questions: Array.isArray(body.questions) ? captured.slice(0, body.questions.length) : undefined });
    }

    if (mode === "错题重练" && !forceAi) {
      const mistake = getMistakes(true, user.id).find((item) => !excludeMistakeIds.includes(item.id));
      if (!mistake) return NextResponse.json({ done: true });
      const question: Question = { ...mistake, source: "mistake", mistakeId: mistake.id };
      return NextResponse.json({ question });
    }

    if (mode === "每日练习" && !forceAi) {
      const mistake = getMistakes(true, user.id).find((item) => !excludeMistakeIds.includes(item.id));
      if (mistake) {
        const question: Question = { ...mistake, source: "mistake", mistakeId: mistake.id };
        return NextResponse.json({ question });
      }
      const captured = getCapturedDrillQuestions(true, user.id).find((item) => !excludeCaptureIds.includes(item.captureId ?? 0));
      if (captured) return NextResponse.json({ question: captured });
    }

    const requestedQuestions = Array.isArray(body.questions) ? body.questions : [];
    if (requestedQuestions.length > 0) {
      const specs = requestedQuestions
        .map((item: unknown, index: number) => {
          const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
          const dimension = isDimension(raw.dimension)
            ? raw.dimension
            : mode === "专项训练"
              ? "时态"
              : chooseBatchDimension(abilities, index);
          const score = abilities.find((ability) => ability.dimension === dimension)?.score ?? 30;
          const difficulty = Number(raw.difficulty) || chooseAdaptiveDifficulty(score || 30);
          const focusSkills = toFocusSkills(raw.focusSkills);
          const itemBatchIndex = Number(raw.batchIndex);
          const itemBatchTotal = Number(raw.batchTotal);
          const paperPosition = Number.isFinite(itemBatchIndex) && Number.isFinite(itemBatchTotal)
            ? `第 ${itemBatchIndex}/${itemBatchTotal} 题`
            : `第 ${index + 1}/${requestedQuestions.length} 题`;
          return { dimension, difficulty, focusSkills, paperPosition };
        });
      const useThinking = mode === "能力测评" && Boolean(body.thinking);
      const questions = await generateQuestions(getRuntimeSettings(user.id), specs, true, previousQuestions, regenerateReason, { thinking: useThinking });
      console.log("Generated question batch", { mode, count: specs.length, thinking: useThinking, specs, previousQuestions, regenerateReason });
      return NextResponse.json({ questions });
    }

    const dimension = isDimension(body.dimension)
      ? body.dimension
      : mode === "专项训练"
        ? "时态"
        : chooseLowestDimension(abilities);
    const score = abilities.find((item) => item.dimension === dimension)?.score ?? 30;
    const difficulty = Number(body.difficulty) || chooseAdaptiveDifficulty(score || 30);
    const useThinking = mode === "能力测评" && Boolean(body.thinking);
    const bodyFocusSkills = toFocusSkills(body.focusSkills);
    const weakSkills = bodyFocusSkills.length
      ? bodyFocusSkills
      : mode === "专项训练"
        ? getSkillAbilities(user.id)
          .filter((item) => item.dimension === dimension && item.evidence_count >= 1 && item.score < 70)
          .sort((a, b) => a.score - b.score || b.evidence_count - a.evidence_count)
          .map((item) => item.skill)
          .slice(0, 5)
        : [];
    const question = await generateQuestion(getRuntimeSettings(user.id), dimension, difficulty, true, previousQuestions, regenerateReason, paperPosition, { thinking: useThinking, focusSkills: weakSkills });
    console.log("Prompt for question generation", { dimension, difficulty, thinking: useThinking, focusSkills: weakSkills, previousQuestions, regenerateReason, paperPosition });
    console.log("Generated question", { dimension, difficulty, thinking: useThinking, focusSkills: weakSkills, question });
    return NextResponse.json({ question });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("POST /api/question failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "题目生成失败" }, { status: 500 });
  }
}
