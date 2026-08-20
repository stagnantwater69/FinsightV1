-- Isolation Forest shadow mode: two additive enum values.
--
-- ML_OUTLIER  — findings produced by the multivariate Isolation Forest
--               detector, distinct from the rule-based types so summaries and
--               the review queue can tell model findings from rule findings.
-- SHADOW      — a storage-level "persisted for evaluation, invisible to the
--               owner" status. OPEN findings are rendered by both clients and
--               fed to Ask FinSight, so a detector under evaluation must be
--               silenced at the status level, not via severity.
--
-- Both are pure additions: no existing rows change, no defaults change, and
-- rollback is simply "the flag stays off and no rows ever carry these values".
ALTER TYPE "AnomalyFindingType" ADD VALUE 'ML_OUTLIER';
ALTER TYPE "AnomalyFindingStatus" ADD VALUE 'SHADOW';
