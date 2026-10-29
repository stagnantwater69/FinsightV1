-- Both single-column indexes are a leading prefix of composite indexes that
-- already start with BusinessProfile_ID ((profile, date, id) and others), so
-- every lookup, profile-scoped scan and ON DELETE CASCADE check they served is
-- served as well by those. They only cost a write on every record insert,
-- including each row of a CSV import.

-- DropIndex
DROP INDEX "ExpenseRecord_BusinessProfile_ID_idx";

-- DropIndex
DROP INDEX "SalesReferenceRecord_BusinessProfile_ID_idx";
