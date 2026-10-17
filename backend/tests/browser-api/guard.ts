import { assertLocalTestDatabase, databaseIdentity } from "../setup/globalSetup";

export function guardBrowserFixture(env: Record<string, string | undefined>) {
  if (env.FINSIGHT_LOCAL_API_BROWSER !== "1" || env.NODE_ENV !== "development") {
    throw new Error("Local browser fixture requires explicit opt-in and the development runtime");
  }
  const url = env.DATABASE_URL;
  const direct = env.DIRECT_URL;
  if (!url || !direct) throw new Error("Local browser fixture requires both explicit database URLs");
  assertLocalTestDatabase("DATABASE_URL", url);
  assertLocalTestDatabase("DIRECT_URL", direct);
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || Number(parsed.port) < 55434
    || databaseIdentity(url) !== databaseIdentity(direct)) {
    throw new Error("Local browser fixture requires matching loopback finsight_test URLs on a private port >=55434");
  }
}
