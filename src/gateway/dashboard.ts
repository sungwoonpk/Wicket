import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

const DIR = new URL("./dashboard/", import.meta.url);

interface Asset {
  body: Buffer;
  type: string;
}

const load = (file: string, type: string): Asset => ({ body: readFileSync(new URL(file, DIR)), type });

/** The dashboard is three static files read once at start-up. Nothing in them is generated per request. */
const ASSETS: Record<string, Asset> = {
  "/dashboard": load("index.html", "text/html; charset=utf-8"),
  "/dashboard/app.js": load("app.js", "text/javascript; charset=utf-8"),
  "/dashboard/app.css": load("app.css", "text/css; charset=utf-8"),
};

/**
 * Only same-origin scripts and styles may run, nothing may frame the page, and the page may talk
 * only to the gateway that served it.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function serveDashboard(res: ServerResponse, pathname: string): boolean {
  const asset = ASSETS[pathname.replace(/\/+$/, "") || "/"];
  if (!asset) return false;
  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": asset.body.length,
    "content-security-policy": CSP,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(asset.body);
  return true;
}
