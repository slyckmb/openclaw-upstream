# Protected execution: successor scope (gaps 2–4)

Status: DRAFT contract. No code in this PR yet.
Predecessor: slyckmb/openclaw-upstream PR #25 (scope A reviewed at 4d7e2aea34a97a710625b44328bfd271d9a50c0e).
Predecessor review request: https://github.com/slyckmb/openclaw-upstream/pull/25#issuecomment-6619820014

## Objective

Protected agent runs must not reach host code that can write outside their approved boundary. PR #25 covers the sessionless protected-host denial (A1), the operator floor check (B1), and the CLI admission gate. This successor covers what remains.

## In scope

1. **Gap 2 — embedded-run plugin hooks.** Plugin hook dispatch for protected sessions in non-CLI runs is not gated. Mechanism is an open owner decision:
   - X: one protected-run flag, set when a required session's run starts and checked at a single hook dispatch point. Needs owner acceptance; the flag must not be lost when hooks fire outside the run's async context.
   - Y: per-call-site gating by session key, across about 29 agent files plus tool-call hook wrappers.
2. **Gap 3 — remaining host process starts and mkdir sites.** About 132 non-test files start processes; about 55 mkdir sites under src/agents and src/process. Already refused for protected sessions: CLI backend runs (PR #25), MCP stdio via the session MCP runtime, and host exec (sandbox-required check in bash-tools.exec-runtime). Remaining sites need an inventory and a decision per site.
3. **Gap 4 — path and mount attestation.** Research and design only in this PR, unless the operator chooses otherwise.

## Non-goals

- Changing the floor file format or path (B1 contract in PR #25).
- Merging or changing PR #25.
- Changing config defaults or Gateway behavior for unprotected hosts.

## Definition of done

- Every in-scope site either gated fail-closed for protected sessions, or listed with an explicit disposition (gated, out of scope with reason, or follow-up owner).
- Each gate has an offline regression test that fails with the gate disabled and passes with it.
- oxlint, oxfmt, tsgo core, and focused tests pass. Clean-install build passes.
- Independent review on the exact head returns PASS.

## Authority and open decisions

- Gate X or Y: operator decision required before implementation.
- CODEOWNERS for these paths requires @openclaw/openclaw-secops. The operator instructed the manager not to invite that team. The conflict is disclosed; the operator decides how to satisfy owner review.
- Floor digest pinning (detecting a changed floor after startup): operator decision required.

## Dependencies

- Builds on PR #25 A1, B1, and CLI gate. Either merge PR #25 first, or stack this branch on it.
