import { NextResponse } from "next/server";
import { getSettings, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { ConnectionTestResult, testConnection } from "@/lib/llm";
import { Settings } from "@/lib/types";

function normalizeSettings(settings: Settings): Settings {
  return {
    baseUrl: settings.baseUrl || "http://localhost:1234",
    model: settings.model || "",
    temperature: Math.min(1, Math.max(0, Number(settings.temperature) || 0.3)),
    dailyCount: Math.min(50, Math.max(10, Number(settings.dailyCount) || 20)),
    maxConcurrentPredictions: Math.min(10, Math.max(1, Number(settings.maxConcurrentPredictions) || 5))
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
    if (user.role !== "admin") return NextResponse.json({ message: "需要管理员权限。" }, { status: 403 });
    const body = await request.json().catch(() => undefined);
    const settings = normalizeSettings({ ...getSettings(user.id), ...(body && typeof body === "object" ? body : {}) });
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
