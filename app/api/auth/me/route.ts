import { NextResponse } from "next/server";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { initDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    return NextResponse.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取登录状态失败" }, { status: 500 });
  }
}
