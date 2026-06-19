import { NextResponse } from "next/server";
import { authCookie } from "@/lib/auth";
import { createAuthSession, initDb, loginUser } from "@/lib/db";
import { verifyTurnstile } from "@/lib/turnstile";

export async function POST(request: Request) {
  try {
    initDb();
    const body = await request.json();
    const turnstileToken = String(body.turnstileToken || "");
    if (turnstileToken && !(await verifyTurnstile(turnstileToken))) {
      return NextResponse.json({ message: "安全验证失败，请刷新页面重试。" }, { status: 400 });
    }
    const user = loginUser(String(body.username || ""), String(body.password || ""));
    const session = createAuthSession(user.id);
    const response = NextResponse.json({ user: { id: user.id, username: user.username, role: user.role } });
    response.headers.set("Set-Cookie", authCookie(session.token, session.expiresAt));
    return response;
  } catch (error) {
    console.error("POST /api/auth/login failed", error);
    return NextResponse.json({ message: "用户名或密码错误。" }, { status: 401 });
  }
}
