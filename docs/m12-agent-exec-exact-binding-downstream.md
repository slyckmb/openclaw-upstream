# M12 downstream OpenClaw exact-binding patch

Parent: slyckmb/projects#12 (M12)  
Acceptance/proof owner: slyckmb/projects#25  
Upstream source: openclaw/openclaw#158600 and PR #158615

## Decision

M12 will not wait for upstream OpenClaw acceptance or merge of the exact-binding fix.

OpenClaw remains the owner of in-run fallback semantics. The operator may carry the smallest reviewed downstream patch required to preserve exact per-candidate execution binding. Upstream PR #158615 remains the preferred source and should continue upstream normally, but upstream acceptance is no longer a production gate.

This does not reactivate M11 / Gateway Option A.

## Scope

Carry only the bounded exact-binding repair required by projects#25:

- preserve explicit primary/fallback binding as candidate identity;
- keep same provider/model candidates distinct when bindings differ;
- enforce explicit binding as a hard binding, not a preference;
- prevent ambient same-provider credential substitution for bound candidates;
- keep binding-specific failure distinct from provider-wide failure;
- preserve existing one-run fallback, transcript/workspace continuity, exhaustive explicit-chain semantics, and replay-safety gates;
- preserve unbound candidate behavior;
- never move secret ownership into Airo.

Do not absorb upstream #155381 or #155382 unless a direct code dependency makes a minimal supporting change unavoidable.

## Ordered implementation plan

1. Freeze the exact upstream OpenClaw baseline/version and exact #158615 patch head/diff.
2. Port only that bounded patch onto the pinned baseline in this PR.
3. Run focused regression validation for candidate identity, exact primary/fallback binding, same-provider binding A -> binding B, failure scope, cross-provider fallback, unbound compatibility, replay safety, exhaustive-chain behavior, and secret/logging safety.
4. Obtain independent exact-head review of auth/security boundaries, credential substitution risk, failure scoping, replay behavior, and backwards compatibility.
5. Build a versioned operator-managed runtime alongside the current known-good runtime. Record upstream baseline + exact patch head and preserve immediate rollback.
6. Execute the projects#25 live proof with 2+ exact eligible bindings in one `agent exec` run: force A to fail safely, prove B succeeds only with its specified binding, no auth substitution, no ambient fallback, clean temporary-state cleanup, and no intentional PAYG.
7. Promote only after that proof passes. Then projects#25 may close the exact-binding gate and Airo Wave B / PR #84 may proceed toward production use subject to remaining accepted #78 gates.
8. Continue tracking upstream #158615. If upstream later lands an equivalent or better fix, remove this patch only after parity proof. Rebase and re-review before future runtime upgrades if upstream changes touch this seam.

## Acceptance

- reproducible pinned upstream baseline + patch provenance;
- focused tests and repository-required validation PASS;
- independent exact-head review PASS;
- versioned patched runtime built with rollback preserved;
- projects#25 live 2+ candidate proof PASS;
- no secret values enter Airo or patch metadata;
- upstream merge is not required for completion;
- ordinary defects are fixed in this path; reconsider M11 only for genuine architectural failure.
