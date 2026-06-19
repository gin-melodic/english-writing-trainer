import { NextResponse } from "next/server";
import { getRuntimeSettings, getSettings, initDb, setSettings } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { testConnection } from "@/lib/llm";
import { Settings } from "@/lib/types";

type SettingsBody = Partial<Settings> & {
  personalApiKey?: string;
  clearPersonalApiKey?: boolean;
};

function normalizePersonalSettings(settings: Settings & { personalApiKey?: string; userId?: number }) {
  const personalApiKey = settings.personalApiKey?.trim();
  const llmProvider: Settings["llmProvider"] = settings.llmProvider === "webllm" ? "webllm" : "openai-compatible";
  return {
    ...settings,
    llmProvider,
    maxConcurrentPredictions: Math.max(1, Math.min(20, Math.round(Number(settings.maxConcurrentPredictions) || 20))),
    personalProviderEnabled: llmProvider === "webllm" || Boolean(personalApiKey),
    personalBaseUrl: settings.personalBaseUrl || "https://api.siliconflow.cn/v1",
    personalModel: settings.personalModel || "deepseek-ai/DeepSeek-V4-Flash",
    webLlmModelBaseUrl: (settings.webLlmModelBaseUrl || "https://hf-mirror.com").replace(/\/+$/, ""),
    hasPersonalApiKey: llmProvider === "webllm" || Boolean(personalApiKey),
    personalApiKey
  };
}

function shouldValidatePersonalSettings(current: Settings, body: SettingsBody) {
  const targetProvider = body.llmProvider ?? current.llmProvider;
  if (targetProvider === "webllm") return false;
  if (body.clearPersonalApiKey) return false;
  if (typeof body.personalApiKey === "string" && body.personalApiKey.trim()) return true;
  if (!current.hasPersonalApiKey) return false;
  return (body.personalBaseUrl !== undefined && body.personalBaseUrl !== current.personalBaseUrl)
    || (body.personalModel !== undefined && body.personalModel !== current.personalModel);
}

export async function GET(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    return NextResponse.json(getSettings(user.id));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取设置失败" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json() as SettingsBody;
    const current = getRuntimeSettings(user.id);
    if (shouldValidatePersonalSettings(current, body)) {
      await testConnection(normalizePersonalSettings({
        ...current,
        ...body,
        personalApiKey: typeof body.personalApiKey === "string" && body.personalApiKey.trim()
          ? body.personalApiKey
          : current.personalApiKey
      }));
    }
    setSettings({ ...current, ...body }, user.role, user.id);
    return NextResponse.json(getSettings(user.id));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({
      message: error instanceof Error ? error.message : "保存设置失败"
    }, { status: 500 });
  }
}
