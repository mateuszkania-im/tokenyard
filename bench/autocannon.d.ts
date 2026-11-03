// The part of autocannon's API the overhead benchmark uses (the package ships no types).
declare module 'autocannon' {
  import type { EventEmitter } from 'node:events';
  interface Options {
    url: string;
    connections: number;
    connectionRate?: number;
    duration: number;
    method: string;
    headers: Record<string, string>;
    body: Buffer | string;
    timeout?: number;
    ignoreCoordinatedOmission?: boolean;
    setupClient?: (client: EventEmitter) => void;
  }
  interface Result {
    errors: number;
    timeouts: number;
    non2xx: number;
  }
  function autocannon(o: Options): Promise<Result>;
  export default autocannon;
}
