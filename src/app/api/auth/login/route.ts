import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { COOKIE_NAME, generateCredential, passwordDigest, tokenHash, verifyBrowserOrigin, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";
const dummyHash = passwordDigest("not-a-real-user-password");

export async function POST(req: NextRequest) {
  if (!verifyBrowserOrigin(req)) return new NextResponse("Invalid request origin", { status: 403 });
  const form = await req.formData().catch(() => null);
  const email = typeof form?.get("email") === "string" ? String(form.get("email")).trim().toLowerCase() : "";
  const password = typeof form?.get("password") === "string" ? String(form.get("password")) : "";
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(email) || password.length > 256) {
    return new NextResponse("Invalid credentials", { status: 401 });
  }
  const key = tokenHash(email);
  const windowStart = new Date(Math.floor(Date.now() / 300000) * 300000);
  const bucket = await db.loginRateBucket.upsert({
    where: { key_windowStart: { key, windowStart } },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (bucket.count > 12) return new NextResponse("Too many attempts; try later", { status: 429 });
  const user = await db.user.findUnique({ where: { email } });
  const valid = verifyPassword(password, user?.passwordHash ?? dummyHash);
  if (!user || user.disabledAt || !valid) {
    await db.auditEvent.create({ data: { actorType: "AUTH", actorId: key, action: "session.login_denied" } });
    return new NextResponse("Invalid credentials", { status: 401 });
  }
  const token = generateCredential();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await db.$transaction(async tx => {
    await tx.humanSession.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt } });
    await tx.auditEvent.create({ data: { actorType: "HUMAN", actorId: user.id, action: "session.login" } });
  });
  const response = NextResponse.redirect(new URL("/repositories", req.url), 303);
  response.cookies.set(COOKIE_NAME, token, { httpOnly: true, sameSite: "strict",
    secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
  return response;
}
