import { logoutResponse } from "@/lib/auth";
import { initDb } from "@/lib/db";

export async function POST(request: Request) {
  initDb();
  return logoutResponse(request);
}
