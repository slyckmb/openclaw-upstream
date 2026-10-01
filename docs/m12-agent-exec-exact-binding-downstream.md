# M12 downstream OpenClaw exact-binding patch

Parent: slyckmb/projects#12 (M12)

Acceptance/proof owner: slyckmb/projects#25
Upstream source: openclaw/openclaw#158600 and PR #158615

## Provenance

- Pinned downstream baseline: this fork's `main` at `a27f7fe56c2868d89a60db534f9dcd041fe2fdda`
  (an ancestor of `openclaw/openclaw` `main`; reachable, pushed, exact).
- Exact upstream patch source: `openclaw/openclaw#158615`
  (`fix(agent): preserve exact auth bindings in explicit fallback chains`),
  head `545378d48a715eeeb7eff3f8d041bf041f482ba4`, still OPEN/unmerged upstream at
  time of porting.
- The upstream diff does not apply mechanically (`git apply --check` fails: file
  structure has drifted, e.g. `model-selection.configured.test.ts` does not exist
  at this baseline). The patch below is a manual, behavior-equivalent port onto
  this baseline's actual file structure, not a literal cherry-pick.
- Known gap: the operator's actual currently-deployed OpenClaw runtime is far
  ahead of this baseline (built from `upstream/release/2026.9.3` plus local
  unpushed commits in `/home/michael/dev/vendor/runtimes/openclaw-1be78179`).
  Building the versioned patched runtime (plan step 5) will require forward-
  porting/rebasing this patch onto that actual baseline before use; that is
  intentionally out of scope for this PR (no production runtime mutation here).

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

## Slice G finding (2026-10-01): provider-level SecretRef providers have no selectable exact profile

Steps 1-5 of the ordered plan above are complete: #2 and the #7 forward-port are merged,
and the deployed A2b runtime is `947f9112c9c836330f4c7790f677b0f06cc1be3d`, byte-identical
to the merge of #7 then #8. Step 6 (the projects#25 live 2+ candidate proof) is blocked by
the following gap, which is not a patch defect but a missing binding case.

### The gap

A provider whose credential is bound at the **provider level** rather than as a selectable
per-candidate auth profile cannot satisfy exact candidate binding.

Cloudflare resolves its credential through `models.providers.cloudflare.apiKey`, an
exec-source SecretRef via the `wrangler` secret provider. No per-candidate OpenClaw auth
profile exists for it, and none appears in any backup of `~/.openclaw/openclaw.json` back to
Aug 23. Myclaw declares the binding on its side:

```yaml
# settings/model-policy.yaml -> cost_policy.zero_invariants
cloudflare-workers-free-qwen3-8-27b:
  provider: cloudflare
  auth_profile: cloudflare-workers-ai-token   # no live counterpart
  binding_scope: account
  max_proof_age_seconds: 60
```

Myclaw projects that into the selector as `route@auth_profile`
(`scripts/models:9011`) and dispatches it (`scripts/models:4996`). The runtime parses the
`@profile` suffix as an **explicit** profile selection and hard-fails.

### Exact failure site

`src/agents/embedded-agent-runner/model.registry-resolution.ts:242-250`

```ts
if (explicitProfileId && !credential && configuredMode !== "aws-sdk") {
  // Credential-scoped discovery cannot distinguish a missing model after its
  // profile is removed.
  throw createSelectedAuthProfileUnavailableError({ provider, modelId, profileId });
}
```

`src/agents/auth-profiles/selection-error.ts` then emits
`Selected auth profile "cloudflare-workers-ai-token" is unavailable.` with
`code: selected_auth_profile_unavailable`, `reason: auth`, `status: 401`.

That fail-closed behavior is **deliberate and correct** — it refuses to substitute another
credential. It is the intended consequence of #7 (exact candidate binding precedence over
ambient/session auth selection) plus #8 (exact-chain provider secret isolation).

### Reproduction (live, ZERO, no paid spend)

```
$ openclaw agent --agent worker-zero \
    --model 'cloudflare/@cf/qwen/qwen3.8-27b@cloudflare-workers-ai-token' ...
preflight rejected before execution:
  Selected auth profile "cloudflare-workers-ai-token" is unavailable.
  | selected_auth_profile_unavailable
```

Reached through the sanctioned Myclaw front door, which fails closed the same way and spends
no inference:

```
$ scripts/models onboard 'cloudflare/@cf/qwen/qwen3.8-27b' --role worker \
    --source 'slyckmb/projects#25 M12 Slice G'
{"summary":"HOLD","reason_code":"qualification_blocked",
 "roles":{"worker":{"qualification_state":"blocked",
   "reason":"... Selected auth profile \"cloudflare-workers-ai-token\" is unavailable."}}}
```

The same path also blocks the already-qualified sibling
`cloudflare/@cf/zai-org/glm-4.7-flash`, so this is a **family** gap, not one route.

Why GLM qualified on 2026-09-17 and cannot now: #7 merged 2026-09-29, after that
qualification. Before #7 the `@profile` suffix was not retained as a per-candidate binding,
so the Cloudflare route resolved by provider and qualified. GLM is additionally the configured
`worker-zero` primary, so its binding resolves by default rather than by selection. This is
exactly the defect projects#25 predicted: "a trailing `@profile` is not retained as a
per-candidate binding."

### Acceptance for this gap

1. An exact candidate whose binding is a provider-level SecretRef resolves that provider
   credential as an exact binding, never falling back to ambient/session selection and never
   substituting another profile.
2. Exact candidate binding precedence from #7 is preserved unchanged for selectable-profile
   providers.
3. The deliberate `selected_auth_profile_unavailable` fail-closed path is preserved for a
   genuinely absent **explicitly selected** profile; a removed profile must not silently
   resolve.
4. Provider-level resolution does not promote unrelated provider SecretRefs into startup
   requirements (preserve #8).
5. Regression coverage: a Cloudflare-shaped provider-level-binding candidate executes on its
   exact binding, under one `agent exec`, while an explicitly selected but absent profile
   still fails closed.
6. No credential value, secret authority, or generated config enters Myclaw or Airo; profile
   resolution stays in the runtime's canonical owner context.

### Candidate resolutions (not yet decided)

- **(a) Runtime.** Teach exact candidate resolution to honor a provider-level binding when no
  selectable profile exists. Keeps binding semantics in one place, but relaxes a deliberate
  fail-closed path, so it needs strong negative tests.
- **(b) Myclaw.** Distinguish a *selectable profile id* from a *provider-level binding label*
  in `zero_invariants` and omit `@profile` from the selector for the latter. Smallest change
  and no runtime weakening, but splits binding semantics across repos and requires the
  exact-binding contract to accept a profile-less exact binding.
- **(c) Operator live config.** Declare a real `cloudflare-workers-ai-token` OpenClaw auth
  profile. Fastest unblock, but a credential/secret-ownership change needing its own reviewed
  change and non-secret evidence, and it does not generalize to other provider-level
  providers.

The operator approved the bounded option of resolving this here rather than in Myclaw. That
approval predates the failure-site evidence above, which narrows the decision, so all three
remain open for the receiving manager to adjudicate.
