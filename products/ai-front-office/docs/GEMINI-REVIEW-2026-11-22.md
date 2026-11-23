# Selected-source Gemini review

Reviewer reported by CLI: `gemini-3.1-pro-preview-customtools`. Completed 2026-11-22. Source-only, no tools, no credentials/customer data. Scope: team calendar, team service, assistant config sync and transfer policy. This is not a whole-repository audit or launch approval.

| Finding | Assessment and response |
|---|---|
| Concurrent assistant updates may diverge from DB | Added serialized provider update/rollback lock and shared config locks in owner/admin routes. |
| DB outage can prevent storing rollback pause state | Valid operational gap. Provider disconnect is attempted when provider rollback fails; DB outage itself cannot be repaired by a second write. No claim of atomic cross-provider transaction. Requires reconciliation/live fault test. |
| Formatting bypasses transfer-loop equality | Canonical US numbers used for all comparisons; unknown caller identity refuses transfer. Added regressions. |
| Repeated invites can grow secret storage | Rate-limited authenticated invitation creation. No unsolicited invitation SMS/email sending. Expired-secret cleanup remains future hardening. |
| Malformed team event JSON throws | Added bounded encoding/shape validation and stable rejection. IDs are backend-stored, not a caller-supplied booking API; no demonstrated process crash. |
| Account created before token invalidation | Token now consumed first under tenant lock. Failure requires a new invitation instead of leaving a reusable bearer token after account creation. |

Follow-up fixes must be judged by tests and provider evidence, not reviewer agreement. Full codebase/security/UX reviews by all three named vendors remain incomplete.
