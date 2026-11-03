// Types for scripts/bench-to-readme.mjs (the script stays plain JavaScript so CI runs it without a build step).
export const BENCH_START: string;
export const BENCH_END: string;
export function renderBenchBlock(results: object): string;
export function writeBenchBlock(readme: string, results: object): string;
export function checkBenchBlock(readme: string, results: object): boolean;
