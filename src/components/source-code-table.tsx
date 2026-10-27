import Link from "next/link";
import { repoHref } from "@/lib/repository-workspace";

type Line = { number: number; text: string; changesetId?: string | null };
const keywords = /\b(import|export|const|let|var|return|if|else|class|interface|type|function|async|await|new|from|public|private|def|fn|use|package|struct|enum|impl|true|false|null|undefined)\b/g;
function highlight(text: string) {
  // Render as text nodes only; never execute repository content as HTML.
  const pieces = text.split(keywords);
  return pieces.map((part, index) => keywords.source && /^(import|export|const|let|var|return|if|else|class|interface|type|function|async|await|new|from|public|private|def|fn|use|package|struct|enum|impl|true|false|null|undefined)$/.test(part)
    ? <span key={index} className="syntax-keyword">{part}</span>
    : <span key={index}>{part}</span>);
}
export function SourceCodeTable({ id, path, revision, lines, blame = false }: {
  id: string; path: string; revision: string; lines: Line[]; blame?: boolean;
}) {
  return <div className="code-scroll" role="region" aria-label={blame ? "File blame" : "File contents"} tabIndex={0}>
    <table className="source-code-table"><tbody>{lines.map(line => <tr key={line.number} id={"L" + line.number}>
      {blame && <td className="code-attribution">{line.changesetId ?
        <Link title={line.changesetId} href={repoHref(id, "history", { revision: line.changesetId, path })}>{line.changesetId.slice(0, 9)}</Link> : "Unknown"}</td>}
      <th scope="row"><a href={"#L" + line.number} aria-label={"Line " + line.number}>{line.number}</a></th>
      <td><code>{highlight(line.text) || " "}</code></td>
    </tr>)}</tbody></table>
  </div>;
}
