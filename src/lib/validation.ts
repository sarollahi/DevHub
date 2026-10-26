import { z } from "zod";
import { validPath } from "./review-logic";

const branch = z.string().min(1).max(255).regex(/^(?!\/|.*(?:\.\.|\/\/|@\{|[ ~^:?*\[\\]|\.$|\.lock$))[\w.\-/]+$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
export const createPullRequestInput = z.object({
  repository: z.string().regex(/^[a-zA-Z0-9-]{1,80}\/[a-zA-Z0-9_.-]{1,80}$/),
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).default(""),
  sourceBranch: branch,
  sourceSha: commitSha,
  targetBranch: branch,
  targetSha: commitSha,
  changedFiles: z.array(z.string().refine(validPath)).min(1).max(200),
  patch: z.string().min(1).max(65_536),
}).refine((p) => p.sourceBranch !== p.targetBranch, "Source branch and target branch must differ");
