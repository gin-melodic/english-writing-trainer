import { NextResponse } from "next/server";
import { getSettings, initDb, setSettings } from "@/lib/db";

export async function GET() {
  initDb();
  return NextResponse.json(getSettings());
}

export async function PUT(request: Request) {
  initDb();
  const body = await request.json();
  setSettings(body);
  return NextResponse.json(getSettings());
}
