export interface RequestLogEntry {
  at: string;
  agentId: string;
  agentName: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** Bounded in-memory request log. Oldest entries are dropped first. */
export class RequestLog {
  private entries: RequestLogEntry[] = [];

  constructor(private readonly capacity = 1000) {}

  add(entry: RequestLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  recent(limit = 100): RequestLogEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
