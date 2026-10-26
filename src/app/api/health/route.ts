import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "ready" });
  } catch {
    return NextResponse.json({ status: "unavailable", database: "unavailable" }, { status: 503 });
  }
}
