import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session-token";

const PUBLIC = ["/login", "/signup", "/i/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/signout") return NextResponse.next();
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  if (!session && !isPublic) return NextResponse.redirect(new URL("/login", req.url));
  if (session && isPublic && !pathname.startsWith("/i/")) return NextResponse.redirect(new URL("/home", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/|favicon.ico|api/health).*)"] };
