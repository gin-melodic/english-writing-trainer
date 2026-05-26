import { NextResponse } from "next/server";
import { clearAbilities, clearAllData, initDb } from "@/lib/db";

export async function POST(request: Request) {
  initDb();
  const { type } = await request.json();
  if (type === "all") {
    clearAllData();
  } else {
    clearAbilities();
  }
  return NextResponse.json({ ok: true });
}
