import { NextRequest, NextResponse } from "next/server";
import { adminTokenValid, COOKIE_NAME, secureSessionValue, verifyBrowserOrigin } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  if (!verifyBrowserOrigin(req)) return new NextResponse("Invalid request origin", { status: 403 });
  const form = await req.formData();
  const value = form.get("token");
  if (typeof value !== "string" || !adminTokenValid(value)) return new NextResponse("Invalid admin token", { status: 401 });
  const res = NextResponse.redirect(new URL("/inbox", req.url), 303);
  res.cookies.set(COOKIE_NAME, secureSessionValue(), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 12 });
  return res;
}
