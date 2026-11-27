-- After restoring into a project with a different hostname (runbook §6.2).
-- Avatar and logo URLs are stored whole, on the old project's host; the
-- objects themselves were restored under the same keys. Moves the host part
-- only, then prints how many URLs still point elsewhere: it must be 0.
--
--   psql "$TARGET_URL" -v ON_ERROR_STOP=1 \
--     -v old_origin=https://<old-ref>.supabase.co -v new_origin=https://<new-ref>.supabase.co \
--     -f deploy/rewrite-public-image-urls.sql
--
-- Safe to run twice: a URL already on the new host does not match the old one.
-- Origins are scheme://host[:port]; a trailing "/" would leave "//" in every URL.
SET finsight.old_origin = :'old_origin';
SET finsight.new_origin = :'new_origin';
DO $$ BEGIN
  IF right(current_setting('finsight.old_origin'), 1) = '/' OR right(current_setting('finsight.new_origin'), 1) = '/' THEN
    RAISE EXCEPTION 'old_origin and new_origin must not end in /';
  END IF;
END $$;
BEGIN;
UPDATE "User"
   SET "User_AvatarURL" = :'new_origin' || substr("User_AvatarURL", length(:'old_origin') + 1)
 WHERE starts_with("User_AvatarURL", :'old_origin' || '/storage/v1/object/public/avatars/');
UPDATE "BusinessProfile"
   SET "BusinessProfile_LogoURL" = :'new_origin' || substr("BusinessProfile_LogoURL", length(:'old_origin') + 1)
 WHERE starts_with("BusinessProfile_LogoURL", :'old_origin' || '/storage/v1/object/public/avatars/');
SELECT 'image URLs not on the new host: ' || count(*) FROM (
  SELECT "User_AvatarURL" AS url FROM "User" WHERE "User_AvatarURL" IS NOT NULL
  UNION ALL SELECT "BusinessProfile_LogoURL" FROM "BusinessProfile" WHERE "BusinessProfile_LogoURL" IS NOT NULL
) u WHERE NOT starts_with(url, :'new_origin' || '/storage/v1/object/public/avatars/');
COMMIT;
