import type { ReactNode } from 'react';

/**
 * Minimal, dependency-free Markdown for agent replies: headings, lists, fenced code, tables, bold, inline code.
 * Builds React elements (never innerHTML), so agent output cannot inject markup.
 */
export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      out.push(<pre key={out.length} className="my-2 overflow-x-auto rounded-md border border-line bg-ink p-3 text-[11.5px] leading-relaxed">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const size = ['', 'text-[16px]', 'text-[14.5px]', 'text-[13px]', 'text-[12.5px]'][h[1].length];
      out.push(<div key={out.length} className={`${size} mb-1.5 mt-3 font-bold text-kin first:mt-0`}>{inline(h[2])}</div>);
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // separator row
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
      }
      out.push(
        <div key={out.length} className="my-2 overflow-x-auto">
          <table className="border-collapse text-[11.5px]">
            <tbody>{rows.map((r, ri) => (
              <tr key={ri} className={ri === 0 ? 'bg-raise font-bold' : ''}>{r.map((c, ci) => <td key={ci} className="border border-line px-2.5 py-1">{inline(c)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: ReactNode[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(<li key={items.length} style={{ marginLeft: m[1].length * 6 }}>{inline(m[3])}</li>);
      }
      out.push(ordered
        ? <ol key={out.length} className="my-1 list-decimal space-y-0.5 pl-5">{items}</ol>
        : <ul key={out.length} className="my-1 list-disc space-y-0.5 pl-5 marker:text-accent">{items}</ul>);
      continue;
    }
    if (!l.trim()) { out.push(<div key={out.length} className="h-2" />); i++; continue; }
    out.push(<p key={out.length} className="whitespace-pre-wrap break-words">{inline(l)}</p>);
    i++;
  }
  return <div className="text-[12.5px] leading-relaxed">{out}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={i} className="rounded bg-ink px-1 py-px text-[11.5px] text-accent">{p.slice(1, -1)}</code>;
    if (p.startsWith('**') && p.endsWith('**') && p.length > 3) return <strong key={i} className="font-bold">{p.slice(2, -2)}</strong>;
    return p;
  });
}
