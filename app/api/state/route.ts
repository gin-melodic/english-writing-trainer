import { NextResponse } from "next/server";
import { getAbilities, getHistory, getMistakes, getRecords, getSettings, getStreak, initDb } from "@/lib/db";

export async function GET() {
  initDb();
  const abilities = getAbilities();
  return NextResponse.json({
    settings: getSettings(),
    abilities,
    history: getHistory(),
    mistakes: getMistakes(false),
    records: getRecords(),
    streak: getStreak(),
    needsAssessment: abilities.every((item) => item.score === 0)
  });
}
