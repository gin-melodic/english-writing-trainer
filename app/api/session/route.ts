import { NextResponse } from "next/server";
import { createSession, endSession, initDb } from "@/lib/db";

export async function POST(request: Request) {
  initDb();
  const { action, mode, total, sessionId } = await request.json();
  if (action === "end") {
    endSession(Number(sessionId));
    return NextResponse.json({ ok: true });
  }
  const id = createSession(String(mode || "每日练习"), Number(total || 20));
  return NextResponse.json({ id });
}
