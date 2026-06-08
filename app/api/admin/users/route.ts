import { NextResponse } from "next/server";
import { authErrorResponse, requireAdmin } from "@/lib/auth";
import { AuthError, disableUser, initDb, listUsers, resetUserPassword } from "@/lib/db";

export async function GET(request: Request) {
  try {
    initDb();
    requireAdmin(request);
    return NextResponse.json({ users: listUsers() });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取用户失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    initDb();
    requireAdmin(request);
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isFinite(id)) throw new AuthError("用户 id 无效。", 400);
    if (body.action === "disable") {
      disableUser(id);
    } else if (body.action === "reset_password") {
      resetUserPassword(id, String(body.password || ""));
    } else {
      throw new AuthError("未知用户操作。", 400);
    }
    return NextResponse.json({ ok: true, users: listUsers() });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "用户操作失败" }, { status: 500 });
  }
}
