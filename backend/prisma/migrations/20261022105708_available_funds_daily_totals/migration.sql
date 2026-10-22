-- CreateTable
CREATE TABLE "AvailableFundsDailyTotal" (
    "BusinessProfile_ID" INTEGER NOT NULL,
    "AvailableFundsDailyTotal_Date" DATE NOT NULL,
    "AvailableFundsDailyTotal_SalesAmount" DECIMAL(18,2) NOT NULL,
    "AvailableFundsDailyTotal_SalesCount" INTEGER NOT NULL,
    "AvailableFundsDailyTotal_ExpenseAmount" DECIMAL(18,2) NOT NULL,
    "AvailableFundsDailyTotal_ExpenseCount" INTEGER NOT NULL,

    CONSTRAINT "AvailableFundsDailyTotal_pkey" PRIMARY KEY ("BusinessProfile_ID","AvailableFundsDailyTotal_Date")
);

-- AddForeignKey
ALTER TABLE "AvailableFundsDailyTotal" ADD CONSTRAINT "AvailableFundsDailyTotal_BusinessProfile_ID_fkey" FOREIGN KEY ("BusinessProfile_ID") REFERENCES "BusinessProfile"("BusinessProfile_ID") ON DELETE CASCADE ON UPDATE CASCADE;

-- Application tables are accessible through Express/Prisma only; no client-role policies or grants.
ALTER TABLE public."AvailableFundsDailyTotal" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."AvailableFundsDailyTotal" FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public."AvailableFundsDailyTotal" FROM %I',
                api_role
            );
        END IF;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Keeping the totals current.
--
-- UPDATES AND DELETES RECOMPUTE the affected (business, day) pairs from the
-- records as they now are. A delta there would have to judge a record's old
-- eligibility against batch and receipt state that may already have changed
-- (deleting a batch SETs its records' batch to NULL after the batch is gone),
-- and one wrong delta would stay wrong forever. A recompute cannot drift.
--
-- INSERTS ADD. A new row's contribution is judged against batch and receipt
-- state as it is at that moment, which is exactly what a recompute would add,
-- so adding is equivalent and does not re-read the day's existing rows. That
-- matters for imports: recomputing every day an unsorted 2,000-row chunk
-- touches made a 50,000-row import into a 500,000-record ledger take 24 s
-- instead of 3 s.
--
-- Concurrency: both run under a per-business advisory lock, in the
-- single-bigint lock space (the app's own advisory locks use the two-int
-- space). A second writer to the same business waits; at READ COMMITTED,
-- which every record write uses, a recompute then takes a fresh snapshot that
-- includes the first writer's committed rows, and an addition lands on the
-- first writer's committed total. Without the lock on additions, a concurrent
-- recompute could overwrite an addition with a total from a snapshot that
-- missed the new row. Every path that takes a duplicate write gate takes it
-- before writing records, so this lock is always acquired after the gate and
-- cannot form a cycle with it.
--
-- The eligibility below must match FINAL_EXPENSE_SOURCE / FINAL_SALES_SOURCE
-- and the review/duplicate filters in financialPosition.service.ts.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.finsight_lock_available_funds(profile_ids integer[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    locked_profile integer;
BEGIN
    -- In id order, so two transactions locking several businesses cannot deadlock.
    FOR locked_profile IN
        SELECT DISTINCT profile_id FROM unnest(profile_ids) AS profile_id
        WHERE profile_id IS NOT NULL
        ORDER BY profile_id
    LOOP
        PERFORM pg_advisory_xact_lock(5066068661932883968 + locked_profile);
    END LOOP;
END
$$;

CREATE FUNCTION public.finsight_refresh_available_funds_days(profile_ids integer[], days date[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF profile_ids IS NULL OR cardinality(profile_ids) = 0 THEN
        RETURN;
    END IF;
    PERFORM finsight_lock_available_funds(profile_ids);

    WITH affected AS (
        -- Joined to BusinessProfile so a business being deleted (its records
        -- cascade away) is skipped instead of failing the foreign key.
        SELECT DISTINCT pair.profile_id, pair.day
        FROM unnest(profile_ids, days) AS pair(profile_id, day)
        JOIN "BusinessProfile" business ON business."BusinessProfile_ID" = pair.profile_id
        WHERE pair.day IS NOT NULL
    ),
    sums AS (
        SELECT affected.profile_id, affected.day,
               sales.amount AS sales_amount, sales.n AS sales_count,
               expenses.amount AS expense_amount, expenses.n AS expense_count
        FROM affected
        CROSS JOIN LATERAL (
            SELECT COALESCE(sum(sale."SalesReferenceRecord_Amount"), 0) AS amount, count(*)::integer AS n
            FROM "SalesReferenceRecord" sale
            LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = sale."ImportBatch_ID"
            WHERE sale."BusinessProfile_ID" = affected.profile_id
              AND sale."SalesReferenceRecord_Date" = affected.day
              AND sale."SalesReferenceRecord_ReviewStatus" = 'Reviewed'
              AND sale."SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
              AND sale."DuplicateOf_RecordID" IS NULL
              AND (
                  sale."SalesReferenceRecord_Source" = 'Manual Entry'
                  OR (sale."SalesReferenceRecord_Source" = 'CSV Upload' AND batch."ImportBatch_ProcessingStatus" = 'COMPLETE')
              )
        ) sales
        CROSS JOIN LATERAL (
            SELECT COALESCE(sum(expense."ExpenseRecord_Amount"), 0) AS amount, count(*)::integer AS n
            FROM "ExpenseRecord" expense
            LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = expense."ImportBatch_ID"
            LEFT JOIN "ReceiptScan" scan ON scan."ReceiptScan_ID" = expense."ReceiptScan_ID"
            WHERE expense."BusinessProfile_ID" = affected.profile_id
              AND expense."ExpenseRecord_Date" = affected.day
              AND expense."ExpenseRecord_ReviewStatus" = 'Reviewed'
              AND expense."ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
              AND expense."DuplicateOf_RecordID" IS NULL
              AND (
                  expense."ExpenseRecord_Source" = 'Manual Entry'
                  OR (expense."ExpenseRecord_Source" = 'CSV Upload' AND batch."ImportBatch_ProcessingStatus" = 'COMPLETE')
                  OR (expense."ExpenseRecord_Source" = 'Receipt Scan' AND scan."ReceiptScan_ConfirmationStatus" = 'Confirmed')
              )
        ) expenses
    ),
    emptied AS (
        DELETE FROM "AvailableFundsDailyTotal" total
        USING sums
        WHERE total."BusinessProfile_ID" = sums.profile_id
          AND total."AvailableFundsDailyTotal_Date" = sums.day
          AND sums.sales_count = 0
          AND sums.expense_count = 0
    )
    INSERT INTO "AvailableFundsDailyTotal" (
        "BusinessProfile_ID", "AvailableFundsDailyTotal_Date",
        "AvailableFundsDailyTotal_SalesAmount", "AvailableFundsDailyTotal_SalesCount",
        "AvailableFundsDailyTotal_ExpenseAmount", "AvailableFundsDailyTotal_ExpenseCount"
    )
    SELECT profile_id, day, sales_amount, sales_count, expense_amount, expense_count
    FROM sums
    WHERE sales_count > 0 OR expense_count > 0
    ON CONFLICT ("BusinessProfile_ID", "AvailableFundsDailyTotal_Date") DO UPDATE SET
        "AvailableFundsDailyTotal_SalesAmount" = EXCLUDED."AvailableFundsDailyTotal_SalesAmount",
        "AvailableFundsDailyTotal_SalesCount" = EXCLUDED."AvailableFundsDailyTotal_SalesCount",
        "AvailableFundsDailyTotal_ExpenseAmount" = EXCLUDED."AvailableFundsDailyTotal_ExpenseAmount",
        "AvailableFundsDailyTotal_ExpenseCount" = EXCLUDED."AvailableFundsDailyTotal_ExpenseCount";
END
$$;

-- Records: statement-level, so a 2,000-row CSV chunk is one pass, not 2,000.
-- Rows that fail the record-local filters (not reviewed, a duplicate) were
-- never counted and cannot be, so they are skipped up front; an update counts
-- only when a column the totals depend on changed.

CREATE FUNCTION public.finsight_expense_funds_after_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[];
BEGIN
    SELECT array_agg(DISTINCT "BusinessProfile_ID") INTO ids
    FROM new_rows
    WHERE "ExpenseRecord_ReviewStatus" = 'Reviewed'
      AND "ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
      AND "DuplicateOf_RecordID" IS NULL;
    IF ids IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM finsight_lock_available_funds(ids);

    INSERT INTO "AvailableFundsDailyTotal" (
        "BusinessProfile_ID", "AvailableFundsDailyTotal_Date",
        "AvailableFundsDailyTotal_SalesAmount", "AvailableFundsDailyTotal_SalesCount",
        "AvailableFundsDailyTotal_ExpenseAmount", "AvailableFundsDailyTotal_ExpenseCount"
    )
    SELECT expense."BusinessProfile_ID", expense."ExpenseRecord_Date", 0, 0,
           sum(expense."ExpenseRecord_Amount"), count(*)::integer
    FROM new_rows expense
    LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = expense."ImportBatch_ID"
    LEFT JOIN "ReceiptScan" scan ON scan."ReceiptScan_ID" = expense."ReceiptScan_ID"
    WHERE expense."ExpenseRecord_ReviewStatus" = 'Reviewed'
      AND expense."ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
      AND expense."DuplicateOf_RecordID" IS NULL
      AND (
          expense."ExpenseRecord_Source" = 'Manual Entry'
          OR (expense."ExpenseRecord_Source" = 'CSV Upload' AND batch."ImportBatch_ProcessingStatus" = 'COMPLETE')
          OR (expense."ExpenseRecord_Source" = 'Receipt Scan' AND scan."ReceiptScan_ConfirmationStatus" = 'Confirmed')
      )
    GROUP BY expense."BusinessProfile_ID", expense."ExpenseRecord_Date"
    ON CONFLICT ("BusinessProfile_ID", "AvailableFundsDailyTotal_Date") DO UPDATE SET
        "AvailableFundsDailyTotal_ExpenseAmount" =
            "AvailableFundsDailyTotal"."AvailableFundsDailyTotal_ExpenseAmount" + EXCLUDED."AvailableFundsDailyTotal_ExpenseAmount",
        "AvailableFundsDailyTotal_ExpenseCount" =
            "AvailableFundsDailyTotal"."AvailableFundsDailyTotal_ExpenseCount" + EXCLUDED."AvailableFundsDailyTotal_ExpenseCount";
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_expense_funds_after_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT DISTINCT "BusinessProfile_ID" AS profile_id, "ExpenseRecord_Date" AS day
        FROM old_rows
        WHERE "ExpenseRecord_ReviewStatus" = 'Reviewed'
          AND "ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
          AND "DuplicateOf_RecordID" IS NULL
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_expense_funds_after_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    WITH changed AS (
        SELECT o."BusinessProfile_ID" AS old_profile, o."ExpenseRecord_Date" AS old_day,
               n."BusinessProfile_ID" AS new_profile, n."ExpenseRecord_Date" AS new_day,
               (o."ExpenseRecord_ReviewStatus" = 'Reviewed' AND o."ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
                 AND o."DuplicateOf_RecordID" IS NULL) AS old_counts,
               (n."ExpenseRecord_ReviewStatus" = 'Reviewed' AND n."ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
                 AND n."DuplicateOf_RecordID" IS NULL) AS new_counts
        FROM old_rows o
        JOIN new_rows n ON n."ExpenseRecord_ID" = o."ExpenseRecord_ID"
        WHERE ROW(o."BusinessProfile_ID", o."ExpenseRecord_Date", o."ExpenseRecord_Amount", o."ExpenseRecord_ReviewStatus",
                  o."ExpenseRecord_DuplicateStatus", o."DuplicateOf_RecordID", o."ExpenseRecord_Source",
                  o."ImportBatch_ID", o."ReceiptScan_ID")
              IS DISTINCT FROM
              ROW(n."BusinessProfile_ID", n."ExpenseRecord_Date", n."ExpenseRecord_Amount", n."ExpenseRecord_ReviewStatus",
                  n."ExpenseRecord_DuplicateStatus", n."DuplicateOf_RecordID", n."ExpenseRecord_Source",
                  n."ImportBatch_ID", n."ReceiptScan_ID")
    )
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT old_profile AS profile_id, old_day AS day FROM changed WHERE old_counts
        UNION
        SELECT new_profile, new_day FROM changed WHERE new_counts
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_sales_funds_after_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[];
BEGIN
    SELECT array_agg(DISTINCT "BusinessProfile_ID") INTO ids
    FROM new_rows
    WHERE "SalesReferenceRecord_ReviewStatus" = 'Reviewed'
      AND "SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
      AND "DuplicateOf_RecordID" IS NULL;
    IF ids IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM finsight_lock_available_funds(ids);

    INSERT INTO "AvailableFundsDailyTotal" (
        "BusinessProfile_ID", "AvailableFundsDailyTotal_Date",
        "AvailableFundsDailyTotal_SalesAmount", "AvailableFundsDailyTotal_SalesCount",
        "AvailableFundsDailyTotal_ExpenseAmount", "AvailableFundsDailyTotal_ExpenseCount"
    )
    SELECT sale."BusinessProfile_ID", sale."SalesReferenceRecord_Date",
           sum(sale."SalesReferenceRecord_Amount"), count(*)::integer, 0, 0
    FROM new_rows sale
    LEFT JOIN "CSVImportBatch" batch ON batch."ImportBatch_ID" = sale."ImportBatch_ID"
    WHERE sale."SalesReferenceRecord_ReviewStatus" = 'Reviewed'
      AND sale."SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
      AND sale."DuplicateOf_RecordID" IS NULL
      AND (
          sale."SalesReferenceRecord_Source" = 'Manual Entry'
          OR (sale."SalesReferenceRecord_Source" = 'CSV Upload' AND batch."ImportBatch_ProcessingStatus" = 'COMPLETE')
      )
    GROUP BY sale."BusinessProfile_ID", sale."SalesReferenceRecord_Date"
    ON CONFLICT ("BusinessProfile_ID", "AvailableFundsDailyTotal_Date") DO UPDATE SET
        "AvailableFundsDailyTotal_SalesAmount" =
            "AvailableFundsDailyTotal"."AvailableFundsDailyTotal_SalesAmount" + EXCLUDED."AvailableFundsDailyTotal_SalesAmount",
        "AvailableFundsDailyTotal_SalesCount" =
            "AvailableFundsDailyTotal"."AvailableFundsDailyTotal_SalesCount" + EXCLUDED."AvailableFundsDailyTotal_SalesCount";
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_sales_funds_after_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT DISTINCT "BusinessProfile_ID" AS profile_id, "SalesReferenceRecord_Date" AS day
        FROM old_rows
        WHERE "SalesReferenceRecord_ReviewStatus" = 'Reviewed'
          AND "SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
          AND "DuplicateOf_RecordID" IS NULL
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_sales_funds_after_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    WITH changed AS (
        SELECT o."BusinessProfile_ID" AS old_profile, o."SalesReferenceRecord_Date" AS old_day,
               n."BusinessProfile_ID" AS new_profile, n."SalesReferenceRecord_Date" AS new_day,
               (o."SalesReferenceRecord_ReviewStatus" = 'Reviewed' AND o."SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
                 AND o."DuplicateOf_RecordID" IS NULL) AS old_counts,
               (n."SalesReferenceRecord_ReviewStatus" = 'Reviewed' AND n."SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
                 AND n."DuplicateOf_RecordID" IS NULL) AS new_counts
        FROM old_rows o
        JOIN new_rows n ON n."SalesReferenceRecord_ID" = o."SalesReferenceRecord_ID"
        WHERE ROW(o."BusinessProfile_ID", o."SalesReferenceRecord_Date", o."SalesReferenceRecord_Amount",
                  o."SalesReferenceRecord_ReviewStatus", o."SalesReferenceRecord_DuplicateStatus",
                  o."DuplicateOf_RecordID", o."SalesReferenceRecord_Source", o."ImportBatch_ID")
              IS DISTINCT FROM
              ROW(n."BusinessProfile_ID", n."SalesReferenceRecord_Date", n."SalesReferenceRecord_Amount",
                  n."SalesReferenceRecord_ReviewStatus", n."SalesReferenceRecord_DuplicateStatus",
                  n."DuplicateOf_RecordID", n."SalesReferenceRecord_Source", n."ImportBatch_ID")
    )
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT old_profile AS profile_id, old_day AS day FROM changed WHERE old_counts
        UNION
        SELECT new_profile, new_day FROM changed WHERE new_counts
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

-- A batch crossing COMPLETE, or a receipt crossing Confirmed, changes whether
-- its records count without touching them.

CREATE FUNCTION public.finsight_batch_funds_after_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT "BusinessProfile_ID" AS profile_id, "ExpenseRecord_Date" AS day
        FROM "ExpenseRecord"
        WHERE "ImportBatch_ID" = NEW."ImportBatch_ID"
          AND "ExpenseRecord_ReviewStatus" = 'Reviewed'
          AND "ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
          AND "DuplicateOf_RecordID" IS NULL
        UNION
        SELECT "BusinessProfile_ID", "SalesReferenceRecord_Date"
        FROM "SalesReferenceRecord"
        WHERE "ImportBatch_ID" = NEW."ImportBatch_ID"
          AND "SalesReferenceRecord_ReviewStatus" = 'Reviewed'
          AND "SalesReferenceRecord_DuplicateStatus" = 'Not a Duplicate'
          AND "DuplicateOf_RecordID" IS NULL
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

CREATE FUNCTION public.finsight_receipt_funds_after_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ids integer[]; days date[];
BEGIN
    SELECT array_agg(pair.profile_id), array_agg(pair.day) INTO ids, days
    FROM (
        SELECT DISTINCT "BusinessProfile_ID" AS profile_id, "ExpenseRecord_Date" AS day
        FROM "ExpenseRecord"
        WHERE "ReceiptScan_ID" = NEW."ReceiptScan_ID"
          AND "ExpenseRecord_ReviewStatus" = 'Reviewed'
          AND "ExpenseRecord_DuplicateStatus" = 'Not a Duplicate'
          AND "DuplicateOf_RecordID" IS NULL
    ) pair;
    PERFORM finsight_refresh_available_funds_days(ids, days);
    RETURN NULL;
END
$$;

CREATE TRIGGER "ExpenseRecord_available_funds_insert" AFTER INSERT ON "ExpenseRecord"
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_expense_funds_after_insert();
CREATE TRIGGER "ExpenseRecord_available_funds_update" AFTER UPDATE ON "ExpenseRecord"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_expense_funds_after_update();
CREATE TRIGGER "ExpenseRecord_available_funds_delete" AFTER DELETE ON "ExpenseRecord"
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_expense_funds_after_delete();

CREATE TRIGGER "SalesReferenceRecord_available_funds_insert" AFTER INSERT ON "SalesReferenceRecord"
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_sales_funds_after_insert();
CREATE TRIGGER "SalesReferenceRecord_available_funds_update" AFTER UPDATE ON "SalesReferenceRecord"
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_sales_funds_after_update();
CREATE TRIGGER "SalesReferenceRecord_available_funds_delete" AFTER DELETE ON "SalesReferenceRecord"
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.finsight_sales_funds_after_delete();

CREATE TRIGGER "CSVImportBatch_available_funds_status" AFTER UPDATE OF "ImportBatch_ProcessingStatus" ON "CSVImportBatch"
    FOR EACH ROW
    WHEN ((OLD."ImportBatch_ProcessingStatus" = 'COMPLETE') IS DISTINCT FROM (NEW."ImportBatch_ProcessingStatus" = 'COMPLETE'))
    EXECUTE FUNCTION public.finsight_batch_funds_after_update();

CREATE TRIGGER "ReceiptScan_available_funds_confirmation" AFTER UPDATE OF "ReceiptScan_ConfirmationStatus" ON "ReceiptScan"
    FOR EACH ROW
    WHEN ((OLD."ReceiptScan_ConfirmationStatus" = 'Confirmed') IS DISTINCT FROM (NEW."ReceiptScan_ConfirmationStatus" = 'Confirmed'))
    EXECUTE FUNCTION public.finsight_receipt_funds_after_update();

-- None of these are for the Data API: no client role may call them.
DO $$
DECLARE
    api_role TEXT;
    fn TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'finsight_lock_available_funds(integer[])',
        'finsight_refresh_available_funds_days(integer[], date[])',
        'finsight_expense_funds_after_insert()', 'finsight_expense_funds_after_update()', 'finsight_expense_funds_after_delete()',
        'finsight_sales_funds_after_insert()', 'finsight_sales_funds_after_update()', 'finsight_sales_funds_after_delete()',
        'finsight_batch_funds_after_update()', 'finsight_receipt_funds_after_update()'
    ]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', fn);
        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
        LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
                EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', fn, api_role);
            END IF;
        END LOOP;
    END LOOP;
END
$$;

-- Backfill every day that holds a record.
SELECT public.finsight_refresh_available_funds_days(array_agg(pair.profile_id), array_agg(pair.day))
FROM (
    SELECT "BusinessProfile_ID" AS profile_id, "ExpenseRecord_Date" AS day FROM "ExpenseRecord"
    UNION
    SELECT "BusinessProfile_ID", "SalesReferenceRecord_Date" FROM "SalesReferenceRecord"
) pair;
