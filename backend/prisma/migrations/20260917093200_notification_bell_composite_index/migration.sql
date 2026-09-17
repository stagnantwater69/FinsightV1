-- One index for the bell's actual query instead of one per column.
--
-- listNotifications and markAllNotificationsRead both filter on User_ID AND
-- BusinessProfile_ID; the list then orders by Notification_DateCreated
-- descending and takes a fixed ceiling. With a single-column index on each,
-- Postgres could narrow on one column and then had to read and sort every
-- remaining row for that account, work that grows for the life of the account
-- to return one screenful. Ordering the third column descending matches the
-- ORDER BY, so the ceiling becomes a short prefix scan.
--
-- Notification_User_ID_idx goes: every lookup it served is a prefix of the new
-- index. The BusinessProfile_ID and ExpenseRecord_ID indexes stay, because
-- they back the cascades from those tables and the new index cannot.
CREATE INDEX "Notification_user_profile_created_idx"
  ON public."Notification" ("User_ID", "BusinessProfile_ID", "Notification_DateCreated" DESC);

DROP INDEX IF EXISTS public."Notification_User_ID_idx";
