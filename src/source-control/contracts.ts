import { z } from "zod";
import { validPath } from "../lib/review-logic";

export const objectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().max(512).refine(validPath, "Invalid relative path");
export const changesetInputSchema = z.object({
  apiVersion: z.literal(1),
  parents: z.array(objectIdSchema).max(8).default([]),
  message: z.string().trim().min(1).max(2000),
  operations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("PUT"), path, dataBase64: z.string().max(350_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(), objectId: objectIdSchema.optional(), fileMode: z.enum(["100644", "100755", "120000"]).optional() }),
    z.object({ kind: z.literal("DELETE"), path }),
    z.object({ kind: z.literal("MOVE"), path, previousPath: path }),
  ])).min(1).max(200),
});
export type ChangesetInput = z.infer<typeof changesetInputSchema>;
export type TreeEntry = { path: string; objectId: string; mode?: "100644" | "100755" | "120000" };
export type SourceActor = { id: string; type: "AGENT" | "HUMAN"; credentialId?: string; sessionId?: string; gitCredentialId?: string };
export type FileOperation = {
  kind: "PUT" | "DELETE" | "MOVE";
  path: string;
  previousPath?: string;
  objectId?: string;
  fileMode?: "100644" | "100755" | "120000";
};
export type ChangesetReceipt = { id: string; treeId: string; created: boolean };

export class SourceControlError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
