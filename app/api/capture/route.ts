import { NextResponse } from "next/server";
import { addCapturedDrill, getRuntimeSettings, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { generateDrillCard } from "@/lib/llm";
import { DIMENSIONS } from "@/lib/types";
import type { DrillCard } from "@/lib/types";

class ValidationError extends Error {}

function validateSourceCn(value: unknown) {
  const sourceCn = typeof value === "string" ? value.trim() : "";
  if (sourceCn.length < 2) throw new ValidationError("请先输入中文个人场景");
  if (sourceCn.length > 600) throw new ValidationError("中文场景请控制在 600 字以内");
  return sourceCn;
}

function validateCard(value: unknown): DrillCard {
  if (!value || typeof value !== "object") throw new ValidationError("缺少可保存的表达卡");
  const raw = value as Record<string, unknown>;
  const card = {
    casual: String(raw.casual || "").trim(),
    standard: String(raw.standard || "").trim(),
    vivid: String(raw.vivid || "").trim(),
    source_cn: String(raw.source_cn || "").trim(),
    reference_en: String(raw.reference_en || raw.standard || "").trim(),
    grammar_dimension: String(raw.grammar_dimension || ""),
    common_mistake: String(raw.common_mistake || "").trim(),
    memory_hook: String(raw.memory_hook || "").trim()
  };
  if (!card.source_cn || !card.standard || !card.casual || !card.vivid) {
    throw new ValidationError("表达卡内容不完整，无法保存");
  }
  if (!(DIMENSIONS as readonly string[]).includes(card.grammar_dimension)) {
    throw new ValidationError("表达卡语法维度无效");
  }
  return {
    ...card,
    reference_en: card.standard,
    grammar_dimension: card.grammar_dimension as DrillCard["grammar_dimension"]
  };
}

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json();
    const action = String(body.action || "generate");

    if (action === "generate") {
      const sourceCn = validateSourceCn(body.source_cn);
      const card = await generateDrillCard(getRuntimeSettings(user.id), sourceCn);
      return NextResponse.json({ card });
    }

    if (action === "save") {
      const card = validateCard(body.card);
      const id = addCapturedDrill(card, user.id);
      return NextResponse.json({ id, card });
    }

    if (action === "generate_and_save") {
      const sourceCn = validateSourceCn(body.source_cn);
      const card = await generateDrillCard(getRuntimeSettings(user.id), sourceCn);
      const id = addCapturedDrill(card, user.id);
      return NextResponse.json({ id, card });
    }

    throw new ValidationError("未知 capture 操作");
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("POST /api/capture failed", error);
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ message: error instanceof Error ? error.message : "表达捕捉失败" }, { status });
  }
}
