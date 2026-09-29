import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-token";

/** Clears a session the server no longer accepts (password changed, user deactivated, logged out everywhere). */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
