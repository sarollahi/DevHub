"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RiskBadge } from "@/components/status";

type Item = {
  id: string; repositoryId: string; title: string; author: string; repository: string; createdAt: string;
  state: string; riskTier: string | null; riskScore: number | null; groupKey: string | null;
  paths: string[]; duplicateOf: string | null; relatedCount: number; candidateCount: number; relatedTruncated: boolean; approved: boolean;
  summary: string | null; latencyMs: number | null; confidence: number | null;
};
// Only deterministic risk, verified exact duplicates and failure state affect priority.
// Advisory semantic neighbors and model confidence never elevate a change above security work.
const priority = (item: Item) => (item.riskScore ?? 0) * 3 +
  (item.state === "FAILED" ? 120 : 0) +
  (item.duplicateOf ? 35 : 0) + (item.approved ? -500 : 0);
function Badge({ state }: { state: string }) {
  return <span className={"review-pill " + state.toLowerCase().replaceAll("_", "-")}>{state.replaceAll("_"," ").toLowerCase()}</span>;
}
export default function ReviewBoard({ items }: { items: Item[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "attention" | "duplicates" | "unreviewed">("all");
  const [cursor, setCursor] = useState(0);
  const visible = useMemo(() => items.filter(i =>
    (filter === "all" || filter === "attention" && (i.riskTier === "HIGH" || i.riskTier === "CRITICAL" || i.state === "FAILED")
      || filter === "duplicates" && !!i.duplicateOf
      || filter === "unreviewed" && !i.approved)
    && (i.title + " " + i.repository + " " + i.paths.join(" ")).toLowerCase().includes(query.toLowerCase())
  ).sort((a,b)=>priority(b)-priority(a)), [items, filter, query]);
  const groups = useMemo(() => {
    const collected = new Map<string, Item[]>();
    for (const item of visible) {
      const label = item.groupKey || "pending";
      collected.set(label, [...(collected.get(label) || []), item]);
    }
    return [...collected.values()].sort((a,b)=>Math.max(...b.map(priority))-Math.max(...a.map(priority)));
  }, [visible]);
  const ordered = groups.flat();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(i=>Math.min(i+1, ordered.length-1)); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(i=>Math.max(0,i-1)); }
      if (e.key === "Enter" && ordered[cursor]) { e.preventDefault(); router.push("/reviews/"+ordered[cursor].id); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cursor, ordered, router]);
  const tabs = [{ id:"all",label:"All" },{ id:"attention",label:"Needs attention" },
    { id:"duplicates",label:"Exact duplicates" },{ id:"unreviewed",label:"Unapproved" }] as const;
  return <section className="surface-card native-board">
    <div className="inbox-tabs" role="tablist" aria-label="Review filters">
      {tabs.map(t=><button type="button" role="tab" key={t.id} aria-selected={filter===t.id}
        className={"inbox-tab"+(filter===t.id?" selected":"")} onClick={()=>{setFilter(t.id);setCursor(0);}}>{t.label}</button>)}
    </div>
    <div className="table-toolbar"><div className="search-control"><input type="search" aria-label="Search native reviews" value={query}
      placeholder="Search descriptions, paths, repositories" onChange={e=>{setQuery(e.target.value);setCursor(0);}}/></div>
      <span className="review-shortcuts">j / k navigate · Enter opens</span></div>
    {groups.length ? <div className="review-groups">{groups.map((group, groupIndex) => <section className="review-group" key={group[0].groupKey||"pending"}>
      <div className="review-group-heading"><div><strong>{group[0].paths[0]?.split("/")[0] || "Awaiting inspection"}</strong>
        <span>{group.length} change{group.length === 1 ? "" : "s"} · {new Set(group.flatMap(g=>g.paths)).size} touched paths</span></div>
        <span className="review-group-index">Group {groupIndex+1}</span></div>
      {group.map(item => {
        const active = ordered[cursor]?.id === item.id;
        return <Link key={item.id} href={"/reviews/"+item.id} className={"review-row"+(active?" keyboard-current":"")}>
          <div className="review-row-main"><strong>{item.title}</strong><span>{item.repository} · {item.paths.length} paths · {item.author}</span>
            <small>{item.summary ?? "Authoritative analysis is queued"}</small></div>
          <div className="review-row-tags"><RiskBadge tier={item.riskTier}/><Badge state={item.state}/>
            {item.duplicateOf && <span className="review-pill duplicate">Exact duplicate</span>}
            {!item.duplicateOf && item.relatedCount > 0 && <span className="review-pill related">{item.relatedCount} related</span>}
            {item.relatedTruncated && <span className="review-pill related">More index matches</span>}
            {item.approved && <span className="review-pill approved">Approved</span>}</div>
        </Link>;
      })}</section>)}</div> :
      <div className="table-empty"><strong>{items.length?"No matches":"No native reviews yet"}</strong><p>{items.length?"Adjust the filters.":"Publish a native changeset and run the review worker."}</p></div>}
    <div className="table-footer"><span>{visible.length} visible · ordered by risk and relationship</span><span>Authoritative persisted results</span></div>
  </section>;
}
