-- Server-side query limits for the role the API, worker and migrations share.
--
-- The client already abandons any statement after 30 seconds (Prisma's
-- socket_timeout, src/config/prisma.ts), but Postgres keeps running it,
-- holding a pooled connection and its locks for a caller that has gone. A
-- statement_timeout equal to that client limit changes no outcome the app can
-- see; it only stops the server doing work nobody will read.
--
-- idle_in_transaction_session_timeout ends a transaction that has sat open with
-- no statement running — a crashed request or a stuck tool session — before it
-- pins row locks and blocks vacuum indefinitely. Prisma's own interactive
-- transactions time out at seconds, so no healthy path comes near a minute.
--
-- Role defaults apply to sessions opened after this runs, including the
-- pooler's server connections. A later migration whose statements legitimately
-- run longer than 30 seconds (an index build on a large table) must begin with
-- `SET statement_timeout = 0;` — that applies to its own session only.
ALTER ROLE CURRENT_USER SET statement_timeout = '30s';
ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '60s';
