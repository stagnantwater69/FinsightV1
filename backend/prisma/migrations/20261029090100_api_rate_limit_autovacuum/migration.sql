-- ApiRateLimit is rewritten on nearly every request: each limiter is an upsert
-- on one small row, so the table is mostly dead tuples between vacuums. The
-- default trigger (20% of rows dead) is tuned for large tables that change
-- slowly; on a table this small and this hot it lets dead versions pile up on
-- the shared-budget rows every owner touches, and every upsert then walks them.
--
-- fillfactor leaves room on each page so an update can stay on the same page
-- (a HOT update) instead of writing a new index entry every time.
ALTER TABLE "ApiRateLimit" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 200,
  autovacuum_analyze_scale_factor = 0.05
);
