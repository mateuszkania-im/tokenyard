// Renders the README's demo picture: the Markdown the GitHub Action posts (renderMarkdown on the replay of the
// committed demo traces, examples/policy as base and examples/policy-head as head), turned into a GitHub-like HTML page
// and captured by a local headless Chrome in the light and the dark color scheme. No network: the page loads nothing.
//   npx tsx scripts/render-demo-png.ts            (CHROME=<path to the Chrome binary> to override the macOS default)
// Writes docs/demo-comment-light.png and docs/demo-comment-dark.png.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReplayPolicy, openReplayTraces } from '../src/policy-loader/replay-input.js';
import { replay } from '../src/replay/engine.js';
import { renderMarkdown } from '../src/replay/render-markdown.js';

const ROOT = join(import.meta.dirname, '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Sections left collapsed in the picture; the cut sessions stay open. */
const COLLAPSED = ['Rerouted requests by route and request class', 'Blocked requests', 'Fidelity notes', 'How exact is this'];

const inline = (s: string): string =>
  s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

/** The small subset of GitHub Markdown the comment uses: h3, tables, lists, details, bold, code, links, paragraphs. */
export function commentHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  const at = (k: number): string => lines[k] ?? '';
  while (i < lines.length) {
    const l = at(i);
    if (l.startsWith('<!--') || l.trim() === '') {
      i++;
    } else if (l.startsWith('### ')) {
      out.push(`<h3>${inline(l.slice(4))}</h3>`);
      i++;
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && at(i).startsWith('|')) rows.push(at(i++).slice(1, -1).split('|').map((c) => c.trim()));
      const [head = [], , ...body] = rows;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
    } else if (l.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && at(i).startsWith('- ')) items.push(`<li>${inline(at(i++).slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (l.startsWith('<details') || l.startsWith('</details')) {
      const summary = /<summary>(.*)<\/summary>/.exec(l)?.[1];
      out.push(summary !== undefined && !COLLAPSED.includes(summary) ? l.replace('<details>', '<details open>') : l);
      i++;
    } else {
      out.push(`<p>${inline(l)}</p>`);
      i++;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--head:#f6f8fa;--code:#eff1f3}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--head:#151b23;--code:#262c36}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.c{max-width:900px;margin:16px;border:1px solid var(--line);border-radius:6px}
.h{background:var(--head);border-bottom:1px solid var(--line);padding:8px 16px;color:var(--muted);font-size:13px}
.b{padding:4px 16px 12px}
h3{font-size:16px;margin:12px 0 8px}
table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}th{background:var(--head)}
code{background:var(--code);border-radius:4px;padding:1px 4px;font-size:12px}
p{margin:8px 0}ul{margin:4px 0;padding-left:24px}summary{margin:6px 0}a{color:#4493f8}
</style></head><body><div class="c"><div class="h">Local render of the Markdown the Action posts (examples/policy against examples/policy-head, committed demo traces)</div><div class="b">${out.join('\n')}</div></div></body></html>`;
}

async function main(): Promise<void> {
  const policy = (dir: string) => loadReplayPolicy({ source: join(ROOT, dir), headDir: join(ROOT, dir), experimentalSubscription: false });
  const base = await policy('examples/policy');
  const head = await policy('examples/policy-head');
  const result = await replay({ base, head, traces: await openReplayTraces([join(ROOT, 'examples/traces/demo.ndjson.gz')]), sinceMs: null, tenant: null });
  const md = renderMarkdown(result, { baseRev: base.revision.slice(0, 7), headRev: head.revision.slice(0, 7), checkSummary: { errors: 0, warnings: 1 } });
  const tmp = mkdtempSync(join(tmpdir(), 'ty-demo-png-'));
  try {
    const page = join(tmp, 'comment.html');
    writeFileSync(page, commentHtml(md));
    for (const [scheme, value] of [['light', '1'], ['dark', '0']] as const) {
      const png = join(ROOT, 'docs', `demo-comment-${scheme}.png`);
      execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(tmp, 'profile')}`, '--hide-scrollbars',
        `--blink-settings=preferredColorScheme=${value}`, '--force-device-scale-factor=2', '--window-size=940,800',
        `--screenshot=${png}`, pathToFileURL(page).href,
      ], { stdio: 'ignore' });
      console.log(`wrote ${png}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
