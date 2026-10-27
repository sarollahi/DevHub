import Icon from "./icons";
import type { ReactNode } from "react";
export function RiskBadge({ tier }: { tier: string | null | undefined }) {
  const risk = tier?.toLowerCase() ?? "pending";
  return <span className={`risk-badge risk-${risk}`}><span className="risk-dot"/>{tier ?? "Unscored"}</span>;
}
export function StateBadge({ state }: { state: string }) {
  const type = ["APPROVED", "MERGED", "SUCCESS", "PASSED"].includes(state) ? "success" : ["FAILED", "BLOCKED", "FAILURE", "ERRORED", "TIMED_OUT"].includes(state) ? "danger" : state === "REVIEW_REQUIRED" ? "review" : "neutral";
  return <span className={`state-badge state-${type}`}><span className="badge-dot"/>{({ REVIEW_REQUIRED: "Needs review", QUEUED: "Queued", RUNNING: "Processing", APPROVED: "Approved", FAILED: "Failed", BLOCKED: "Blocked", MERGED: "Merged", SUCCESS: "Passed", PASSED: "Passed", ERRORED: "Runner error", TIMED_OUT: "Timed out", FAILURE: "Failed", PENDING: "Pending", CANCELLED: "Cancelled", CLOSED: "Closed" } as Record<string, string>)[state] ?? state.toLowerCase().replaceAll("_", " ")}</span>;
}
export function InfoNote({ children }: { children: ReactNode }) { return <div className="info-note"><Icon name="info" size={17}/><span>{children}</span></div>; }
