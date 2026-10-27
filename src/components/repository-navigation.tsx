import Link from "next/link";
import WorkspaceShell from "@/components/workspace-shell";
import { repoHref } from "@/lib/repository-workspace";
import type { ReactNode } from "react";

const sections = [
  ["browse", "Files"], ["history", "History"], ["search", "Search"], ["compare", "Compare"],
  ["reviews", "Reviews"], ["checks", "Checks"], ["integrations", "Integrations"],
  ["agents", "Agents"], ["settings", "Settings"],
] as const;

export default function RepositoryNavigation({ id, label, title, description, active, children, actions }:
  { id: string; label: string; title: string; description: string; active: string; children: ReactNode; actions?: ReactNode }) {
  return <WorkspaceShell active="/repositories" title={title} description={description} actions={actions}>
    <div className="repo-identity"><Link href="/repositories">Repositories</Link><span aria-hidden="true">/</span><strong>{label}</strong></div>
    <nav className="repo-navigation" aria-label="Repository sections">
      {sections.map(([path, text]) => <Link key={path} href={repoHref(id, path)}
        aria-current={path === active ? "page" : undefined} className={path === active ? "selected" : ""}>{text}</Link>)}
    </nav>
    {children}
  </WorkspaceShell>;
}
