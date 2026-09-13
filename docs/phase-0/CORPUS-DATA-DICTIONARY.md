# Phase 0 corpus data dictionary

The two CSV files in this directory are header-only examples. Do not add real rows to the tracked files. Copy them to approved encrypted storage outside the repository, then store receipt images, populated manifests, pair labels, and ground truth together under the same restricted corpus access policy.

Freeze the populated manifest, pair labels, and ground-truth hashes before the first provider or model result is opened. Provider output must never be included in the ground-truth file or its pre-run hash.

## Receipt intake fields

| Field | Required rule |
| --- | --- |
| `sample_id` | Opaque unique artifact ID. Do not use a person's name, email, vendor account, or original filename. |
| `receipt_id` | Opaque logical receipt or purchase ID. Every page, segment, derived variant, and recapture of the same physical receipt uses the same value. Use `NOT_APPLICABLE` for a non-receipt. |
| `capture_attempt_id` | Opaque acquisition-attempt ID. Pages and segments from one capture share it; a recapture gets a new value while retaining the same `receipt_id`. |
| `benchmark_count_role` | One of `PRIMARY_RECEIPT`, `SAME_RECEIPT_SUPPORT`, `RECAPTURE_ROBUSTNESS`, `DERIVED_NOT_COUNTED`, `NON_RECEIPT`, or `EXCLUDED`. Exactly one eligible row per receipt ID is `PRIMARY_RECEIPT`. |
| `source_class` | One of `CONSENTED_OWNER`, `PUBLIC_LICENSED`, `SYNTHETIC`, or `SYNTHETIC_DEGRADED`. Only `CONSENTED_OWNER` can fill the Phase 0 consented-real minimum. |
| `consent_record_id` | Opaque reference to the separately stored consent record. Required for `CONSENTED_OWNER`. |
| `consent_scope_version` | Exact approved consent text/version. Never infer consent from possession of an image. |
| `donor_pseudonym` | Non-identifying corpus subject code. Keep the identity map separate, encrypted, and access-restricted if one is necessary. |
| `captured_at_utc`, `intake_at_utc`, `retention_expires_at_utc` | ISO 8601 UTC timestamps such as `2026-09-13T08:30:00Z`. |
| `capture_device_model` | Exact manufacturer/model recorded by the tester. Do not infer it from image metadata after metadata has been stripped. |
| `android_os_api` | Android version and API number when Android captured the sample; otherwise `NOT_ANDROID`. |
| `app_build` | Exact build/version identifier, or `EXTERNAL_CAPTURE` for approved external corpus material. |
| `capture_mode` | One of `ANDROID_CUSTOM_STANDARD`, `ANDROID_CUSTOM_LONG`, `ANDROID_MANUAL`, `ANDROID_ML_KIT`, `IOS_MANUAL`, `WEB_UPLOAD`, or `EXTERNAL_DATASET`. |
| `language_tags` | Pipe-separated BCP 47 tags, for example `en-PH|fil-PH`. Do not use commas inside a CSV cell. |
| `receipt_type` | One of `THERMAL`, `PLAIN_PAPER`, `SALES_INVOICE`, `HANDWRITTEN`, `MIXED`, `NON_RECEIPT`, or `OTHER_RECORDED`. |
| `condition_tags` | Pipe-separated values from `CLEAN`, `FADED`, `CRUMPLED`, `TILTED`, `SHADOWED`, `GLARE`, `LOW_LIGHT`, `BLURRED`, `DAMAGED`, `LONG`, `HANDWRITTEN_NOTE`, `HANDWRITTEN_FINANCIAL_FIELD`, `MULTI_PAGE`, `MULTI_RECEIPT`, `REPHOTOGRAPHED`, `OBSTRUCTED`, or `OTHER_RECORDED`. |
| `cohort_tags` | Human-reviewed, pipe-separated values from `CLEAN_PRINTED`, `STRESSED_OR_FADED`, `LONG`, `HANDWRITTEN_OR_HAND_ANNOTATED`, `FILIPINO_OR_MIXED_LANGUAGE`, or `DAMAGED_OR_LOW_LIGHT`. Apply the mapping rules below before sealing; tags may overlap. |
| `vendor_template_id` | Opaque normalized layout/vendor-template code used to enforce the 20% maximum. Do not place a vendor name in this field. |
| `page_group_id`, `page_number`, `segment_group_id` | Opaque linkage and one-based order for related pages or long-scan segments. Use `NOT_APPLICABLE` when appropriate. |
| `source_sha256` | Lowercase SHA-256 of the immutable source bytes before provider-specific transformation. |
| `redaction_state` | One of `NONE_NEEDED`, `REDACTED_WITH_MAP`, `REDACTION_PENDING`, or `EXCLUDED_SENSITIVE`. |
| `ground_truth_version` | Monotonic version such as `gt-v1`. Changing a label creates a new version and invalidates an earlier benchmark seal. |
| `ground_truth_reference` | Opaque private-storage reference to the independently transcribed values. Never put receipt text in the manifest. |
| `ground_truth_sha256` | Lowercase SHA-256 of the exact sealed ground-truth artifact, excluding provider/model results. |
| `ground_truth_sealed_at_utc` | ISO 8601 UTC timestamp recorded before the first eligible provider/model run. |
| `ground_truth_reviewer_1`, `ground_truth_reviewer_2` | Two distinct named-custodian IDs. Neither field may identify a model as a reviewer. |
| `permitted_uses` | Pipe-separated subset of `LOCAL_ENGINEERING`, `CAPSTONE_DEMO`, `CLOUD_BENCHMARK`, and `POST_MVP_RESEARCH`. |
| `allowed_cloud_providers` | Pipe-separated explicit providers such as `AZURE_DOCUMENT_INTELLIGENCE`; use `NONE` when cloud use was not granted. A generic true/false value is not enough. |
| `private_storage_reference` | Opaque encrypted-storage reference. Do not use a signed URL or local absolute path. |
| `release_gate_eligible` | `true` only after every applicable field and independent review is complete and permitted use covers the intended run. Otherwise `false`. |
| `exclusion_reason` | Stable code plus short safe note when ineligible, for example `CONSENT_MISSING` or `GROUND_TRUTH_DISPUTED`. |

## Receipt and cohort counting rules

- Count receipts as distinct eligible `receipt_id` values, never as image rows. Exactly one row for each receipt ID must have `benchmark_count_role=PRIMARY_RECEIPT`.
- Additional pages and long segments use `SAME_RECEIPT_SUPPORT`; processed copies use `DERIVED_NOT_COUNTED`; recaptures use `RECAPTURE_ROBUSTNESS`. None adds another receipt, vendor-template, or cohort count.
- A recapture can appear only in a robustness analysis declared before results are opened. It cannot replace the primary attempt after seeing an extraction result.
- Count non-receipts as distinct eligible `sample_id` values with `benchmark_count_role=NON_RECEIPT` and `receipt_id=NOT_APPLICABLE`.
- A source image containing multiple physical receipts needs one logical receipt record and sealed ground truth per physical receipt. Those records may share a source hash and capture-attempt ID, but each has a different receipt ID.
- Calculate the vendor-template ceiling over distinct eligible receipt IDs. Calculate each cohort floor over distinct eligible receipt IDs carrying that sealed cohort tag.

Use these cohort mappings:

| Cohort tag | Inclusion rule |
| --- | --- |
| `CLEAN_PRINTED` | Critical financial fields are machine printed and none of `FADED`, `CRUMPLED`, `TILTED`, `SHADOWED`, `GLARE`, `LOW_LIGHT`, `BLURRED`, `DAMAGED`, `REPHOTOGRAPHED`, or `OBSTRUCTED` applies. |
| `STRESSED_OR_FADED` | A machine-printed receipt has at least one of `FADED`, `CRUMPLED`, `TILTED`, `SHADOWED`, `GLARE`, `BLURRED`, `REPHOTOGRAPHED`, or `OBSTRUCTED`. |
| `LONG` | The complete receipt cannot fit legibly in one declared capture frame and uses ordered pages, long segments, or guided multi-frame capture; `LONG` must also be in `condition_tags`. |
| `HANDWRITTEN_OR_HAND_ANNOTATED` | A material note or any financial field is handwritten; the receipt type or the corresponding handwriting condition tag must support the label. |
| `FILIPINO_OR_MIXED_LANGUAGE` | Receipt content includes Filipino (`fil-PH`) or a Filipino/English mix recorded in `language_tags`; Philippine location alone is not enough. |
| `DAMAGED_OR_LOW_LIGHT` | `DAMAGED` or `LOW_LIGHT` is present in `condition_tags`. |

Both human ground-truth reviewers must agree on the receipt ID, primary row, cohort tags, and ground truth before the manifest is sealed. Disagreement makes the affected receipt ineligible.

## Pair-label fields

| Field | Required rule |
| --- | --- |
| `pair_id` | Opaque unique pair ID. |
| `left_sample_id`, `right_sample_id` | Two different IDs present in the sealed intake manifest. Canonicalize order lexicographically so the same pair is not entered twice. |
| `pair_label` | Exactly `DUPLICATE` or `NON_DUPLICATE`. |
| `relationship_basis` | One of `SAME_PURCHASE_RECAPTURE`, `SAME_FILE_REIMPORT`, `DIFFERENT_PURCHASE_SAME_VENDOR_AMOUNT_DATE`, `DIFFERENT_PURCHASE`, or `OTHER_RECORDED`. |
| `ground_truth_reviewer_1`, `ground_truth_reviewer_2` | Two distinct named-custodian IDs. Disagreement remains ineligible until resolved and versioned. |
| `reviewed_at_utc` | ISO 8601 UTC timestamp. |
| `release_gate_eligible` | `true` only when both samples are eligible for the intended use and both reviewers agree. |
| `exclusion_reason` | Stable safe code when the pair is ineligible. |

## Eligibility checks before a run

1. Validate controlled values and required fields.
2. Verify each source and ground-truth SHA-256 against private storage.
3. Verify each reviewer pair contains two distinct human custodian IDs.
4. Verify consent and `allowed_cloud_providers` cover the exact provider and purpose.
5. Verify the retention expiry occurs after the planned run and review period.
6. Verify cohort, source-class, vendor-template, and pair-label counts against `benchmark-policy-v1.json`.
7. Record a SHA-256 for the sealed populated manifest, pair-label file, and ground-truth bundle before opening any result.
