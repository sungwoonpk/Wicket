# Teams and roles

| Role       | Can                                                                        |
| ---------- | -------------------------------------------------------------------------- |
| `viewer`   | Read agents, requests, approvals, policy and charts. Use the policy tester |
| `approver` | Everything a viewer can, and approve or deny held tool calls               |
| `admin`    | Everything above, and manage agents and team policy, read providers        |
| `owner`    | Everything: users, teams, providers and the organization policy            |

A user can be limited to one team. They then see and change only that team, and cannot reach the audit trail or provider list, which span the whole gateway. The environment token is always an owner with access to all teams. [ADR 0005](decisions/0005-teams-roles-and-scope.md) explains the choices. The OpenAPI file states the minimum role of every route, and a test calls each route one role below to prove it.
