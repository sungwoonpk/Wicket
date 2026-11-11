import { createHash, randomBytes } from "node:crypto";

export interface Agent {
  id: string;
  name: string;
  createdAt: string;
}

interface Record {
  agent: Agent;
  keyHash: string;
}

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * In-memory agent registry. Only a SHA-256 hash of each key is stored, so a key can be
 * shown once at creation and never read back. Persistence comes in a later change.
 */
export class KeyStore {
  private byHash = new Map<string, Record>();
  private nextId = 1;

  create(name: string): { agent: Agent; key: string } {
    const key = `wk_${randomBytes(24).toString("base64url")}`;
    const agent: Agent = { id: `agent_${this.nextId++}`, name, createdAt: new Date().toISOString() };
    this.byHash.set(hash(key), { agent, keyHash: hash(key) });
    return { agent, key };
  }

  authenticate(key: string): Agent | undefined {
    return this.byHash.get(hash(key))?.agent;
  }

  list(): Agent[] {
    return [...this.byHash.values()].map((r) => r.agent);
  }
}
