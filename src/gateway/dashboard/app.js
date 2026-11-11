"use strict";
/*
 * Wicket dashboard. Plain JavaScript, no framework, no build step.
 * Every value from the server goes into the page with textContent or text nodes, never as HTML.
 */
(() => {
  // ---------------------------------------------------------------- small helpers

  const errors = [];
  window.addEventListener("error", (e) => {
    errors.push(String(e.message));
    document.documentElement.dataset.jsErrors = String(errors.length);
  });
  window.addEventListener("unhandledrejection", (e) => {
    errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason));
    document.documentElement.dataset.jsErrors = String(errors.length);
  });

  /** Creates an element. `on` takes event handlers, `data` takes data attributes, the rest are attributes or properties. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "style") el.style.cssText = value;
      else if (key === "on") for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
      else if (key === "data") for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
      else if (["value", "checked", "disabled", "selected", "hidden", "required", "open"].includes(key)) el[key] = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") el.textContent = v;
      else el.setAttribute(k, String(v));
    }
    append(el, kids);
    return el;
  }

  const ICONS = {
    overview: "M3 12l9-8 9 8M5 10v10h14V10",
    approvals: "M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    agents: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.5-6 8-6s8 2 8 6",
    policy: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6",
    requests: "M4 6h16M4 12h16M4 18h10",
    audit: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2",
    settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2l.4 2.7h4l.4-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
    sun: "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
    moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
    logo: "M5 20V8l7-5 7 5v12M9 20v-6h6v6",
  };
  const icon = (name) => svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, svg("path", { d: ICONS[name] }));

  const usd = (n) => "$" + (n === 0 ? "0.00" : n < 1 ? n.toFixed(4) : n.toFixed(2));
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const stamp = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  const pretty = (value) => JSON.stringify(value, null, 2);
  const ROLE_LEVEL = { viewer: 1, approver: 2, admin: 3, owner: 4 };

  // ---------------------------------------------------------------- state and storage

  const state = {
    token: "",
    me: null,
    teams: [],
    teamFilter: "",
    route: "overview",
    navId: 0,
    page: null,
    timer: null,
    policyScope: null,
    requestFilter: { outcome: "", agent: "", limit: "50" },
    approvalsTab: "pending",
    settingsTab: "users",
    updatedAt: null,
  };

  function store(action, key, value) {
    try {
      if (action === "get") return sessionStorage.getItem(key) || localStorage.getItem(key) || "";
      if (action === "session") sessionStorage.setItem(key, value);
      if (action === "local") localStorage.setItem(key, value);
      if (action === "clearSession") sessionStorage.removeItem(key);
    } catch {
      /* storage can be blocked, the dashboard still works without it */
    }
    return "";
  }

  const can = (role) => state.me && ROLE_LEVEL[state.me.role] >= ROLE_LEVEL[role];
  const allTeams = () => state.me && state.me.team === null;

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  function currentTheme() {
    return document.documentElement.dataset.theme || "auto";
  }

  // ---------------------------------------------------------------- api

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { authorization: "Bearer " + state.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      signOut("That token was not accepted. It may have been disabled.");
      throw new ApiError("unauthorized", 401);
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      const message = (json.error && json.error.message) || "Request failed (" + res.status + ")";
      throw new ApiError(retry ? message + " Try again in " + retry + "s." : message, res.status);
    }
    return json;
  }

  /** Adds the team filter to a list request when someone with access to every team picked one. */
  function scoped(path) {
    if (!state.teamFilter || !allTeams()) return path;
    return path + (path.includes("?") ? "&" : "?") + "team=" + encodeURIComponent(state.teamFilter);
  }

  // ---------------------------------------------------------------- toasts and dialogs

  function toast(message, bad = false) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
      document.body.append(box);
    }
    const t = h("div", { class: "toast" + (bad ? " bad" : ""), text: message });
    box.append(t);
    setTimeout(() => t.remove(), bad ? 6000 : 3500);
  }

  const dialogOpen = () => document.querySelector("dialog[open]") !== null;

  /** A form in a dialog. `onSubmit` may throw to show an error and keep the dialog open. */
  function modal({ title, body, submitLabel = "Save", danger = false, onSubmit, cancelLabel = "Cancel", hideSubmit = false }) {
    return new Promise((resolve) => {
      const error = h("div", { class: "login-error", role: "alert" });
      const submit = h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "submit", text: submitLabel, hidden: hideSubmit });
      const cancel = h("button", { class: "btn", type: "button", text: cancelLabel });
      const form = h("form", { method: "dialog" },
        h("header", {}, h("h2", { text: title })),
        h("div", { class: "body" }, body, error),
        h("footer", {}, cancel, submit));
      const dlg = h("dialog", { "aria-label": title }, form);
      let result = false;
      const done = () => {
        dlg.close();
        dlg.remove();
        resolve(result);
      };
      cancel.addEventListener("click", done);
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = "";
        try {
          const outcome = onSubmit ? await onSubmit() : undefined;
          if (outcome !== false) { result = true; done(); return; }
        } catch (err) {
          error.textContent = err.message;
        }
        submit.disabled = false;
      });
      document.body.append(dlg);
      dlg.showModal();
      const first = dlg.querySelector("input, select, textarea");
      (first || (hideSubmit ? cancel : submit)).focus();
    });
  }

  const confirmDialog = (title, message, confirmLabel, danger = false) =>
    modal({ title, body: h("p", { class: "muted", text: message }), submitLabel: confirmLabel, danger });

  function showSecret(title, note, secret) {
    const code = h("code", { text: secret });
    const copy = h("button", { class: "btn", type: "button", text: "Copy", on: { click: async () => {
      try { await navigator.clipboard.writeText(secret); toast("Copied"); } catch { toast("Copy failed. Select the key and copy it by hand.", true); }
    } } });
    return modal({
      title,
      body: [h("p", { class: "muted", text: note }), h("div", { class: "secret" }, code, copy)],
      submitLabel: "Done",
      cancelLabel: "Close",
      hideSubmit: true,
    });
  }

  // ---------------------------------------------------------------- shared pieces

  const OUTCOMES = {
    ok: ["ok", "Allowed"], redacted: ["warn", "Redacted"], blocked_pii: ["bad", "Blocked: PII"], denied_tool: ["bad", "Tool denied"],
    pending_approval: ["info", "Needs approval"], budget_exceeded: ["bad", "Over budget"], rate_limited: ["warn", "Rate limited"],
    model_denied: ["bad", "Model denied"], upstream_error: ["bad", "Upstream error"], cancelled: ["neutral", "Cancelled"],
  };
  const pill = (outcome) => { const [cls, label] = OUTCOMES[outcome] || ["neutral", outcome]; return h("span", { class: "pill " + cls, text: label }); };
  const actionPill = (action) => ({
    allow: h("span", { class: "pill ok", text: "Allow" }),
    deny: h("span", { class: "pill bad", text: "Deny" }),
    require_approval: h("span", { class: "pill info", text: "Needs approval" }),
  }[action] || h("span", { class: "pill neutral", text: action }));

  const empty = (title, text, action) => h("div", { class: "empty" }, h("strong", { text: title }), text, action ? h("div", {}, action) : null);

  function panel(title, { sub, tools, body, flush } = {}) {
    return h("section", { class: "panel" },
      h("header", {}, h("h2", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, tools ? h("div", { class: "spacer" }, tools) : null),
      flush ? body : h("div", { class: "body" }, body));
  }

  function table(columns, rows, emptyNode) {
    if (rows.length === 0) return emptyNode;
    return h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "", text: c.label })))),
      h("tbody", {}, rows)));
  }

  function field(label, input, hint) {
    return h("label", { class: "field" }, label, input, hint ? h("span", { class: "hint", text: hint }) : null);
  }

  function selectOf(options, value, attrs = {}) {
    const el = h("select", attrs);
    for (const o of options) el.append(h("option", { value: o.value, text: o.label, selected: o.value === value }));
    return el;
  }

  const teamOptions = () => state.teams.map((t) => ({ value: t.id, label: t.name && t.name !== t.id ? t.name + " (" + t.id + ")" : t.id }));

  // ---------------------------------------------------------------- overview

  const GROUPS = [
    { key: "ok", label: "Allowed", outcomes: ["ok"], cls: "ok" },
    { key: "redacted", label: "Redacted", outcomes: ["redacted"], cls: "redacted" },
    { key: "held", label: "Needs approval", outcomes: ["pending_approval"], cls: "held" },
    { key: "blocked", label: "Blocked", outcomes: ["blocked_pii", "denied_tool", "budget_exceeded", "rate_limited", "model_denied"], cls: "blocked" },
    { key: "error", label: "Errors", outcomes: ["upstream_error", "cancelled"], cls: "error" },
  ];

  function trafficChart(buckets) {
    const W = 720, H = 180, left = 34, top = 10, bottom = 22;
    const total = buckets.reduce((n, b) => n + b.total, 0);
    const root = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Requests per hour over the last " + buckets.length + " hours, by outcome" });
    if (total === 0) {
      root.append(svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "axis-text", text: "No traffic in this period yet" }));
      return root;
    }
    const peak = Math.max(...buckets.map((b) => b.total));
    const niceMax = peak <= 4 ? 4 : Math.ceil(peak / 4) * 4;
    const plotH = H - top - bottom;
    const slot = (W - left - 8) / buckets.length;
    for (const frac of [0, 0.5, 1]) {
      const y = top + plotH - plotH * frac;
      root.append(svg("line", { x1: left, x2: W - 8, y1: y, y2: y, class: "grid-line" }));
      root.append(svg("text", { x: left - 6, y: y + 3, "text-anchor": "end", class: "axis-text", text: Math.round(niceMax * frac) }));
    }
    buckets.forEach((b, i) => {
      const x = left + i * slot + 2;
      const g = svg("g", {}, svg("title", { text: new Date(b.bucket).toLocaleString([], { hour: "numeric", month: "short", day: "numeric" }) + ": " + b.total + " requests" }));
      let y = top + plotH;
      for (const group of GROUPS) {
        const n = group.outcomes.reduce((sum, o) => sum + (b.byOutcome[o] || 0), 0);
        if (!n) continue;
        const height = (n / niceMax) * plotH;
        y -= height;
        g.append(svg("rect", { x, y, width: Math.max(slot - 4, 2), height, rx: 1.5, class: "c-" + group.cls }));
      }
      root.append(g);
      if (i % Math.ceil(buckets.length / 6) === 0) {
        root.append(svg("text", { x: x + (slot - 4) / 2, y: H - 6, "text-anchor": "middle", class: "axis-text", text: new Date(b.bucket).toLocaleTimeString([], { hour: "numeric" }) }));
      }
    });
    return root;
  }

  async function mountOverview(box) {
    const frame = h("div", { class: "stack" });
    box.replaceChildren(frame);
    async function draw() {
      const [summary, series, agents, recent] = await Promise.all([
        api(scoped("/admin/summary")), api(scoped("/admin/timeseries?hours=24")), api(scoped("/admin/agents")), api(scoped("/admin/requests?limit=8")),
      ]);
      const verify = allTeams() ? await api("/admin/audit/verify").catch(() => null) : null;
      const s = summary.summary;

      const tiles = h("div", { class: "tiles" },
        h("div", { class: "tile" }, h("div", { class: "label", text: "Requests" }), h("div", { class: "value", text: s.requests.toLocaleString() })),
        h("div", { class: "tile" }, h("div", { class: "label", text: "Spend" }), h("div", { class: "value", text: usd(s.spendUsd) }), h("div", { class: "hint", text: s.tokens.toLocaleString() + " tokens" })),
        h("div", { class: "tile" }, h("div", { class: "label", text: "Blocked" }), h("div", { class: "value", text: s.blocked.toLocaleString() })),
        h("div", { class: "tile" }, h("div", { class: "label", text: "Redacted" }), h("div", { class: "value", text: s.redacted.toLocaleString() })),
        h("button", { class: "tile" + (summary.pendingApprovals ? " alert" : ""), type: "button", on: { click: () => go("approvals") } },
          h("div", { class: "label", text: "Awaiting approval" }), h("div", { class: "value", text: summary.pendingApprovals })),
        h("button", { class: "tile", type: "button", on: { click: () => go("agents") } }, h("div", { class: "label", text: "Agents" }), h("div", { class: "value", text: summary.agents })));

      const chart = panel("Traffic, last 24 hours", {
        flush: true,
        body: h("div", {}, h("div", { class: "chart" }, trafficChart(series.buckets)),
          h("div", { class: "legend" }, GROUPS.map((g) => h("span", { class: "lg-" + g.cls, text: g.label })))),
      });

      const bySpend = [...agents.agents].sort((a, b) => b.spentThisMonthUsd - a.spentThisMonthUsd);
      const spend = panel("Spend this month", {
        flush: true,
        body: bySpend.length === 0 ? empty("No agents yet", "Spend appears here once an agent makes calls.") : h("div", {}, bySpend.slice(0, 6).map((a) => {
          const budget = a.monthlyBudgetUsd;
          const share = budget ? Math.min(a.spentThisMonthUsd / budget, 1) : 0;
          const meter = h("div", { class: "meter" + (share >= 1 ? " bad" : share >= 0.8 ? " warn" : ""), hidden: !budget }, h("span", {}));
          meter.firstChild.style.width = Math.round(share * 100) + "%";
          return h("div", { class: "spend-row" },
            h("div", {}, h("strong", { text: a.name }), " ", h("span", { class: "muted", text: a.team })),
            h("div", { class: "num", text: usd(a.spentThisMonthUsd) + (budget ? " of " + usd(budget) : "") }), meter);
        })),
      });

      const attention = [];
      if (summary.pendingApprovals > 0) {
        attention.push(h("div", { class: "callout warn" }, summary.pendingApprovals + " tool call" + (summary.pendingApprovals > 1 ? "s are" : " is") + " waiting for a decision.",
          h("button", { class: "btn small spacer", type: "button", text: "Review", on: { click: () => go("approvals") } })));
      }
      for (const a of agents.agents) {
        if (a.monthlyBudgetUsd && a.spentThisMonthUsd >= a.monthlyBudgetUsd * 0.8) {
          const pct = Math.round((a.spentThisMonthUsd / a.monthlyBudgetUsd) * 100);
          attention.push(h("div", { class: "callout warn" }, a.name + " has used " + pct + "% of its monthly budget."));
        }
      }
      if (verify) {
        attention.push(verify.ok
          ? h("div", { class: "callout" }, "Audit trail verified: " + verify.checked + " events, no tampering found.")
          : h("div", { class: "callout warn" }, "Audit trail check failed: " + verify.reason));
      }
      const attentionPanel = panel("Needs attention", { flush: true, body: h("div", { class: "body" }, attention.length ? h("div", { class: "stack tight" }, attention) : h("span", { class: "muted", text: "Nothing needs attention right now." })) });

      const recentPanel = panel("Recent requests", {
        flush: true,
        tools: h("button", { class: "btn small", type: "button", text: "View all", on: { click: () => go("requests") } }),
        body: table(
          [{ label: "Time" }, { label: "Agent" }, { label: "Model" }, { label: "Outcome" }, { label: "Cost", num: true }],
          recent.requests.map((r) => h("tr", {}, h("td", { class: "mono muted", text: clock(r.at) }), h("td", { text: r.agentName || r.agentId }), h("td", { text: r.model || "-" }), h("td", {}, pill(r.outcome)), h("td", { class: "num", text: usd(r.costUsd) }))),
          empty("No requests yet", "Point an agent at this gateway and its calls show up here."),
        ),
      });

      frame.replaceChildren(tiles, h("div", { class: "grid-2" }, chart, spend), attentionPanel, recentPanel);
    }
    await draw();
    return draw;
  }

  // ---------------------------------------------------------------- approvals

  async function decide(approval, approve) {
    const first = approval.toolCalls[0];
    const ok = await confirmDialog(
      approve ? "Approve this tool call?" : "Deny this tool call?",
      approve ? "The agent receives the original response and can run " + first.name + "." : "The agent is told a reviewer denied " + first.name + ".",
      approve ? "Approve" : "Deny", !approve);
    if (!ok) return false;
    try {
      await api("/admin/approvals/" + approval.id + "/" + (approve ? "approve" : "deny"), { method: "POST" });
      toast(approve ? "Approved" : "Denied");
      return true;
    } catch (err) {
      toast(err.message, true);
      return true;
    }
  }

  async function mountApprovals(box) {
    const agentNames = {};
    async function draw() {
      const [pendingRes, decidedRes, agents] = await Promise.all([
        api(scoped("/admin/approvals?status=pending")), api(scoped("/admin/approvals?limit=30")), api(scoped("/admin/agents")),
      ]);
      agents.agents.forEach((a) => { agentNames[a.id] = a; });
      const pending = pendingRes.approvals;
      const decided = decidedRes.approvals.filter((a) => a.status !== "pending");
      const tabs = h("div", { class: "tabs", role: "tablist" },
        h("button", { role: "tab", "aria-selected": String(state.approvalsTab === "pending"), text: "Waiting (" + pending.length + ")", on: { click: () => { state.approvalsTab = "pending"; draw(); } } }),
        h("button", { role: "tab", "aria-selected": String(state.approvalsTab === "decided"), text: "Decided", on: { click: () => { state.approvalsTab = "decided"; draw(); } } }));
      let content;
      if (state.approvalsTab === "pending") {
        content = pending.length === 0
          ? empty("Nothing is waiting", "When a policy holds a tool call for approval, it appears here.")
          : pending.map((a) => {
            const agent = agentNames[a.agentId];
            return h("div", { class: "approval" },
              h("div", { class: "approval-head" }, h("span", { class: "who", text: agent ? agent.name : a.agentId }), agent ? h("span", { class: "chip", text: agent.team }) : null, h("span", { class: "faint", text: ago(a.at) })),
              a.toolCalls.map((c) => h("div", {}, h("div", {}, h("span", { class: "tool-chip", text: c.name }), " ", h("span", { class: "muted", text: c.reason })), h("pre", { class: "mono", text: pretty(c.args) }))),
              h("div", { class: "approval-actions" },
                h("button", { class: "btn good", type: "button", disabled: !can("approver"), text: "Approve", on: { click: async () => { if (await decide(a, true)) draw(); } } }),
                h("button", { class: "btn danger", type: "button", disabled: !can("approver"), text: "Deny", on: { click: async () => { if (await decide(a, false)) draw(); } } }),
                can("approver") ? null : h("span", { class: "muted", text: "Your role cannot decide approvals." })));
          });
      } else {
        content = table(
          [{ label: "Agent" }, { label: "Tool" }, { label: "Decision" }, { label: "Decided by" }, { label: "When" }],
          decided.map((a) => h("tr", {}, h("td", { text: (agentNames[a.agentId] || {}).name || a.agentId }), h("td", {}, h("span", { class: "tool-chip", text: a.toolCalls.map((c) => c.name).join(", ") })),
            h("td", {}, h("span", { class: "pill " + (a.status === "approved" ? "ok" : "bad"), text: a.status === "approved" ? "Approved" : "Denied" })), h("td", { class: "muted", text: a.decidedBy || "-" }), h("td", { class: "muted", text: a.decidedAt ? stamp(a.decidedAt) : "-" }))),
          empty("No decisions yet", "Approved and denied tool calls are listed here."));
      }
      box.replaceChildren(h("section", { class: "panel" }, tabs, content));
      updateBadge(pending.length);
    }
    await draw();
    return draw;
  }

  // ---------------------------------------------------------------- agents

  function parseModels(text) {
    const list = text.split(",").map((m) => m.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  const numberOrNull = (text) => (text.trim() === "" ? null : Number(text));

  async function agentForm(existing) {
    const name = h("input", { type: "text", value: existing ? existing.name : "", required: true, maxlength: "100", placeholder: "support-bot" });
    const team = allTeams()
      ? selectOf(teamOptions(), existing ? existing.team : state.teamFilter || "default")
      : h("input", { type: "text", value: state.me.team, disabled: true });
    const models = h("input", { type: "text", value: existing && existing.allowedModels ? existing.allowedModels.join(", ") : "", placeholder: "Any model" });
    const budget = h("input", { type: "number", min: "0", step: "any", value: existing && existing.monthlyBudgetUsd !== null ? String(existing.monthlyBudgetUsd) : "", placeholder: "No limit" });
    const rate = h("input", { type: "number", min: "1", step: "1", value: existing && existing.ratePerMinute !== null ? String(existing.ratePerMinute) : "", placeholder: "No limit" });
    const concurrent = h("input", { type: "number", min: "1", step: "1", value: existing && existing.maxConcurrent !== null ? String(existing.maxConcurrent) : "", placeholder: "No limit" });
    const ok = await modal({
      title: existing ? "Edit " + existing.name : "New agent",
      submitLabel: existing ? "Save changes" : "Create agent",
      body: [
        field("Name", name),
        h("div", { class: "row" }, field("Team", team), field("Monthly budget (USD)", budget)),
        field("Allowed models", models, "Comma separated. Leave empty to allow any model."),
        h("div", { class: "row" }, field("Requests per minute", rate), field("Max concurrent requests", concurrent)),
      ],
      onSubmit: async () => {
        const settings = {
          name: name.value.trim(), allowedModels: parseModels(models.value), monthlyBudgetUsd: numberOrNull(budget.value),
          ratePerMinute: numberOrNull(rate.value), maxConcurrent: numberOrNull(concurrent.value),
        };
        if (allTeams()) settings.team = team.value;
        if (existing) {
          await api("/admin/agents/" + existing.id, { method: "PATCH", body: settings });
          toast("Saved " + settings.name);
        } else {
          const created = await api("/admin/agents", { method: "POST", body: settings });
          setTimeout(() => showSecret("Key for " + created.agent.name, "Copy this key now. It is shown once and cannot be retrieved later.", created.key), 0);
        }
      },
    });
    return ok;
  }

  async function mountAgents(box) {
    async function draw() {
      const { agents } = await api(scoped("/admin/agents"));
      const rows = agents.map((a) => {
        const share = a.monthlyBudgetUsd ? Math.min(a.spentThisMonthUsd / a.monthlyBudgetUsd, 1) : 0;
        const meter = h("div", { class: "meter inline" + (share >= 1 ? " bad" : share >= 0.8 ? " warn" : "") }, h("span", {}));
        meter.firstChild.style.width = Math.round(share * 100) + "%";
        const spendCell = h("td", {}, a.monthlyBudgetUsd ? [meter, usd(a.spentThisMonthUsd) + " of " + usd(a.monthlyBudgetUsd)] : usd(a.spentThisMonthUsd) + " (no limit)");
        const manage = can("admin");
        return h("tr", {},
          h("td", {}, h("strong", { text: a.name }), h("div", { class: "faint mono", text: a.id })),
          h("td", { text: a.team }),
          h("td", { text: a.allowedModels ? a.allowedModels.join(", ") : "Any" }),
          spendCell,
          h("td", { class: "num", text: a.ratePerMinute === null ? "-" : a.ratePerMinute + "/min" }),
          h("td", { class: "num", text: a.maxConcurrent === null ? "-" : a.maxConcurrent }),
          h("td", {}, a.disabled ? h("span", { class: "pill bad", text: "Disabled" }) : h("span", { class: "pill ok", text: "Active" })),
          h("td", { class: "actions" }, manage ? [
            h("button", { class: "btn small", type: "button", text: "Edit", on: { click: async () => { if (await agentForm(a)) draw(); } } }), " ",
            h("button", { class: "btn small", type: "button", text: a.disabled ? "Enable" : "Disable", on: { click: async () => {
              if (!a.disabled && !(await confirmDialog("Disable " + a.name + "?", "Its requests are refused until you enable it again.", "Disable", true))) return;
              try { await api("/admin/agents/" + a.id, { method: "PATCH", body: { disabled: !a.disabled } }); toast(a.disabled ? "Enabled" : "Disabled"); draw(); } catch (err) { toast(err.message, true); }
            } } }), " ",
            h("button", { class: "btn small", type: "button", text: "Rotate key", on: { click: async () => {
              if (!(await confirmDialog("Rotate the key for " + a.name + "?", "The current key stops working immediately. You will get a new one to hand to the agent.", "Rotate", true))) return;
              try { const r = await api("/admin/agents/" + a.id + "/rotate-key", { method: "POST" }); showSecret("New key for " + a.name, "Copy this key now. It is shown once.", r.key); } catch (err) { toast(err.message, true); }
            } } }),
          ] : null));
      });
      const create = can("admin") ? h("button", { class: "btn primary", type: "button", text: "New agent", on: { click: async () => { if (await agentForm(null)) { await refreshTeams(); draw(); } } } }) : null;
      box.replaceChildren(panel("Agents", {
        sub: agents.length + " registered", tools: create, flush: true,
        body: table(
          [{ label: "Agent" }, { label: "Team" }, { label: "Models" }, { label: "Spend this month" }, { label: "Rate", num: true }, { label: "Concurrency", num: true }, { label: "Status" }, { label: "" }],
          rows,
          empty("No agents yet", "An agent is anything that calls a model through Wicket. Each gets its own key, budget and limits.", create ? h("button", { class: "btn primary", type: "button", text: "Create the first agent", on: { click: async () => { if (await agentForm(null)) draw(); } } }) : null)),
      }));
    }
    await draw();
    return draw;
  }

  // ---------------------------------------------------------------- policy

  const DETECTORS = [["email", "Email addresses"], ["ssn", "US Social Security numbers"], ["credit_card", "Card numbers"], ["phone", "Phone numbers"], ["api_key", "API keys and tokens"]];
  const ACTIONS = [{ value: "allow", label: "Allow" }, { value: "require_approval", label: "Require approval" }, { value: "deny", label: "Deny" }];
  const OPS = [{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }, { value: "matches", label: "matches regex" }, { value: "gt", label: "is greater than" }, { value: "lt", label: "is less than" }];

  /** The draft keeps condition values as text so half-typed numbers survive editing. */
  function toDraft(policy) {
    return {
      redaction: { mode: policy.redaction.mode, detectors: [...policy.redaction.detectors] },
      defaultToolAction: policy.defaultToolAction,
      tools: policy.tools.map((r) => ({ tool: r.tool, action: r.action, reason: r.reason || "", when: (r.when || []).map((c) => ({ arg: c.arg, op: c.op, value: String(c.value) })) })),
    };
  }

  function fromDraft(draft) {
    return {
      redaction: { mode: draft.redaction.mode, detectors: draft.redaction.detectors },
      defaultToolAction: draft.defaultToolAction,
      tools: draft.tools.map((r, i) => {
        if (!r.tool.trim()) throw new Error("Rule " + (i + 1) + " needs a tool name.");
        const rule = { tool: r.tool.trim(), action: r.action };
        if (r.reason.trim()) rule.reason = r.reason.trim();
        if (r.when.length) {
          rule.when = r.when.map((c) => {
            if (!c.arg.trim()) throw new Error("Rule " + (i + 1) + " has a condition without an argument name.");
            if (c.op === "gt" || c.op === "lt") {
              const n = Number(c.value);
              if (c.value.trim() === "" || !Number.isFinite(n)) throw new Error("Rule " + (i + 1) + ": \"" + c.op.replace("gt", "greater than").replace("lt", "less than") + "\" needs a number.");
              return { arg: c.arg.trim(), op: c.op, value: n };
            }
            return { arg: c.arg.trim(), op: c.op, value: c.value };
          });
        }
        return rule;
      }),
    };
  }

  async function mountPolicy(box) {
    if (state.policyScope === null) state.policyScope = state.me.team || "";
    let scope = state.policyScope;
    let draft, original, inherited = false, hitRule = null;

    const editable = () => (scope === "" ? state.me.role === "owner" && allTeams() : can("admin"));

    async function load() {
      if (scope === "") {
        const r = await api("/admin/policy");
        draft = toDraft(r.policy);
        inherited = false;
      } else {
        const r = await api("/admin/policy?team=" + encodeURIComponent(scope));
        inherited = r.inherited;
        draft = toDraft(r.policy || r.effective);
      }
      original = JSON.stringify(draft);
      hitRule = null;
      draw();
    }

    const dirty = () => JSON.stringify(draft) !== original;

    function draw() {
      const locked = !editable();
      const scopeSelect = selectOf(
        [...(allTeams() ? [{ value: "", label: "Organization default" }] : []), ...teamOptions().filter((t) => allTeams() || t.value === state.me.team)],
        scope, { "aria-label": "Policy scope" });
      scopeSelect.addEventListener("change", async () => {
        if (dirty() && !(await confirmDialog("Discard your changes?", "You have unsaved edits to this policy.", "Discard", true))) { scopeSelect.value = scope; return; }
        scope = scopeSelect.value;
        state.policyScope = scope;
        load();
      });
      const dirtyChip = h("span", { class: "chip", text: "Unsaved changes", hidden: !dirty() });
      const saveBtn = h("button", { class: "btn primary", type: "button", text: "Save policy", disabled: locked || !dirty() });
      const syncButtons = () => { dirtyChip.hidden = !dirty(); saveBtn.disabled = locked || !dirty(); };

      saveBtn.addEventListener("click", async () => {
        let body;
        try { body = fromDraft(draft); } catch (err) { toast(err.message, true); return; }
        try {
          await api("/admin/policy" + (scope ? "?team=" + encodeURIComponent(scope) : ""), { method: "PUT", body });
          toast("Policy saved");
          await refreshTeams();
          load();
        } catch (err) { toast(err.message, true); }
      });

      const banner = [];
      if (locked) banner.push(h("div", { class: "callout warn" }, scope === "" ? "Only an owner with access to all teams can change the organization policy." : "Your role cannot edit policy. You can still read it and try the tester."));
      if (scope !== "" && inherited) banner.push(h("div", { class: "callout" }, "This team follows the organization policy. Changing anything and saving gives it a policy of its own."));

      const redaction = h("div", {},
        h("div", { class: "seg", role: "radiogroup", "aria-label": "Redaction mode" }, [["off", "Off"], ["redact", "Mask"], ["block", "Block"]].map(([value, label]) =>
          h("label", {}, h("input", { type: "radio", name: "redaction-mode", value, checked: draft.redaction.mode === value, disabled: locked, on: { change: () => { draft.redaction.mode = value; syncButtons(); } } }), h("span", { text: label })))),
        h("p", { class: "muted", text: "Mask replaces sensitive text with a tag such as [REDACTED:EMAIL] before it leaves. Block refuses the request. Replies from the model are always masked." }),
        h("div", { class: "checks" }, DETECTORS.map(([value, label]) => h("label", {}, h("input", { type: "checkbox", checked: draft.redaction.detectors.includes(value), disabled: locked, on: { change: (e) => {
          const set = new Set(draft.redaction.detectors);
          if (e.target.checked) set.add(value); else set.delete(value);
          draft.redaction.detectors = DETECTORS.map(([d]) => d).filter((d) => set.has(d));
          syncButtons();
        } } }), label))));

      const rulesBox = h("div", {});
      function drawRules() {
        rulesBox.replaceChildren();
        if (draft.tools.length === 0) rulesBox.append(h("p", { class: "muted", text: "No rules. Every tool call gets the default action below." }));
        draft.tools.forEach((rule, i) => {
          const card = h("div", { class: "rule" + (hitRule === i ? " hit" : ""), data: { rule: i } });
          const move = (by) => { const j = i + by; if (j < 0 || j >= draft.tools.length) return; [draft.tools[i], draft.tools[j]] = [draft.tools[j], draft.tools[i]]; hitRule = null; drawRules(); syncButtons(); };
          card.append(h("div", { class: "rule-head" },
            h("span", { class: "n", text: i + 1 }),
            h("input", { type: "text", value: rule.tool, placeholder: "tool name, e.g. refund or delete_*", disabled: locked, "aria-label": "Tool name for rule " + (i + 1), on: { input: (e) => { rule.tool = e.target.value; syncButtons(); } } }),
            selectOf(ACTIONS, rule.action, { disabled: locked, "aria-label": "Action for rule " + (i + 1), on: { change: (e) => { rule.action = e.target.value; syncButtons(); } } }),
            h("input", { type: "text", value: rule.reason, placeholder: "Reason shown to the agent and reviewer", disabled: locked, "aria-label": "Reason for rule " + (i + 1), on: { input: (e) => { rule.reason = e.target.value; syncButtons(); } } }),
            h("div", {}, h("button", { class: "btn small ghost", type: "button", text: "Up", disabled: locked || i === 0, "aria-label": "Move rule " + (i + 1) + " up", on: { click: () => move(-1) } }),
              h("button", { class: "btn small ghost", type: "button", text: "Down", disabled: locked || i === draft.tools.length - 1, "aria-label": "Move rule " + (i + 1) + " down", on: { click: () => move(1) } }),
              h("button", { class: "btn small ghost", type: "button", text: "Delete", disabled: locked, "aria-label": "Delete rule " + (i + 1), on: { click: () => { draft.tools.splice(i, 1); hitRule = null; drawRules(); syncButtons(); } } }))));
          rule.when.forEach((c, k) => {
            card.append(h("div", { class: "cond" },
              h("input", { type: "text", value: c.arg, placeholder: "argument, e.g. amount", disabled: locked, "aria-label": "Condition argument", on: { input: (e) => { c.arg = e.target.value; syncButtons(); } } }),
              selectOf(OPS, c.op, { disabled: locked, "aria-label": "Condition operator", on: { change: (e) => { c.op = e.target.value; syncButtons(); } } }),
              h("input", { type: "text", value: c.value, placeholder: "value", disabled: locked, "aria-label": "Condition value", on: { input: (e) => { c.value = e.target.value; syncButtons(); } } }),
              h("button", { class: "btn small ghost", type: "button", text: "Remove", disabled: locked, on: { click: () => { rule.when.splice(k, 1); drawRules(); syncButtons(); } } })));
          });
          card.append(h("div", { class: "rule-foot" }, h("button", { class: "btn small", type: "button", text: "Add condition", disabled: locked, on: { click: () => { rule.when.push({ arg: "", op: "equals", value: "" }); drawRules(); syncButtons(); } } }),
            rule.when.length ? h("span", { class: "muted", text: "  All conditions must hold. A missing or non-numeric value counts as holding for deny and approval rules." }) : null));
          rulesBox.append(card);
        });
      }
      drawRules();

      const tools = h("div", {},
        rulesBox,
        h("button", { class: "btn", type: "button", text: "Add rule", disabled: locked, on: { click: () => { draft.tools.push({ tool: "", action: "require_approval", reason: "", when: [] }); drawRules(); syncButtons(); } } }),
        h("div", { class: "mt" }, field("When no rule matches", selectOf(ACTIONS, draft.defaultToolAction, { disabled: locked, on: { change: (e) => { draft.defaultToolAction = e.target.value; syncButtons(); } } }), "Rules run top to bottom and the first match wins.")));

      // The tester judges the draft on screen, saved or not.
      const testTool = h("input", { type: "text", value: "refund", "aria-label": "Tool name to test" });
      const testArgs = h("textarea", { "aria-label": "Tool arguments as JSON", spellcheck: "false" });
      testArgs.value = '{ "amount": 500 }';
      const toolResult = h("div", { class: "sim-result muted", text: "Run a tool call to see what this policy would do." });
      const testText = h("textarea", { "aria-label": "Text to test", placeholder: "Paste text that might contain personal data" });
      testText.value = "Please email ann@example.com about order 4242 4242 4242 4242.";
      const textResult = h("div", { class: "sim-result muted", text: "Run some text to see what would be masked." });
      const runTool = async () => {
        let policy;
        try { policy = fromDraft(draft); } catch (err) { toolResult.replaceChildren(err.message); return; }
        try {
          const r = await api("/admin/policy/simulate", { method: "POST", body: { policy, toolCall: { name: testTool.value.trim(), args: testArgs.value } } });
          hitRule = r.tool.ruleIndex;
          rulesBox.querySelectorAll(".rule").forEach((el) => el.classList.toggle("hit", Number(el.dataset.rule) === hitRule));
          toolResult.className = "sim-result";
          toolResult.replaceChildren(actionPill(r.tool.action), " ", r.tool.ruleIndex === null ? "No rule matched, so the default action applied." : "Rule " + (r.tool.ruleIndex + 1) + " matched. " + r.tool.reason,
            r.tool.argumentsValid ? null : h("div", { class: "muted", text: "The arguments are not valid JSON, so conditions could not be judged. Strict rules apply." }));
        } catch (err) { toolResult.className = "sim-result"; toolResult.replaceChildren(err.message); }
      };
      const runText = async () => {
        let policy;
        try { policy = fromDraft(draft); } catch (err) { textResult.replaceChildren(err.message); return; }
        try {
          const r = (await api("/admin/policy/simulate", { method: "POST", body: { policy, text: testText.value } })).redaction;
          textResult.className = "sim-result";
          if (r.mode === "off") { textResult.replaceChildren("Redaction is off, so the text is sent as written."); return; }
          textResult.replaceChildren(
            r.wouldBlock ? h("span", { class: "pill bad", text: "Request would be blocked" }) : h("span", { class: "pill ok", text: r.findings.length ? "Would be masked" : "Nothing found" }),
            " ", r.findings.map((f) => f.type + " x" + f.count).join(", "), h("pre", { class: "mono", text: r.text }));
        } catch (err) { textResult.className = "sim-result"; textResult.replaceChildren(err.message); }
      };

      const removeBtn = scope !== "" && !inherited && editable() ? h("button", { class: "btn danger", type: "button", text: "Remove team policy", on: { click: async () => {
        if (!(await confirmDialog("Remove this team's policy?", "The team goes back to following the organization policy.", "Remove", true))) return;
        try { await api("/admin/policy?team=" + encodeURIComponent(scope), { method: "DELETE" }); toast("Team policy removed"); await refreshTeams(); load(); } catch (err) { toast(err.message, true); }
      } } }) : null;

      box.replaceChildren(
        panel("Policy", { sub: "what agents may send and do", tools: [dirtyChip, scopeSelect, h("button", { class: "btn", type: "button", text: "Revert", disabled: locked, on: { click: load } }), removeBtn, saveBtn] , body: banner.length ? h("div", { class: "stack tight" }, banner) : h("span", { class: "muted", text: "Rules apply to every agent in the chosen scope." }) }),
        panel("Sensitive data", { body: redaction }),
        panel("Tool calls", { sub: "judged on the model's response, in order", body: tools }),
        panel("Try it", {
          sub: "tests the policy on screen, saved or not",
          body: h("div", { class: "grid-2" },
            h("div", { class: "sim" }, h("strong", { text: "A tool call" }), h("div", { class: "row" }, field("Tool", testTool), h("div", {})), field("Arguments (JSON)", testArgs), h("div", {}, h("button", { class: "btn primary", type: "button", text: "Run tool call", on: { click: runTool } })), toolResult),
            h("div", { class: "sim" }, h("strong", { text: "Some text" }), field("Text", testText), h("div", {}, h("button", { class: "btn primary", type: "button", text: "Run text", on: { click: runText } })), textResult)),
        }));
    }
    await load();
    return null;
  }

  // ---------------------------------------------------------------- requests

  async function mountRequests(box) {
    const f = state.requestFilter;
    const { agents } = await api(scoped("/admin/agents"));
    const outcome = selectOf([{ value: "", label: "Every outcome" }, ...Object.entries(OUTCOMES).map(([value, [, label]]) => ({ value, label }))], f.outcome, { "aria-label": "Filter by outcome" });
    const agent = selectOf([{ value: "", label: "Every agent" }, ...agents.map((a) => ({ value: a.id, label: a.name }))], f.agent, { "aria-label": "Filter by agent" });
    const limit = selectOf([{ value: "50", label: "Last 50" }, { value: "100", label: "Last 100" }, { value: "250", label: "Last 250" }], f.limit, { "aria-label": "How many to show" });
    const body = h("div", {});
    async function draw() {
      const params = new URLSearchParams({ limit: f.limit });
      if (f.outcome) params.set("outcome", f.outcome);
      if (f.agent) params.set("agent", f.agent);
      const { requests } = await api(scoped("/admin/requests?" + params));
      body.replaceChildren(table(
        [{ label: "Time" }, { label: "Agent" }, { label: "Model" }, { label: "Outcome" }, { label: "Status", num: true }, { label: "Tokens", num: true }, { label: "Cost", num: true }, { label: "Latency", num: true }],
        requests.map((r) => h("tr", {}, h("td", { class: "mono muted", text: clock(r.at) }), h("td", { text: r.agentName || r.agentId }), h("td", { text: r.model || "-" }), h("td", {}, pill(r.outcome)),
          h("td", { class: "num", text: r.status }), h("td", { class: "num", text: (r.promptTokens || 0) + (r.completionTokens || 0) }), h("td", { class: "num", text: usd(r.costUsd) }), h("td", { class: "num", text: r.latencyMs + " ms" }))),
        empty("No matching requests", f.outcome || f.agent ? "Try a different filter." : "Calls through the gateway are listed here.")));
    }
    for (const [select, key] of [[outcome, "outcome"], [agent, "agent"], [limit, "limit"]]) select.addEventListener("change", () => { f[key] = select.value; draw(); });
    box.replaceChildren(h("section", { class: "panel" }, h("header", {}, h("h2", { text: "Requests" }), h("div", { class: "spacer" }, outcome, agent, limit)), body));
    await draw();
    return draw;
  }

  // ---------------------------------------------------------------- audit

  async function mountAudit(box) {
    if (!allTeams()) {
      box.replaceChildren(panel("Audit trail", { body: empty("Not available for team-scoped users", "The audit trail covers the whole gateway, so it needs access to all teams.") }));
      return null;
    }
    const status = h("div", { class: "status-line" });
    const list = h("div", {});
    async function draw() {
      const [verify, { events }] = await Promise.all([api("/admin/audit/verify"), api("/admin/audit?limit=100")]);
      status.replaceChildren(
        verify.ok ? h("span", { class: "pill ok", text: "Chain intact" }) : h("span", { class: "pill bad", text: "Chain broken" }),
        verify.ok ? h("span", { class: "muted", text: verify.checked + " events checked, and the signed head matches the newest one." }) : h("span", { text: verify.reason + (verify.brokenAt ? " (event #" + verify.brokenAt + ")" : "") }),
        h("button", { class: "btn small spacer", type: "button", text: "Verify again", on: { click: draw } }));
      const rows = [];
      for (const e of events) {
        const detail = h("tr", { hidden: true }, h("td", { colspan: "5", class: "flush" }, h("pre", { class: "json mono", text: pretty({ data: e.data, hash: e.hash, previousHash: e.prevHash }) })));
        rows.push(h("tr", { class: "expandable", tabindex: "0", "aria-expanded": "false", on: {
          click: (ev) => { detail.hidden = !detail.hidden; ev.currentTarget.setAttribute("aria-expanded", String(!detail.hidden)); },
          keydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.currentTarget.click(); } },
        } }, h("td", { class: "mono muted", text: e.seq }), h("td", { class: "muted", text: stamp(e.at) }), h("td", {}, h("code", { text: e.type })), h("td", { text: e.actor }), h("td", { class: "mono muted", text: e.hash.slice(0, 12) })));
        rows.push(detail);
      }
      list.replaceChildren(table([{ label: "#" }, { label: "Time" }, { label: "Event" }, { label: "Actor" }, { label: "Hash" }], rows, empty("No events yet", "Changes and decisions are recorded here.")));
    }
    box.replaceChildren(h("section", { class: "panel" }, h("header", {}, h("h2", { text: "Audit trail" }), h("span", { class: "sub", text: "every event includes the hash of the one before it. Click a row for details." })), status, list));
    await draw();
    return null;
  }

  // ---------------------------------------------------------------- settings

  async function mountSettings(box) {
    const tabs = [["users", "Users"], ["teams", "Teams"], ["upstreams", "Providers"]].filter(([key]) => key !== "users" || state.me.role === "owner");
    if (!tabs.some(([key]) => key === state.settingsTab)) state.settingsTab = tabs[0][0];
    const content = h("div", {});

    async function drawUsers() {
      const { users } = await api("/admin/users");
      const add = h("button", { class: "btn primary", type: "button", text: "New user", on: { click: async () => {
        const name = h("input", { type: "text", required: true, placeholder: "Lee Kim" });
        const role = selectOf([{ value: "viewer", label: "Viewer: read only" }, { value: "approver", label: "Approver: can decide approvals" }, { value: "admin", label: "Admin: manages agents and team policy" }, { value: "owner", label: "Owner: everything" }], "viewer");
        const team = selectOf([{ value: "", label: "All teams" }, ...teamOptions()], "");
        const ok = await modal({ title: "New user", submitLabel: "Create user", body: [field("Name", name), field("Role", role), field("Team", team, "A user limited to one team sees and changes only that team.")], onSubmit: async () => {
          const r = await api("/admin/users", { method: "POST", body: { name: name.value.trim(), role: role.value, team: team.value || null } });
          setTimeout(() => showSecret("Key for " + r.user.name, "Copy this key now. It is shown once. It signs the user in to the dashboard and the admin API.", r.key), 0);
        } });
        if (ok) drawUsers();
      } } });
      content.replaceChildren(panel("Users", { sub: "who can sign in", tools: add, flush: true, body: table(
        [{ label: "Name" }, { label: "Role" }, { label: "Team" }, { label: "Created" }, { label: "Status" }, { label: "" }],
        users.map((u) => h("tr", {}, h("td", {}, h("strong", { text: u.name }), h("div", { class: "faint mono", text: u.id })), h("td", { text: u.role }), h("td", { text: u.team || "All teams" }), h("td", { class: "muted", text: stamp(u.createdAt) }),
          h("td", {}, u.disabled ? h("span", { class: "pill bad", text: "Disabled" }) : h("span", { class: "pill ok", text: "Active" })),
          h("td", { class: "actions" }, h("button", { class: "btn small", type: "button", text: u.disabled ? "Enable" : "Disable", on: { click: async () => {
            try { await api("/admin/users/" + u.id, { method: "PATCH", body: { disabled: !u.disabled } }); toast(u.disabled ? "Enabled" : "Disabled"); drawUsers(); } catch (err) { toast(err.message, true); }
          } } })))),
        empty("No users yet", "The environment token always works. Create users so people sign in with their own keys.")) }));
    }

    async function drawTeams() {
      await refreshTeams();
      const add = state.me.role === "owner" && allTeams() ? h("button", { class: "btn primary", type: "button", text: "New team", on: { click: async () => {
        const id = h("input", { type: "text", required: true, placeholder: "support", pattern: "[a-z0-9][a-z0-9-]{0,39}" });
        const name = h("input", { type: "text", placeholder: "Customer Support" });
        const ok = await modal({ title: "New team", submitLabel: "Create team", body: [field("Id", id, "Lowercase letters, digits and dashes."), field("Display name", name)], onSubmit: async () => {
          await api("/admin/teams", { method: "POST", body: { id: id.value.trim(), name: name.value.trim() || id.value.trim() } });
        } });
        if (ok) drawTeams();
      } } }) : null;
      content.replaceChildren(panel("Teams", { sub: "the unit of tenancy", tools: add, flush: true, body: table(
        [{ label: "Id" }, { label: "Name" }, { label: "Policy" }],
        state.teams.map((t) => h("tr", {}, h("td", { class: "mono", text: t.id }), h("td", { text: t.name }), h("td", {}, t.hasOwnPolicy ? h("span", { class: "pill info", text: "Own policy" }) : h("span", { class: "pill neutral", text: "Follows organization" })))),
        empty("No teams", "Teams are created with the first agent."),
      ) }));
    }

    async function drawUpstreams() {
      if (!can("admin") || !allTeams()) { content.replaceChildren(panel("Providers", { body: empty("Not available", "Providers are managed by users with access to all teams.") })); return; }
      const { upstreams, fallback } = await api("/admin/upstreams");
      const add = state.me.role === "owner" ? h("button", { class: "btn primary", type: "button", text: "Add provider", on: { click: async () => {
        const name = h("input", { type: "text", required: true, placeholder: "anthropic" });
        const kind = selectOf([{ value: "anthropic", label: "Anthropic Messages API" }, { value: "openai", label: "OpenAI-compatible" }], "anthropic");
        const url = h("input", { type: "url", required: true, placeholder: "https://api.anthropic.com" });
        const env = h("input", { type: "text", placeholder: "ANTHROPIC_API_KEY", pattern: "[A-Z_][A-Z0-9_]*" });
        const models = h("input", { type: "text", required: true, placeholder: "claude-*" });
        const ok = await modal({ title: "Add provider", submitLabel: "Add provider", body: [
          field("Name", name), field("Type", kind), field("Base URL", url), field("Key environment variable", env, "The name of the variable that holds the provider key on the gateway. The key itself is never stored."),
          field("Model patterns", models, "Comma separated, with * as a wildcard. The first matching provider serves the model."),
        ], onSubmit: async () => {
          await api("/admin/upstreams", { method: "POST", body: { name: name.value.trim(), kind: kind.value, baseUrl: url.value.trim(), apiKeyEnv: env.value.trim() || null, models: parseModels(models.value) || [] } });
        } });
        if (ok) drawUpstreams();
      } } }) : null;
      content.replaceChildren(panel("Providers", { sub: "where each model is sent", tools: add, flush: true, body: h("div", {},
        table([{ label: "Name" }, { label: "Type" }, { label: "Base URL" }, { label: "Models" }, { label: "Key variable" }, { label: "Status" }, { label: "" }],
          upstreams.map((u) => h("tr", {}, h("td", {}, h("strong", { text: u.name })), h("td", { text: u.kind }), h("td", { class: "mono", text: u.baseUrl }), h("td", { text: u.models.join(", ") }), h("td", { class: "mono", text: u.apiKeyEnv || "-" }),
            h("td", {}, u.enabled ? h("span", { class: "pill ok", text: "Active" }) : h("span", { class: "pill neutral", text: "Off" })),
            h("td", { class: "actions" }, state.me.role === "owner" ? [
              h("button", { class: "btn small", type: "button", text: u.enabled ? "Turn off" : "Turn on", on: { click: async () => { try { await api("/admin/upstreams/" + u.id, { method: "PATCH", body: { enabled: !u.enabled } }); drawUpstreams(); } catch (err) { toast(err.message, true); } } } }), " ",
              h("button", { class: "btn small danger", type: "button", text: "Delete", on: { click: async () => { if (await confirmDialog("Delete " + u.name + "?", "Models it served fall back to the default upstream.", "Delete", true)) { try { await api("/admin/upstreams/" + u.id, { method: "DELETE" }); drawUpstreams(); } catch (err) { toast(err.message, true); } } } } }),
            ] : null))),
          empty("No providers registered", "Every model goes to the default upstream below.")),
        h("div", { class: "body muted" }, "Default upstream for models no provider matches: ", h("code", { text: fallback })))}));
    }

    const draws = { users: drawUsers, teams: drawTeams, upstreams: drawUpstreams };
    const tabBar = h("div", { class: "tabs", role: "tablist" });
    function drawTabs() {
      tabBar.replaceChildren(...tabs.map(([key, label]) => h("button", { role: "tab", "aria-selected": String(state.settingsTab === key), text: label, on: { click: () => { state.settingsTab = key; drawTabs(); draws[key](); } } })));
    }
    drawTabs();
    box.replaceChildren(h("section", { class: "panel" }, tabBar), content);
    await draws[state.settingsTab]();
    return null;
  }

  // ---------------------------------------------------------------- shell and routing

  const PAGES = {
    overview: { title: "Overview", mount: mountOverview, icon: "overview", live: true },
    approvals: { title: "Approvals", mount: mountApprovals, icon: "approvals", live: true },
    agents: { title: "Agents", mount: mountAgents, icon: "agents", live: true },
    policy: { title: "Policy", mount: mountPolicy, icon: "policy" },
    requests: { title: "Requests", mount: mountRequests, icon: "requests", live: true },
    audit: { title: "Audit trail", mount: mountAudit, icon: "audit", visible: () => allTeams() },
    settings: { title: "Settings", mount: mountSettings, icon: "settings", visible: () => can("admin") },
  };

  const refs = {};

  async function refreshTeams() {
    try { state.teams = (await api("/admin/teams")).teams; } catch { /* keep the old list */ }
  }

  function updateBadge(count) {
    if (!refs.badge) return;
    refs.badge.textContent = count;
    refs.badge.hidden = !count;
  }

  async function pollBadge() {
    try { updateBadge((await api(scoped("/admin/summary"))).pendingApprovals); } catch { /* shown elsewhere */ }
  }

  function go(route) {
    location.hash = "#/" + route;
  }

  function currentRoute() {
    const path = location.hash.slice(1).split("&")[0].replace(/^\//, "");
    const page = PAGES[path];
    return page && (!page.visible || page.visible()) ? path : "overview";
  }

  async function navigate() {
    if (!state.me) return;
    state.route = currentRoute();
    const page = PAGES[state.route];
    const id = ++state.navId;
    refs.title.textContent = page.title;
    refs.nav.querySelectorAll("a").forEach((a) => (a.getAttribute("href") === "#/" + state.route ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    document.title = page.title + " | Wicket";
    refs.content.replaceChildren(h("div", { class: "empty", text: "Loading" }));
    try {
      const refresh = await page.mount(refs.content);
      if (id !== state.navId) return;
      state.page = page.live && refresh ? refresh : null;
      stamped();
    } catch (err) {
      if (id !== state.navId || err.status === 401) return;
      refs.content.replaceChildren(panel(page.title, { body: empty("Something went wrong", err.message) }));
    }
    pollBadge();
  }

  function stamped() {
    state.updatedAt = new Date().toISOString();
    refs.updated.textContent = "Updated " + clock(state.updatedAt);
  }

  function startPolling() {
    clearInterval(state.timer);
    state.timer = setInterval(async () => {
      if (document.visibilityState !== "visible" || dialogOpen() || !state.me) return;
      try {
        if (state.page) { const id = state.navId; await state.page(); if (id === state.navId) stamped(); }
        pollBadge();
      } catch { /* the next tick tries again */ }
    }, 4000);
  }

  function renderShell() {
    const nav = h("nav", { class: "nav", "aria-label": "Main" });
    const badge = h("span", { class: "badge", hidden: true });
    for (const [route, page] of Object.entries(PAGES)) {
      if (page.visible && !page.visible()) continue;
      nav.append(h("a", { href: "#/" + route }, icon(page.icon), page.title, route === "approvals" ? badge : null));
    }
    const teamSelect = allTeams() && state.teams.length > 1
      ? selectOf([{ value: "", label: "All teams" }, ...teamOptions()], state.teamFilter, { "aria-label": "Show one team", on: { change: (e) => { state.teamFilter = e.target.value; navigate(); } } })
      : null;
    if (teamSelect) teamSelect.style.width = "auto";
    const themeBtn = h("button", { class: "btn icon-btn", type: "button", "aria-label": "Change theme", title: "Theme: " + currentTheme() });
    const drawTheme = () => { themeBtn.replaceChildren(icon(currentTheme() === "dark" ? "moon" : "sun")); themeBtn.title = "Theme: " + currentTheme(); };
    themeBtn.addEventListener("click", () => {
      const next = { auto: "light", light: "dark", dark: "auto" }[currentTheme()];
      applyTheme(next);
      store("local", "wicket-theme", next === "auto" ? "" : next);
      drawTheme();
    });
    drawTheme();

    refs.title = h("h1", {});
    refs.updated = h("span", { class: "updated" });
    refs.content = h("main", { class: "content", id: "main" });
    refs.nav = nav;
    refs.badge = badge;

    document.getElementById("root").replaceChildren(h("div", { class: "shell" },
      h("aside", { class: "sidebar" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("logo")), h("span", { class: "name", text: "Wicket" })),
        nav,
        h("div", { class: "sidebar-foot", text: "Gateway for AI agents" })),
      h("div", { class: "main" },
        h("header", { class: "topbar" }, refs.title, teamSelect, refs.updated,
          h("span", { class: "chip", text: state.me.role + (state.me.team ? " · " + state.me.team : "") + " · " + state.me.name }),
          themeBtn, h("button", { class: "btn", type: "button", text: "Sign out", on: { click: () => signOut("") } })),
        refs.content)));
  }

  function renderLogin(message) {
    state.me = null;
    clearInterval(state.timer);
    const token = h("input", { type: "password", autocomplete: "off", placeholder: "Admin token or user key", "aria-label": "Admin token", required: true });
    const error = h("div", { class: "login-error", role: "alert", text: message || "" });
    const form = h("form", { class: "login-card", on: { submit: (e) => { e.preventDefault(); signIn(token.value.trim(), error); } } },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("logo")), "Wicket"),
      h("p", { text: "Sign in with the admin token, or with a key an owner created for you." }),
      field("Key", token), h("button", { class: "btn primary block", type: "submit", text: "Sign in" }), error);
    document.getElementById("root").replaceChildren(h("div", { class: "login" }, form));
    document.title = "Sign in | Wicket";
    token.focus();
  }

  async function signIn(token, errorBox) {
    if (!token) return;
    state.token = token;
    try {
      const me = await api("/admin/me");
      state.me = me.actor;
      store("session", "wicket-token", token);
      await refreshTeams();
      renderShell();
      if (!location.hash.startsWith("#/")) history.replaceState(null, "", location.pathname + "#/overview");
      await navigate();
      startPolling();
    } catch (err) {
      if (err.status === 401) return;
      state.token = "";
      if (errorBox) errorBox.textContent = err.message;
      else renderLogin(err.message);
    }
  }

  function signOut(message) {
    state.token = "";
    state.me = null;
    store("clearSession", "wicket-token");
    renderLogin(message);
  }

  // ---------------------------------------------------------------- start

  window.addEventListener("hashchange", navigate);
  document.addEventListener("keydown", (e) => {
    // Press "/" anywhere to jump to the request list.
    if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName) && state.me) { e.preventDefault(); go("requests"); }
  });

  (function boot() {
    // A token or theme in the address (after the route) is taken once and removed from the bar.
    const [path, ...rest] = location.hash.slice(1).split("&");
    const params = new URLSearchParams(rest.join("&"));
    const theme = params.get("theme") || store("get", "wicket-theme");
    applyTheme(theme);
    const token = params.get("token") || store("get", "wicket-token");
    if (rest.length) history.replaceState(null, "", location.pathname + (path ? "#" + path : ""));
    if (token) signIn(token, null);
    else renderLogin("");
  })();
})();
