import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGatewayApp, type GatewayApp, type GatewayOptions } from "../src/gateway/server.js";
import { createMockUpstream, type MockOptions } from "../src/mock/server.js";

export const ADMIN = "test-admin-token";
export const ANTHROPIC_KEY = "test-anthropic-key";

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

export interface ApiResult {
  status: number;
  json: any;
  headers: Headers;
}

export interface Harness {
  base: string;
  mockUrl: string;
  app: GatewayApp;
  close(): void;
  /** Calls an admin route with the given token (the bootstrap owner token by default). */
  admin(path: string, method?: string, body?: unknown, token?: string): Promise<ApiResult>;
  /** Creates an agent as the bootstrap owner and returns its key. */
  newAgent(settings?: Record<string, unknown>): Promise<string>;
  /** Creates an admin user and returns its key. */
  newUser(role: string, team?: string | null): Promise<string>;
  chat(key: string | undefined, content: string, extra?: Record<string, unknown>): Promise<Response>;
}

export interface HarnessOptions {
  gateway?: Partial<GatewayOptions>;
  mock?: MockOptions;
}

/** Starts the mock upstream and a gateway wired to it, both on random ports. */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const mock = createMockUpstream({ anthropicKey: ANTHROPIC_KEY, ...options.mock });
  const mockUrl = await listen(mock);
  const app = createGatewayApp({
    upstreamUrl: mockUrl,
    adminToken: ADMIN,
    env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
    ...options.gateway,
  });
  const base = await listen(app.server);
  let counter = 0;

  const h: Harness = {
    base,
    mockUrl,
    app,
    close() {
      mock.closeAllConnections();
      mock.close();
      app.server.closeAllConnections();
      app.server.close();
    },
    async admin(path, method = "GET", body, token = ADMIN) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* plain text, such as /metrics */
      }
      return { status: res.status, json, headers: res.headers };
    },
    async newAgent(settings = {}) {
      const { json } = await h.admin("/admin/agents", "POST", { name: `agent-${++counter}`, ...settings });
      return json.key as string;
    },
    async newUser(role, team = null) {
      const { json } = await h.admin("/admin/users", "POST", { name: `${role}-${++counter}`, role, team });
      return json.key as string;
    },
    chat(key, content, extra = {}) {
      return fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content }], ...extra }),
      });
    },
  };
  return h;
}
