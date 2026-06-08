import { NextResponse } from "next/server";
import { getSettings, initDb, setSettings } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    return NextResponse.json(getSettings(user.id));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取设置失败" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const body = await request.json();
    setSettings(body, user.role, user.id);
    return NextResponse.json(getSettings(user.id));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "保存设置失败" }, { status: 500 });
  }
}
