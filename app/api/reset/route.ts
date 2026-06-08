import { NextResponse } from "next/server";
import { clearAbilities, clearAllData, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const { type } = await request.json();
    if (type === "all") {
      clearAllData(user.id);
    } else {
      clearAbilities(user.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ message: "重置失败" }, { status: 500 });
  }
}
