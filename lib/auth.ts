import { NextResponse } from "next/server";
import { AuthError, SessionUser, deleteAuthSession, getSessionUser, initDb } from "./db";

export const AUTH_COOKIE = "trainer_session";

export function readAuthToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(AUTH_COOKIE.length + 1)) : undefined;
}

export function authCookie(token: string, expiresAt: string) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearAuthCookie() {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function requireUser(request: Request): SessionUser {
  initDb();
  const user = getSessionUser(readAuthToken(request));
  if (!user) throw new AuthError("请先登录。", 401);
  return user;
}

export function requireAdmin(request: Request): SessionUser {
  const user = requireUser(request);
  if (user.role !== "admin") throw new AuthError("需要管理员权限。", 403);
  return user;
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ message: error.message }, { status: error.status });
  }
  return undefined;
}

export function logoutResponse(request: Request) {
  deleteAuthSession(readAuthToken(request));
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearAuthCookie());
  return response;
}
