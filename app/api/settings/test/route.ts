import { NextResponse } from "next/server";
import { getSettings, initDb } from "@/lib/db";
import { testConnection } from "@/lib/llm";

export async function POST() {
  try {
    initDb();
    const result = await testConnection(getSettings());
    return NextResponse.json({ ok: true, models: result.data ?? [] });
  } catch (error) {
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : "连接失败" }, { status: 500 });
  }
}
