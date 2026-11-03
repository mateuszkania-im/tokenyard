// Types for scripts/local-redis.mjs.
export function redisRunArgs(name: string, password: string): string[];
export function hostPort(output: string): number;
export function localRedisUrl(port: number, password: string): string;
export function startLocalRedis(): { url: string; started: boolean; stop(): void };
export function isLoopbackRedisUrl(url: string): boolean;
