import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { COOKIE_NAME, sessionIdentity, verifyBrowserOrigin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!verifyBrowserOrigin(req)) return new NextResponse("Invalid request origin", { status: 403 });
  const identity = await sessionIdentity(req);
  if (identity?.sessionId) {
    await db.$transaction(async tx => {
      await tx.humanSession.updateMany({ where: { id: identity.sessionId!, userId: identity.id, revokedAt: null },
        data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: { actorType: "HUMAN", actorId: identity.id, action: "session.logout" } });
    });
  }
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete(COOKIE_NAME);
  return res;
}
