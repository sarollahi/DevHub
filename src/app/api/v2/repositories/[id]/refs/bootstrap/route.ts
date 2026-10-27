import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { bootstrapProtectedBranch } from "@/integration/bootstrap";
export const runtime = "nodejs";
const input = z.object({
  name: z.string().min(1).max(200),
  changesetId: z.string().regex(/^[a-f0-9]{64}$/),
  mutationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/),
}).strict();
export async function POST(request: NextRequest, { params }: {params:Promise<{id:string}>}) {
  try {
    const { id } = await params;
    const value = input.parse(await readBoundedJson(request,2048));
    const { actor } = await requireRepositoryAccess(request,id,"admin",true);
    const result = await bootstrapProtectedBranch(id,actor,value);
    return NextResponse.json({apiVersion:2,...result},{status:result.replayed?200:201});
  }catch(error){return sourceFailure(error);}
}
