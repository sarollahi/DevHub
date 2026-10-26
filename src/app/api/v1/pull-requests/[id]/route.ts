import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest(request))) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;
  const item = await db.pullRequest.findUnique({ where: { id }, include: { checks: true, fingerprints: true } });
  if (!item) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(item);
}
