// Spec 9.2 step 5: does replaying the base reproduce what was recorded, and is the trace set complete? Pure.
import type { ManifestRecord, TraceRecord } from '../ledger/record.js';

export type MissingKind = 'no-file' | 'seq-gap' | 'heartbeats-stop';
export interface MissingInstance {
  instance: string;
  hours: string[];
  kind: MissingKind;
}

/** A decision as fidelity compares it: action, reason, route and provider order. */
export interface ComparedDecision {
  action: 'forward' | 'block';
  reason: string | null;
  route: string | null;
  chain: string[];
}

const HOUR_MS = 3_600_000;
/** Heartbeats come every 60 s; one missed beat plus slack before a silent instance counts as stopped. */
export const HEARTBEAT_GRACE_MS = 120_000;
const KIND_ORDER: readonly MissingKind[] = ['no-file', 'seq-gap', 'heartbeats-stop'];

const hourLabel = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/** Every UTC hour label from the hour of `fromMs` to the hour of `toMs`, both included. */
function hoursBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let h = Math.floor(fromMs / HOUR_MS) * HOUR_MS; h <= toMs; h += HOUR_MS) out.push(hourLabel(h));
  return out;
}

const describe = (d: ComparedDecision): string => (d.action === 'forward' ? 'forward' : `block (${d.reason ?? 'unknown'})`);

/** Null when the replayed decision reproduces the recorded one; else the disagreement reason, in words. */
export function disagreement(recorded: ComparedDecision, replayed: ComparedDecision): string | null {
  if (recorded.action !== replayed.action || recorded.reason !== replayed.reason) return `recorded ${describe(recorded)}, replayed ${describe(replayed)}`;
  if (recorded.route !== replayed.route) return `recorded route ${recorded.route ?? '(none)'}, replayed route ${replayed.route ?? '(none)'}`;
  if (recorded.chain.join(',') !== replayed.chain.join(',')) return `recorded providers ${recorded.chain.join(', ') || '(none)'}, replayed providers ${replayed.chain.join(', ') || '(none)'}`;
  return null;
}

/**
 * Missing instances (spec 9.2 step 5) from the export manifests: hours an instance ran without a file in the set,
 * sequence gaps (dropped records, located by the records around each gap), and an instance without a shutdown record
 * whose heartbeats stop before the window ends.
 */
export function missingInstances(manifests: readonly ManifestRecord[], records: readonly TraceRecord[]): MissingInstance[] {
  const out = new Map<string, MissingInstance>();
  const add = (instance: string, kind: MissingKind, hours: string[]): void => {
    const k = `${instance}\u0000${kind}`;
    const prev = out.get(k);
    const all = [...new Set([...(prev?.hours ?? []), ...hours])].sort();
    out.set(k, { instance, hours: all, kind });
  };
  const byInstance = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const list = byInstance.get(r.instance) ?? [];
    list.push(r);
    byInstance.set(r.instance, list);
  }
  for (const m of manifests) {
    const untilMs = Date.parse(m.until);
    for (const inst of m.instances) {
      if (inst.hoursWithoutFile.length > 0) add(inst.id, 'no-file', inst.hoursWithoutFile);
      if (inst.seqGaps > 0) {
        const seen = [...(byInstance.get(inst.id) ?? [])].sort((a, b) => a.seq - b.seq);
        const hours: string[] = [];
        for (let i = 1; i < seen.length; i++) {
          const a = seen[i - 1] as TraceRecord;
          const b = seen[i] as TraceRecord;
          if (b.seq - a.seq <= 1) continue;
          const [x, y] = [Date.parse(a.ts), Date.parse(b.ts)].sort((p, q) => p - q) as [number, number];
          hours.push(...hoursBetween(x, y));
        }
        // A gap at either end of the set cannot be placed between two records: the instance's whole span is named.
        add(inst.id, 'seq-gap', hours.length > 0 ? hours : hoursBetween(Date.parse(inst.firstTs), Date.parse(inst.lastTs)));
      }
      const lastMs = Date.parse(inst.lastTs);
      if (inst.shutdown === false && lastMs < untilMs - HEARTBEAT_GRACE_MS) add(inst.id, 'heartbeats-stop', hoursBetween(lastMs, untilMs - 1));
    }
  }
  return [...out.values()].sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)));
}
