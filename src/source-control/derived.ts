import { assessChange } from "../lib/review-logic";
import type { FileOperation } from "./contracts";

export function deriveChangesetMetadata(operations: FileOperation[]) {
  const paths = [...new Set(operations.flatMap((op) => [op.path, ...(op.previousPath ? [op.previousPath] : [])]))].sort();
  // Structural, path-based risk only; it is not a code execution or security test.
  const result = assessChange(paths, "");
  return { touchedPaths: paths, riskTier: result.riskTier, riskScore: result.riskScore,
    summary: `Verified ${operations.length} file operations over ${paths.length} paths; content-addressed tree integrity checked. ${result.flags.join("; ")}`.trim() };
}
