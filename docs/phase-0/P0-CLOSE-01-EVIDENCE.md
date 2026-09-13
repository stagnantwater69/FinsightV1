# P0-CLOSE-01 closure evidence

**Closed:** 13 September 2026

**Scope:** repository checkpoint and Prisma/Supabase migration provenance

**Result:** COMPLETE for starting local Phase 1 implementation. This result does not approve real-owner rollout or make a physical-camera or receipt-accuracy claim.

## Repository checkpoint

Runtime commit `20d011ec8c51fb026abb1d29b53c4f8a196227b7` changes 128 repository files relative to `50d7a1f53e69f493b30cb8e8b25ab66f830a3bc2`. The commit contains 6,182 insertions and 871 deletions.

Immediately after the commit, Git reported no tracked change and 18 visible untracked local-only path entries. The older documentation, agent configuration, browser traces, review screenshots, planning files, UAT helpers, and skill-observation files remain outside the runtime checkpoint under the repository's prior untracking policy. They are not needed to build or test the checkpoint.

`RECEIPTS/` is explicitly ignored. No receipt image, COCO annotation file, populated consent manifest, credential file, private key, access token, browser trace, review screenshot, or agent-chat file was staged. A high-confidence staged-content pattern scan reported zero secret findings. `web/.env.example` contains placeholders only.

The checkpointed runtime Git tree has 1,215 entries. The SHA-256 of this exact command output is `15c4fc3b4616f0780a2b143c7f181b2053b868ced9f2fab210f353675d498a6d`:

```bash
git ls-tree -r --full-tree 20d011ec8c51fb026abb1d29b53c4f8a196227b7 -- \
  .github/workflows backend docker-compose.yml mobile ml nginx \
  scripts/check-type-parity.mjs web
```

The checkpoint is local. No push was performed.

## Migration artifact recovery

The hosted `_prisma_migrations` row supplied the expected SHA-256 for `20260804140000_receipt_field_corrections`:

`26f844620564e83919cc75393594e7028c8b77d8c6d658990d28ba075271d7fa`

Hashing the repository's reachable and unreachable Git blobs located an exact 3,503-byte match at blob `80d438a71a1a64def5ba2b4e54cb2015595e4612`. The working migration was restored byte-for-byte from that object. `cmp` and SHA-256 verification passed.

The previous working copy contained one later-added RLS statement plus comments. The immediately following applied migration, `20260806153854_secure_application_tables_from_data_api`, already enables RLS on `ReceiptFieldCorrection`. Restoring the deployed bytes therefore preserves the final schema and removes the history mismatch.

The hosted-applied `20260910152035_receipt_upload_idempotency` migration is tracked in commit `20d011e`. Its local and hosted SHA-256 is:

`3b5139f660bfb4aa5bffe1e9cf55ab609020a23b6f5855ec63e1d5393bc76fdf`

All 39 migration SQL files are now tracked. Their combined sorted per-file SHA-256 is:

`87c75ea2f583c37d81be14f69ecaadb90df2cdbe980bb72bb820ceceda56216d`

## Validation evidence

`npm run migrate:validate` passed all six stages against fresh disposable PostgreSQL 16:

1. generated SQL from an empty database;
2. validated the Prisma schema;
3. applied all 39 migrations;
4. reported the scratch database up to date;
5. passed 1,983 backend tests in 137 files with one expected skip;
6. removed the scratch database.

The disposable `finsight-test-db` was removed after validation. No scratch or test container remained.

The remaining gates were then rerun with `HEAD` fixed at `20d011e`:

- web typecheck, lint, build, and bundle budget passed;
- all 685 web tests in 80 files passed;
- all 10 mocked Chromium journeys passed;
- mobile typecheck and lint passed;
- all 983 mobile tests in 92 files passed;
- all 91 shared exported type names matched;
- all 13 ML worker tests passed;
- `git diff --check` passed.

The tracked tree was unchanged before and after those commands. The test database remained absent, the temporary Playwright server stopped, and no external OCR, AI, Auth, Storage, or Supabase call was made. The combined checkpoint evidence is 3,674 passing tests with one expected backend skip. Browser and mobile automation still use mocked providers and camera surfaces.

The hosted verification was read-only:

- Prisma status reported 39 migrations and an up-to-date database.
- Hosted-to-schema diff reported no difference.
- The ledger contains 39 successful unique migrations plus one zero-step rolled-back historical attempt.
- There is no missing local migration, unapplied local migration, or successful-row checksum mismatch.
- All 29 public tables have RLS, including `_prisma_migrations` and `ReceiptFieldCorrection`.
- `anon` and `authenticated` have zero effective application-table privileges and no usage on all 26 public sequences.
- Public and Storage policy counts remain zero. Direct client access stays denied.

No `prisma migrate resolve`, hosted DDL, hosted DML, migration application, Storage mutation, or Auth mutation was performed.

## Remaining Phase 0 release gates

The following work may continue in parallel with Phase 1 implementation:

- collect and independently verify the eligible consented receipt corpus;
- declare and test two physical Android targets with predeclared memory ceilings;
- classify the hosted account and stored data as synthetic-only or real-owner, then apply the matching password, signup, backup, and cost controls.

Until those gates close, keep real receipts on the local OCR and owner-review path. A configured Gemini key must not be present in a receipt worker that handles real receipts, and `VERYFI_ENABLED` must remain `false` until the Phase 1 fail-closed provider gate is complete.
