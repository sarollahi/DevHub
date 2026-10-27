import Link from "next/link";
import type { ReactNode } from "react";
import Icon, { type IconName } from "./icons";
import { sessionIdentity } from "@/lib/auth";
import { db } from "@/lib/prisma";

const nav: { title: string; href: string; icon: IconName }[] = [
  { title: "Intelligent review", href: "/reviews", icon: "shield" },
  { title: "Contribution inbox", href: "/inbox", icon: "inbox" },
  { title: "Merge queue", href: "/merge-queue", icon: "git-merge" },
  { title: "Repositories", href: "/repositories", icon: "folder-git" },
  { title: "Agents", href: "/agents", icon: "bot" },
  { title: "Access & security", href: "/access", icon: "shield" },
];
export default async function WorkspaceShell({ active, title, description, children, actions }: { active: string; title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  const actor = await sessionIdentity();
  const profile = actor?.type === "HUMAN" ? await db.user.findUnique({where:{id:actor.id},select:{handle:true,memberships:{take:1,include:{organization:{select:{name:true}}}}}}) : null;
  const displayName = profile?.handle ?? "Workspace";
  const organizationName = profile?.memberships[0]?.organization.name ?? "Personal workspace";
  return <div className="workspace"><a className="repo-skip" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="layers" size={19} /></div><span>DevHub</span></div>
      <div className="workspace-picker"><span className="workspace-avatar">{displayName[0]?.toUpperCase() ?? "D"}</span><span className="workspace-picker-text"><strong>{organizationName}</strong><small>{displayName}</small></span><Icon name="chevron-down" size={15} className="muted" /></div>
      <div className="nav-section-label">WORKSPACE</div>
      <nav className="side-navigation" aria-label="Workspace navigation">{nav.map(item => <Link href={item.href} className={`nav-item${active === item.href ? " active" : ""}`} key={item.href}><Icon name={item.icon} size={17} /><span>{item.title}</span></Link>)}</nav>
      <div className="sidebar-divider"/><div className="nav-section-label">PLATFORM</div>
      <div className="platform-info"><Icon name="shield" size={16}/><div><strong>Source authority</strong><small>Policies enforced server-side</small></div></div>
      <div className="sidebar-footer"><div className="sidebar-user"><div className="user-avatar">{displayName[0]?.toUpperCase() ?? "D"}</div><div><strong>{displayName}</strong><small>{organizationName}</small></div></div><form action="/api/auth/logout" method="post"><button type="submit" className="signout-button">Sign out</button></form></div>
    </aside>
    <div className="workspace-main"><header className="global-topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="chevron-right" size={14} /><strong>{title}</strong></div><div className="topbar-right"><Link href="/repositories" className="text-link">Repositories</Link><span className="topbar-divider"/><div className="topbar-avatar">{displayName[0]?.toUpperCase() ?? "D"}</div></div></header>
      <main className="main-content" id="main-content"><div className="page-heading"><div><p className="page-kicker">DEVELOPER WORKSPACE</p><h1>{title}</h1><p className="page-description">{description}</p></div><div className="heading-actions">{actions}</div></div>{children}</main>
      <footer className="page-footer"><span>DevHub <span className="footer-separator">/</span> Built for human and agent contributions</span><span>Secure source-control workspace</span></footer>
    </div>
  </div>;
}
