import type { DatabaseSync } from "node:sqlite";
import { globToRegExp } from "../policy/tools.js";

export type UpstreamKind = "openai" | "anthropic";
export const UPSTREAM_KINDS: UpstreamKind[] = ["openai", "anthropic"];

export interface Upstream {
  id: number;
  name: string;
  kind: UpstreamKind;
  baseUrl: string;
  /** Name of the environment variable that holds the provider key. The key itself is never stored. */
  apiKeyEnv: string | null;
  /** Model name patterns this upstream serves, with `*` as a wildcard. */
  models: string[];
  enabled: boolean;
  createdAt: string;
}

export interface Target {
  name: string;
  kind: UpstreamKind;
  baseUrl: string;
  apiKeyEnv: string | null;
}

export interface NewUpstream {
  name: string;
  kind: UpstreamKind;
  baseUrl: string;
  apiKeyEnv?: string | null;
  models: string[];
}

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "fd00:ec2::254",
  "[fd00:ec2::254]",
]);

/**
 * Checks an upstream address an admin typed in. It must be http or https, carry no credentials,
 * and not point at a cloud metadata service, which would leak the host's own credentials.
 * Local and private addresses are allowed on purpose: a local model server is a normal upstream.
 */
export function validateUpstreamUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new Error("baseUrl must be a URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must use http or https");
  if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || /^169\.254\./.test(host))
    throw new Error("baseUrl points at a metadata address, which is not allowed");
  return value.replace(/\/+$/, "");
}

function fromRow(row: any): Upstream {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKeyEnv: row.api_key_env ?? null,
    models: JSON.parse(row.models),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/** Routes a model name to the first enabled upstream whose patterns match it. */
export class UpstreamStore {
  /** The list with each model pattern already compiled. Rebuilt after any change, since routing runs on every request. */
  private compiled: { upstream: Upstream; matchers: RegExp[] }[] | null = null;

  constructor(private readonly db: DatabaseSync) {}

  private load(): { upstream: Upstream; matchers: RegExp[] }[] {
    this.compiled ??= this.db
      .prepare("SELECT * FROM upstreams ORDER BY id")
      .all()
      .map(fromRow)
      .map((upstream) => ({ upstream, matchers: upstream.models.map((pattern) => globToRegExp(pattern)) }));
    return this.compiled;
  }

  create(input: NewUpstream): Upstream {
    const result = this.db
      .prepare(
        "INSERT INTO upstreams (name, kind, base_url, api_key_env, models, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.name,
        input.kind,
        input.baseUrl.replace(/\/+$/, ""),
        input.apiKeyEnv ?? null,
        JSON.stringify(input.models),
        new Date().toISOString(),
      );
    this.compiled = null;
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): Upstream | undefined {
    const row = this.db.prepare("SELECT * FROM upstreams WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list(): Upstream[] {
    return this.load().map((entry) => entry.upstream);
  }

  setEnabled(id: number, enabled: boolean): Upstream | undefined {
    this.db.prepare("UPDATE upstreams SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    this.compiled = null;
    return this.get(id);
  }

  delete(id: number): boolean {
    const removed = this.db.prepare("DELETE FROM upstreams WHERE id = ?").run(id).changes === 1;
    this.compiled = null;
    return removed;
  }

  /** The upstream for a model, or the fallback when none matches. */
  resolve(model: string, fallbackUrl: string): Target {
    for (const { upstream: u, matchers } of this.load()) {
      if (u.enabled && matchers.some((matcher) => matcher.test(model))) {
        return { name: u.name, kind: u.kind, baseUrl: u.baseUrl, apiKeyEnv: u.apiKeyEnv };
      }
    }
    return { name: "default", kind: "openai", baseUrl: fallbackUrl, apiKeyEnv: null };
  }
}
