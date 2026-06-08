import { NextResponse } from "next/server";
import { getAbilities, getAssessmentReportCount, getAssessmentReports, getCapturedDrills, getHistory, getLatestAssessmentReportCreatedAt, getLatestPracticeReport, getMistakes, getRecords, getSettings, getSkillAbilities, getStreak, initDb } from "@/lib/db";
import { authErrorResponse, requireUser } from "@/lib/auth";

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export async function GET(request: Request) {
  try {
    initDb();
    const user = requireUser(request);
    const url = new URL(request.url);
    const assessmentPageSize = clampInt(url.searchParams.get("assessmentPageSize"), 10, 1, 50);
    const assessmentReportTotal = getAssessmentReportCount(user.id);
    const assessmentReportPageCount = Math.max(1, Math.ceil(assessmentReportTotal / assessmentPageSize));
    const assessmentReportPage = clampInt(url.searchParams.get("assessmentPage"), 1, 1, assessmentReportPageCount);
    const assessmentOffset = (assessmentReportPage - 1) * assessmentPageSize;
    const latestAssessmentReport = getAssessmentReports(1, 0, user.id)[0] ?? null;
    const abilities = getAbilities(user.id);
    const capturedDrills = getCapturedDrills(false, user.id);
    return NextResponse.json({
      user: { id: user.id, username: user.username, role: user.role },
      settings: getSettings(user.id),
      abilities,
      skillAbilities: getSkillAbilities(user.id),
      history: getHistory(user.id),
      mistakes: getMistakes(false, user.id),
      capturedDrills,
      capturedDrillCount: capturedDrills.length,
      activeCapturedDrillCount: capturedDrills.filter((item) => item.correct_streak < 2).length,
      records: getRecords(user.id),
      latestPracticeReport: getLatestPracticeReport("每日练习", user.id),
      assessmentReports: getAssessmentReports(assessmentPageSize, assessmentOffset, user.id),
      assessmentReportPage,
      assessmentReportPageSize: assessmentPageSize,
      assessmentReportTotal,
      assessmentReportPageCount,
      latestAssessmentReport,
      latestAssessmentAt: getLatestAssessmentReportCreatedAt(user.id),
      streak: getStreak(user.id),
      needsAssessment: abilities.every((item) => item.evidence_count === 0)
    });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ message: "读取状态失败" }, { status: 500 });
  }
}
