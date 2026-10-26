import { NextResponse } from "next/server";
// Deliberate fail-closed boundary: no merge until native Git ref validation and coordinator exist.
export async function POST() {
  return NextResponse.json({ error: "MERGE_GATE_NOT_AVAILABLE", message: "Native Git storage and serialized ref updates are not yet installed; approvals cannot mutate branches." }, { status: 501 });
}
