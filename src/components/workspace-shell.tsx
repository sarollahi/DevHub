import Link from "next/link";
import type { ReactNode } from "react";
import Icon, { type IconName } from "./icons";

const nav: { title: string; href: string; icon: IconName }[] = [
  { title: "Intelligent review", href: "/reviews", icon: "shield" },
  { title: "Contribution inbox", href: "/inbox", icon: "inbox" },
  { title: "Merge queue", href: "/merge-queue", icon: "git-merge" },
  { title: "Repositories", href: "/repositories", icon: "folder-git" },
  { title: "Agents", href: "/agents", icon: "bot" },
  { title: "Access & security", href: "/access", icon: "shield" },
];
export default function WorkspaceShell({ active, title, description, children, actions }: { active: string; title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  return <div className="workspace">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="layers" size={19} /></div><span>DevHub</span><span className="brand-beta">BETA</span></div>
      <div className="workspace-picker"><span className="workspace-avatar">S</span><span className="workspace-picker-text"><strong>sarollahi</strong><small>Developer workspace</small></span><Icon name="chevron-down" size={15} className="muted" /></div>
      <div className="nav-section-label">WORKSPACE</div>
      <nav className="side-navigation" aria-label="Workspace navigation">{nav.map(item => <Link href={item.href} className={`nav-item${active === item.href ? " active" : ""}`} key={item.href}><Icon name={item.icon} size={17} /><span>{item.title}</span>{item.href === "/merge-queue" && <span className="small-pill">Soon</span>}</Link>)}</nav>
      <div className="sidebar-divider"/><div className="nav-section-label">PLATFORM</div>
      <div className="platform-info"><span className="health-indicator" /><div><strong>Processing pipeline</strong><small>Database-backed workload</small></div></div>
      <div className="sidebar-footer"><div className="sidebar-user"><div className="user-avatar">S</div><div><strong>Signed-in developer</strong><small>Administrator</small></div></div><form action="/api/auth/logout" method="post"><button type="submit" className="signout-button">Sign out</button></form></div>
    </aside>
    <div className="workspace-main"><header className="global-topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="chevron-right" size={14} /><strong>{title}</strong></div><div className="topbar-right"><span className="topbar-tag"><span className="green-dot"/> Local environment</span><span className="topbar-divider"/><div className="topbar-avatar">S</div></div></header>
      <main className="main-content"><div className="page-heading"><div><p className="page-kicker">DEVELOPER WORKSPACE</p><h1>{title}</h1><p className="page-description">{description}</p></div><div className="heading-actions">{actions}</div></div>{children}</main>
      <footer className="page-footer"><span>DevHub <span className="footer-separator">/</span> Built for human and agent contributions</span><span>Milestone 1 · Preview</span></footer>
    </div>
  </div>;
}
