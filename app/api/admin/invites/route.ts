import { NextResponse } from "next/server";
import { authErrorResponse, requireAdmin } from "@/lib/auth";
import { createInvite, disableInvite, getInvites, initDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    initDb();
    requireAdmin(request);
    return NextResponse.json({ invites: getInvites() });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取邀请码失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    initDb();
    const admin = requireAdmin(request);
    const body = await request.json().catch(() => ({}));
    if (body.action === "disable") {
      disableInvite(Number(body.id));
      return NextResponse.json({ ok: true, invites: getInvites() });
    }
    const invite = createInvite(admin.id, typeof body.expiresAt === "string" ? body.expiresAt : null);
    return NextResponse.json({ invite, invites: getInvites() });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "邀请码操作失败" }, { status: 500 });
  }
}
