import { NextResponse } from "next/server";
import { createSession, endSession, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const { action, mode, total, sessionId } = await request.json();
    if (action === "end") {
      endSession(Number(sessionId), user.id);
      return NextResponse.json({ ok: true });
    }
    const id = createSession(String(mode || "每日练习"), Number(total || 20), user.id);
    return NextResponse.json({ id });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ message: "训练记录操作失败" }, { status: 500 });
  }
}
