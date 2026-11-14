# API

The full description is in [openapi.yaml](openapi.yaml), and a test fails if it drifts from the server. In short:

| Route                                                    | What it does                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /v1/chat/completions`                              | OpenAI-compatible completion, streamed or not (agent key)        |
| `GET /v1/approvals/:id`                                  | An agent polls a held tool call (agent key)                      |
| `/admin/agents`, `/admin/agents/:id`, `.../rotate-key`   | Create, change, disable and rotate agents                        |
| `/admin/policy`, `/admin/policy/simulate`                | Read, replace or remove a policy. Try a call or text against one |
| `/admin/approvals`, `.../:id/approve`, `.../:id/deny`    | Review the queue                                                 |
| `/admin/requests`, `/admin/summary`, `/admin/timeseries` | Traffic, totals and charts                                       |
| `/admin/teams`, `/admin/users`, `/admin/upstreams`       | Organization setup                                               |
| `/admin/audit`, `/admin/audit/head`, `.../verify`        | Read the trail. Get the newest event to keep. Check the chain    |
| `/metrics`, `/healthz`, `/readyz`, `/dashboard`          | Prometheus text, liveness, readiness, the admin page             |
