import { NextResponse } from "next/server";
import { getAbilities, getAssessmentReportCount, getAssessmentReports, getHistory, getLatestAssessmentReportCreatedAt, getMistakes, getRecords, getSettings, getStreak, initDb } from "@/lib/db";

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function GET(request: Request) {
  initDb();
  const url = new URL(request.url);
  const assessmentPageSize = clampInt(url.searchParams.get("assessmentPageSize"), 10, 1, 50);
  const assessmentReportTotal = getAssessmentReportCount();
  const assessmentReportPageCount = Math.max(1, Math.ceil(assessmentReportTotal / assessmentPageSize));
  const assessmentReportPage = clampInt(url.searchParams.get("assessmentPage"), 1, 1, assessmentReportPageCount);
  const assessmentOffset = (assessmentReportPage - 1) * assessmentPageSize;
  const latestAssessmentReport = getAssessmentReports(1, 0)[0] ?? null;
  const abilities = getAbilities();
  return NextResponse.json({
    settings: getSettings(),
    abilities,
    history: getHistory(),
    mistakes: getMistakes(false),
    records: getRecords(),
    assessmentReports: getAssessmentReports(assessmentPageSize, assessmentOffset),
    assessmentReportPage,
    assessmentReportPageSize: assessmentPageSize,
    assessmentReportTotal,
    assessmentReportPageCount,
    latestAssessmentReport,
    latestAssessmentAt: getLatestAssessmentReportCreatedAt(),
    streak: getStreak(),
    needsAssessment: abilities.every((item) => item.score === 0)
  });
}
