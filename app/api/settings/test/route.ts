import { NextResponse } from "next/server";
import { getRuntimeSettings, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { ConnectionTestResult, testConnection } from "@/lib/llm";
import { Settings } from "@/lib/types";

type SettingsTestTarget = "global" | "personal";

function normalizeGlobalSettings(settings: Settings & { userId?: number }) {
  return {
    llmProvider: "zai" as const,
    baseUrl: settings.baseUrl || "https://open.bigmodel.cn/api/paas/v4",
    model: settings.model || "glm-4.7-flash",
    temperature: Math.min(1, Math.max(0, Number(settings.temperature) || 0.3)),
    dailyCount: Math.min(50, Math.max(10, Number(settings.dailyCount) || 20)),
    maxConcurrentPredictions: 1,
    personalProviderEnabled: false,
    personalBaseUrl: settings.personalBaseUrl || "https://api.siliconflow.cn/v1",
    personalModel: settings.personalModel || "deepseek-ai/DeepSeek-V4-Flash",
    webLlmModelBaseUrl: (settings.webLlmModelBaseUrl || "https://hf-mirror.com").replace(/\/+$/, ""),
    personalResponseFormat: "auto" as Settings["personalResponseFormat"],
    hasPersonalApiKey: false,
    userId: settings.userId
  };
}

function normalizePersonalSettings(settings: Settings & { personalApiKey?: string; userId?: number }) {
  const personalApiKey = settings.personalApiKey?.trim();
  const llmProvider: Settings["llmProvider"] = settings.llmProvider === "webllm" ? "webllm" : "openai-compatible";
  const hasPersonalApiKey = llmProvider === "webllm" || Boolean(settings.hasPersonalApiKey || personalApiKey);
  if (llmProvider !== "webllm" && !personalApiKey) throw new Error("请先填写或保存个人模型 API Key");
  return {
    llmProvider,
    baseUrl: settings.baseUrl || "https://open.bigmodel.cn/api/paas/v4",
    model: settings.model || "glm-4.7-flash",
    temperature: Math.min(1, Math.max(0, Number(settings.temperature) || 0.3)),
    dailyCount: Math.min(50, Math.max(10, Number(settings.dailyCount) || 20)),
    maxConcurrentPredictions: Math.max(1, Math.min(20, Math.round(Number(settings.maxConcurrentPredictions) || 20))),
    personalProviderEnabled: hasPersonalApiKey,
    personalBaseUrl: settings.personalBaseUrl || "https://api.siliconflow.cn/v1",
    personalModel: settings.personalModel || "deepseek-ai/DeepSeek-V4-Flash",
    webLlmModelBaseUrl: (settings.webLlmModelBaseUrl || "https://hf-mirror.com").replace(/\/+$/, ""),
    personalResponseFormat: ["auto", "json_object", "json_schema", "none"].includes(String(settings.personalResponseFormat))
      ? settings.personalResponseFormat as Settings["personalResponseFormat"]
      : "auto",
    hasPersonalApiKey,
    personalApiKey,
    userId: settings.userId
  };
}

function attachedResult(error: unknown): ConnectionTestResult | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { connectionTestResult?: ConnectionTestResult }).connectionTestResult;
}

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json().catch(() => undefined);
    const bodyObject = body && typeof body === "object" ? body as Partial<Settings> & { personalApiKey?: string; target?: SettingsTestTarget } : {};
    const target: SettingsTestTarget = bodyObject.target === "global" || bodyObject.target === "personal"
      ? bodyObject.target
      : user.role === "admin" ? "global" : "personal";
    if (target === "global" && user.role !== "admin") {
      return NextResponse.json({ message: "需要管理员权限。" }, { status: 403 });
    }


    const current = getRuntimeSettings(user.id);
    const bodyPersonalApiKey = bodyObject.personalApiKey?.trim();
    const merged = {
      ...current,
      ...bodyObject,
      personalApiKey: bodyPersonalApiKey || current.personalApiKey
    };
    const settings = target === "personal"
      ? normalizePersonalSettings(merged)
      : normalizeGlobalSettings(merged);
    const result = await testConnection(settings);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const result = attachedResult(error);
    console.error("POST /api/settings/test failed", {
      message: error instanceof Error ? error.message : "连接失败",
      stack: error instanceof Error ? error.stack : undefined,
      result: result ? JSON.stringify(result, null, 2) : undefined
    });
    return NextResponse.json({
      ok: false,
      message: error instanceof Error ? error.message : "连接失败",
      result
    }, { status: 500 });
  }
}
