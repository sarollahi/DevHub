import { NextRequest, NextResponse } from "next/server";
import { verifyBrowserOrigin } from "@/lib/auth";
export async function POST(req: NextRequest) {
  if (!verifyBrowserOrigin(req)) return new NextResponse("Invalid request origin", { status: 403 });
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete("devhub_admin");
  return res;
}
