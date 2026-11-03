export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Longest line the parser holds, and the most data one event may hold, in UTF-8 bytes (S-V4-1). A Responses
 * `response.completed` event carries the whole response on one `data:` line, so the cap is far above any real event;
 * a longer line or event is dropped (the usage it may hold is then missing, and the gateway settles at the
 * reservation), instead of growing without bound; `droppedEvents` counts them, so the trace can say so.
 * Why 16 MiB and not the JSON body cap (`bodyCapBytes`, 32 MiB by default): the JSON cap bounds a whole answer the
 * gateway holds once; this one bounds a single event, and while one is parsed the stream holds its pieces, their
 * concatenation and the decoded string (up to about three times the cap), so 16 MiB keeps a stream's peak near the
 * JSON path's while staying hundreds of times above a real event. It is fixed, not tied to `bodyCapBytes`, because a
 * smaller body cap (for small requests) must not start dropping long answers.
 */
export const MAX_SSE_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Incremental Server-Sent Events parser. Keeps the bytes of the unfinished line and decodes UTF-8 only per complete
 * line, so multi-byte characters split across chunks are never corrupted. Accepts CRLF, LF and CR line ends. Each
 * byte is looked at once, whatever the chunk sizes (S-V4-1: the unfinished line was copied and rescanned on every
 * chunk, so a long line in small chunks took quadratic time).
 */
export class SseParser {
  private readonly maxLineBytes: number;
  /** Pieces of the unfinished line, and their total length. */
  private parts: Buffer[] = [];
  private partBytes = 0;
  /** The unfinished line passed the cap: its bytes are dropped, and so is the event it belongs to. */
  private overflow = false;
  private event: string | null = null;
  private data: string[] = [];
  private hasData = false;
  /** UTF-8 bytes in `data` (with one per line break): an event's data is held to the same cap as one line. */
  private dataBytes = 0;
  /** The current event lost a line to the cap, or its data passed it; it is not dispatched. */
  private broken = false;
  /** Events dropped because a line or their data passed the cap. */
  private dropped = 0;
  private skipLf = false;

  constructor(o: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = o.maxLineBytes ?? MAX_SSE_LINE_BYTES;
  }

  /** Events dropped so far because a line or their data passed the cap. */
  get droppedEvents(): number {
    return this.dropped;
  }

  /** Bytes held for the unfinished line (never more than the cap). */
  pendingBytes(): number {
    return this.partBytes;
  }

  push(chunk: Buffer): SseEvent[] {
    const out: SseEvent[] = [];
    let i = 0;
    if (this.skipLf && chunk.length > 0) {
      if (chunk[0] === 0x0a) i = 1;
      this.skipLf = false;
    }
    let start = i;
    while (i < chunk.length) {
      const b = chunk[i];
      if (b !== 0x0a && b !== 0x0d) {
        i++;
        continue;
      }
      this.finishLine(chunk, start, i, out);
      if (b === 0x0d) {
        // CR at the end of the chunk: an LF may start the next one; it belongs to this line end.
        if (i + 1 >= chunk.length) this.skipLf = true;
        else if (chunk[i + 1] === 0x0a) i++;
      }
      i++;
      start = i;
    }
    if (start < chunk.length) this.hold(chunk.subarray(start));
    return out;
  }

  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.partBytes > 0 || this.overflow) this.finishLine(Buffer.alloc(0), 0, 0, out);
    // An event not terminated by a blank line is dropped, as the SSE spec requires.
    this.reset();
    return out;
  }

  /** Keeps a piece of the unfinished line (copied: the caller may reuse its buffer), up to the cap. */
  private hold(piece: Buffer): void {
    if (this.overflow) return;
    if (this.partBytes + piece.length > this.maxLineBytes) {
      this.parts = [];
      this.partBytes = 0;
      this.overflow = true;
      return;
    }
    this.parts.push(Buffer.from(piece));
    this.partBytes += piece.length;
  }

  /** The line made of the held pieces and `chunk[start, end)` is complete. */
  private finishLine(chunk: Buffer, start: number, end: number, out: SseEvent[]): void {
    if (!this.overflow && this.partBytes + (end - start) > this.maxLineBytes) this.overflow = true;
    if (this.overflow) {
      this.parts = [];
      this.partBytes = 0;
      this.overflow = false;
      this.markBroken();
      return;
    }
    let text: string;
    if (this.parts.length === 0) text = chunk.toString('utf8', start, end);
    else {
      this.parts.push(chunk.subarray(start, end));
      text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.partBytes = 0;
    }
    this.line(text, out);
  }

  private reset(): void {
    this.event = null;
    this.data = [];
    this.hasData = false;
    this.dataBytes = 0;
    this.broken = false;
  }

  private markBroken(): void {
    if (!this.broken) this.dropped++;
    this.broken = true;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.hasData && !this.broken) out.push({ event: this.event, data: this.data.join('\n') });
      this.reset();
      return;
    }
    if (line.startsWith(':')) return;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.hasData = true;
      if (this.broken) return;
      this.dataBytes += Buffer.byteLength(value, 'utf8') + 1;
      if (this.dataBytes > this.maxLineBytes) {
        this.data = [];
        this.markBroken();
        return;
      }
      this.data.push(value);
    }
  }
}
