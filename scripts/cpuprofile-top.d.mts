export interface TopSelf {
  totalMs: number;
  rows: Array<{ fn: string; ms: number; pct: number }>;
}
export function topSelf(profile: unknown, count?: number, root?: string): TopSelf;
