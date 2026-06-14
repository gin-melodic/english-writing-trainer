import { NextResponse } from "next/server";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { snapshot } from "@/lib/llmQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = requireUser(request);
    return NextResponse.json(snapshot(user.id));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取队列状态失败" }, { status: 500 });
  }
}
