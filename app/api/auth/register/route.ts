import { NextResponse } from "next/server";
import { authCookie } from "@/lib/auth";
import { AuthError, createAuthSession, initDb, registerWithInvite } from "@/lib/db";

export async function POST(request: Request) {
  try {
    initDb();
    const body = await request.json();
    const user = registerWithInvite(String(body.username || ""), String(body.password || ""), String(body.inviteCode || ""));
    const session = createAuthSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, username: user.username, role: user.role } });
    response.headers.set("Set-Cookie", authCookie(session.token, session.expiresAt));
    return response;
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ message: error instanceof Error ? error.message : "注册失败。" }, { status });
  }
}
