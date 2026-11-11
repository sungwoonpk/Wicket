import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";
import { ADMIN_OPERATION_COUNT } from "../src/gateway/admin.js";
import { ADMIN, harness, type Harness } from "./helpers.js";

const spec: any = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"];

interface Operation {
  method: string;
  path: string;
  doc: any;
}

const operations: Operation[] = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ method, path, doc: item[method] })),
);
const isAdmin = (op: Operation) => op.path.startsWith("/admin/") || op.path === "/metrics";
const concrete = (path: string) => path.replace("{id}", "1");

describe("OpenAPI file", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("documents as many admin operations as the server has", () => {
    // Approve and deny share one route in the server but are two documented operations.
    const SHARED_ROUTES = 1;
    const documented = operations.filter(isAdmin).length;
    assert.equal(
      documented,
      ADMIN_OPERATION_COUNT + SHARED_ROUTES,
      "a route was added or removed without updating docs/openapi.yaml",
    );
  });

  it("describes only routes the server really has", async () => {
    for (const op of operations) {
      const res = await fetch(`${h.base}${concrete(op.path)}`, {
        method: op.method.toUpperCase(),
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: op.method === "get" ? undefined : "{}",
      });
      const body: any = await res.json().catch(() => ({}));
      const label = `${op.method.toUpperCase()} ${op.path}`;
      assert.notEqual(res.status, 405, `${label} is documented but the method is not allowed`);
      assert.ok(
        !(res.status === 404 && body?.error?.message === "not found"),
        `${label} is documented but does not exist`,
      );
      assert.notEqual(res.status, 500, `${label} crashed`);
    }
  });

  it("states the minimum role for every admin operation", () => {
    for (const op of operations.filter(isAdmin)) {
      assert.ok(
        ["viewer", "approver", "admin", "owner"].includes(op.doc["x-min-role"]),
        `${op.method} ${op.path} has no x-min-role`,
      );
    }
  });

  it("refuses a caller whose role is below the documented minimum", async () => {
    const keys: Record<string, string> = {
      viewer: await h.newUser("viewer"),
      approver: await h.newUser("approver"),
      admin: await h.newUser("admin"),
    };
    const below: Record<string, string | undefined> = {
      viewer: undefined,
      approver: "viewer",
      admin: "approver",
      owner: "admin",
    };
    let checked = 0;
    for (const op of operations.filter(isAdmin)) {
      const lower = below[op.doc["x-min-role"]];
      if (!lower) continue;
      const res = await fetch(`${h.base}${concrete(op.path)}`, {
        method: op.method.toUpperCase(),
        headers: { authorization: `Bearer ${keys[lower]}`, "content-type": "application/json" },
        body: op.method === "get" ? undefined : "{}",
      });
      assert.equal(
        res.status,
        403,
        `${op.method.toUpperCase()} ${op.path} should need the ${op.doc["x-min-role"]} role`,
      );
      checked++;
    }
    assert.ok(checked >= 15, "the check should cover many operations");
  });

  it("marks agent routes as using an agent key and the rest as using an admin key", () => {
    for (const op of operations) {
      if (["/v1/chat/completions", "/v1/approvals/{id}"].includes(op.path))
        assert.deepEqual(op.doc.security, [{ agentKey: [] }], op.path);
      else if (isAdmin(op)) assert.equal(op.doc.security, undefined, `${op.path} uses the default admin key`);
    }
  });

  it("only refers to schemas, parameters and responses that exist", () => {
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) k === "$ref" ? refs.push(v as string) : walk(v);
      }
    };
    walk(spec);
    for (const ref of refs) {
      const target = ref
        .replace(/^#\//, "")
        .split("/")
        .reduce((n: any, key) => n?.[key], spec);
      assert.ok(target !== undefined, `${ref} does not resolve`);
    }
  });

  it("has no description that a comma split into a key with no value", () => {
    const empties: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (v === null && !k.startsWith("x-")) empties.push(`${path}/${k}`);
          walk(v, `${path}/${k}`);
        }
      }
    };
    walk(spec, "");
    assert.deepEqual(empties, []);
  });
});
