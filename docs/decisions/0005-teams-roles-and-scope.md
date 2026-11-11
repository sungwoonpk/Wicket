# 0005. Teams are the unit of tenancy, and admins have a role and an optional team

Status: accepted

## Context

One gateway serves several groups inside a company. Support should not see finance's traffic or approvals, a
person who reviews approvals should not be able to change policy, and nobody should be locked out if a key is lost.

## Decision

- An **agent belongs to one team**. A team is created the first time it is used, or by an owner.
- An **admin user** has a key (`wa_...`), a **role** and an optional **team**. Roles are ordered:
  `viewer < approver < admin < owner`, and each includes the ones below it.
  - viewer: read
  - approver: decide approvals
  - admin: manage agents and team policy, read providers
  - owner: everything, including users, teams, providers and the organization policy
- A user with a team sees and changes **only that team**: agents, requests, summaries, charts, approvals and policy.
  The audit trail and provider list span the whole gateway, so they need access to all teams.
- A user without a team may narrow any list with `?team=`. A user with a team cannot widen its view.
- The **environment token** is always accepted as an owner with access to all teams, so an instance can be recovered
  even if every user key is lost or disabled.
- **Policy is per team and replaces the organization policy.** A team with its own policy follows only that.
  A team without one follows the organization policy.
- Role checks run once, in the router, before any handler. Team checks run in the handler that knows the target.
- Every change records who made it in the audit trail, as `role:name`.
- `docs/openapi.yaml` states the minimum role of every admin route, and a test calls each route with a role one step
  below and expects `403`. The documentation and the code cannot disagree without a failing test.

## Costs

- A team policy does not merge with the organization policy. A team that wants "the organization rules plus one more"
  has to copy them. Merging has real ambiguity (does a team allow override an organization deny?) that this avoids.
- Roles are fixed. There are no custom roles or per-route grants.
- Provider keys and providers are organization wide, not per team.
- Keys are bearer secrets. There is no single sign-on yet.

## Alternatives considered

- **Attribute-based access control.** More expressive, much harder to explain and to test exhaustively.
- **Separate database per tenant.** Stronger isolation, but each team would need its own gateway to operate.
- **OIDC sign-in.** The right next step for a company, and a good later addition. Keys are enough to prove the model.
