# P1-OPS-03 implementation evidence

Date: 2026-09-13 (Asia/Manila)

Scope: local repository and disposable/local test infrastructure only. No
hosted setting, secret, provider account, Storage bucket, billing control, or
real receipt was changed.

## Automated local evidence

| Check | Result |
|---|---|
| `npm run typecheck` from `backend/` | PASS |
| `npm run lint` from `backend/` | PASS with no errors; reported warnings are outside the OPS-03 files |
| `sh -n backend/docker/*.sh` | PASS |
| `docker compose config --quiet` | PASS |
| `git diff --check` | PASS |
| `bash backend/docker/verify-receipt-worker-readiness.sh` | PASS: running probe passed, stopped probe failed, arbitrary private root rejected without marker removal |
| `bash backend/docker/verify-receipt-upload-orphan-sweep.sh` | PASS: active preserved, stale removed, candidate symlink not followed, arbitrary and nonnormalized roots rejected, parent symlink rejected, sentinel files preserved |
| `bash backend/docker/verify-api-entrypoint-signal.sh` | PASS: entrypoint waited for graceful child shutdown and propagated its exit status |
| `npm run ops:receipt-provider:smoke` | PASS: seven of seven scenarios, zero provider network calls |
| `npm run ops:receipt-provider:status -- --require-disabled` with a placeholder credential present | PASS: provider disabled, zero provider network calls |
| `npm run ops:receipt-queue:smoke` | PASS: stale `SUBMITTED` evidence changed readiness to `attention`; output reported status and counts only |
| `npm run ops:receipt-queue:readiness` against the migrated local Phase 1 test database | PASS: explicit read-only transaction, database and migrations ready, no unsafe provider budget, stale reservation, stale submitted call, or ambiguous dispatch |
| `env -u DATABASE_URL npm run ops:receipt-queue:readiness` | PASS: failed closed with `DATABASE_URL_INVALID` before importing the generated client |
| Mock-adapter concurrent budget test | PASS: concurrent reservations never exceeded either the resource or per-business cap and made no live provider call |
| Stale-worker output isolation test | PASS: a reclaimed attempt kept its scan, page, and item output; the prior worker waited on the row lock and then failed its lease guard without writing |

The local queue-readiness runs observed synthetic processing work created and
updated by the concurrent test session, including scheduled and claimable
states. This proves only the status/count contract; it is not release
queue-recovery evidence.

CI now repeats the provider configuration scenarios, the stale-submitted
queue smoke, the live queue readiness probe, both isolated cleanup drills, the
API signal drill, Docker target/entrypoint assertions, a live worker-container
health probe, the network-blocked cold local OCR check, and the
configured-language failure check. Those new CI steps are implementation, not
evidence of a hosted run, until the workflow completes on the branch.

## Manual or release-only evidence still required

- [ ] Run API liveness and database readiness through the deployed edge.
- [ ] Run `finsight-worker-readiness` inside the deployed worker container.
- [ ] Run the stopped-worker and forced stale-lease queue-recovery drill using
      synthetic data in a disposable deployment.
- [ ] Run a provider-disable drill and prove local OCR completes while provider
      dispatch counts remain unchanged.
- [ ] Rotate a disposable provider secret while the kill switch is active, then
      revoke the old secret only after all independent readiness checks pass.
- [ ] Roll API and worker images back independently to known prior tags in a
      disposable deployment.
- [ ] Apply and verify the private Storage bucket contract on the target project.
- [ ] For a real-data Supabase Pro target only, complete the organization Spend
      Cap, excluded usage/add-on, included compute, upcoming invoice, and owner
      approval checklist in private evidence outside Git.

The Supabase Pro checklist is deliberately not marked complete. Local tests
cannot establish a billing dashboard state, and a synthetic-only eligible Free
project does not need to pretend that a Pro control was verified.

## Evidence handling

Operational artifacts may contain statuses, bounded counts, commit/image tags,
and elapsed times. They must not contain receipt text, image or CSV object
paths, filenames, profile or scan identifiers, credentials, payment details,
or financial record values.
