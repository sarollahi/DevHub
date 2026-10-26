import type { ReactNode, SVGProps } from "react";
export type IconName = "layers" | "inbox" | "git-pull-request" | "git-merge" | "bot" | "folder-git" | "activity" | "settings" | "search" | "chevron-down" | "chevron-right" | "arrow-up-right" | "arrow-left" | "check-circle" | "clock" | "alert-circle" | "shield" | "filter" | "sliders" | "git-branch" | "users" | "copy" | "more" | "lock" | "list-filter" | "circle-dot" | "panel-left" | "code" | "arrow-right" | "check" | "x" | "info" | "plus" | "external-link" | "refresh" | "command";
const paths: Record<IconName, ReactNode> = {
  layers: <><path d="m12 2-9 5 9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
  inbox: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h5l2 3h4l2-3h5"/></>,
  "git-pull-request": <><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8v7a5 5 0 0 1-5 5h-2m2-9-3 3 3 3"/></>,
  "git-merge": <><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8v3a7 7 0 0 1-7 7H6"/></>,
  bot: <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M9 3h6M8 13h.01M16 13h.01M9 17h6M2 12h2m16 0h2"/></>,
  "folder-git": <><path d="M3 5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="16" r="1"/><path d="M9 13v2a1 1 0 0 0 1 1h4"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M2 12h3m14 0h3M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12"/></>,
  search: <><circle cx="10.8" cy="10.8" r="7"/><path d="m16 16 5 5"/></>,
  "chevron-down": <path d="m6 9 6 6 6-6"/>,
  "chevron-right": <path d="m9 18 6-6-6-6"/>,
  "arrow-up-right": <path d="M7 17 17 7M7 7h10v10"/>,
  "arrow-left": <path d="m12 19-7-7 7-7M5 12h14"/>,
  "check-circle": <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  "alert-circle": <><circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3h.01"/></>,
  shield: <><path d="m12 2 8 4v5c0 5-3 8-8 11-5-3-8-6-8-11V6Z"/><path d="m9 12 2 2 4-4"/></>,
  filter: <path d="M3 5h18l-7 8v5l-4 2v-7Z"/>,
  sliders: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="17" r="2" fill="currentColor" stroke="none"/></>,
  "git-branch": <><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8a6 6 0 0 1-6 6H6"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6m3 10v-2a6 6 0 0 0-2-4"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  "list-filter": <path d="M4 7h16M4 12h12M4 17h8"/>,
  "circle-dot": <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></>,
  "panel-left": <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></>,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>,
  "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  x: <path d="M18 6 6 18M6 6l12 12"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  "external-link": <><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M14 3h7v7m0-7-9 9"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a8 8 0 0 1 14-2l1 5M4 12l1 5a8 8 0 0 0 14-2"/></>,
  command: <><path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2Z"/></>
};
export default function Icon({ name, size = 18, ...rest }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>{paths[name]}</svg>;
}
