-- Account lifecycle: User_Status becomes a real enum, plus deletion bookkeeping.
--
-- User_Status was VARCHAR(50) DEFAULT 'Active'. Nothing in the application ever
-- wrote it and only the profile response read it, so every existing row holds
-- the default. The USING clause below still maps case-insensitively rather than
-- assuming that, because a row hand-edited in the Supabase table editor is
-- exactly the kind of thing that would not appear in any code path — and an
-- unmapped value would abort the migration mid-deploy.
--
-- Anything unrecognised becomes ACTIVE: this migration must not be the thing
-- that locks an owner out of their own records.

CREATE TYPE "AccountStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETION_PENDING');
CREATE TYPE "AccountDeletionStage" AS ENUM ('REQUESTED', 'STORAGE_CLEARED', 'AUTH_DELETED');

-- The default has to go before the type change; Postgres cannot cast the
-- existing 'Active' default expression to the new type on its own.
ALTER TABLE public."User" ALTER COLUMN "User_Status" DROP DEFAULT;

ALTER TABLE public."User"
  ALTER COLUMN "User_Status" TYPE "AccountStatus"
  USING (
    CASE upper(trim("User_Status"))
      WHEN 'ACTIVE'               THEN 'ACTIVE'
      WHEN 'SUSPENDED'            THEN 'SUSPENDED'
      WHEN 'PENDING_VERIFICATION' THEN 'PENDING_VERIFICATION'
      WHEN 'DELETION_PENDING'     THEN 'DELETION_PENDING'
      ELSE 'ACTIVE'
    END
  )::"AccountStatus";

ALTER TABLE public."User" ALTER COLUMN "User_Status" SET DEFAULT 'ACTIVE';

ALTER TABLE public."User"
  ADD COLUMN "User_DeletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "User_DeletionStage" "AccountDeletionStage",
  ADD COLUMN "User_DeletionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "User_DeletionLastError" VARCHAR(500);

CREATE INDEX "User_DeletionQueue_idx" ON public."User" ("User_Status", "User_DeletionRequestedAt");

-- Email is the mirror of a Supabase Auth identity, and Supabase lowercases
-- addresses on its side. A case-sensitive unique column here meant the two
-- could disagree, and that Prisma's uniqueness was being enforced only by
-- Supabase happening to reject the duplicate first. Normalise what is already
-- stored; the Zod schemas keep new rows in line.
--
-- If two rows differ only by case this ABORTS the migration, deliberately.
-- Silently folding them would either violate the unique index or, worse, merge
-- two people's financial records into one account. That needs a human, and the
-- message below tells them so rather than leaving them with a bare 23505.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(duplicated.address, ', ')
    INTO collisions
    FROM (
      SELECT lower("User_Email") AS address
        FROM public."User"
       GROUP BY lower("User_Email")
      HAVING count(*) > 1
    ) AS duplicated;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot normalise User_Email: these addresses exist in more than one case variant (%). Merge or rename them by hand before re-running this migration.',
      collisions;
  END IF;
END $$;

UPDATE public."User" SET "User_Email" = lower("User_Email") WHERE "User_Email" <> lower("User_Email");
