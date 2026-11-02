export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Keeps a byte remainder and decodes
 * UTF-8 only per complete line, so multi-byte characters split across chunks
 * are never corrupted. Accepts CRLF, LF and CR line ends.
 */
export class SseParser {
  private rest: Buffer = Buffer.alloc(0);
  private event: string | null = null;
  private data: string[] = [];
  private hasData = false;
  private skipLf = false;

  push(chunk: Buffer): SseEvent[] {
    const out: SseEvent[] = [];
    let buf = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    let i = 0;
    if (this.skipLf) {
      if (buf.length > 0) {
        if (buf[0] === 0x0a) start = i = 1;
        this.skipLf = false;
      }
    }
    while (i < buf.length) {
      const b = buf[i];
      if (b === 0x0a || b === 0x0d) {
        if (b === 0x0d && i + 1 >= buf.length) {
          // CR at end of chunk: a following LF may arrive next, so handle the line now and skip it.
          this.line(buf.toString('utf8', start, i), out);
          this.skipLf = true;
          start = i + 1;
          i = start;
          break;
        }
        this.line(buf.toString('utf8', start, i), out);
        if (b === 0x0d && buf[i + 1] === 0x0a) i++;
        i++;
        start = i;
      } else {
        i++;
      }
    }
    this.rest = Buffer.from(buf.subarray(start));
    return out;
  }

  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.rest.length > 0) {
      this.line(this.rest.toString('utf8'), out);
      this.rest = Buffer.alloc(0);
    }
    // An event not terminated by a blank line is dropped, as the SSE spec requires.
    this.event = null;
    this.data = [];
    this.hasData = false;
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.hasData) out.push({ event: this.event, data: this.data.join('\n') });
      this.event = null;
      this.data = [];
      this.hasData = false;
      return;
    }
    if (line.startsWith(':')) return;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      this.hasData = true;
    }
  }
}
