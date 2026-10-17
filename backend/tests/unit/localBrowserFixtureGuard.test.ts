import { describe, expect, it } from "vitest";
import { guardBrowserFixture } from "../browser-api/guard";

const good = { FINSIGHT_LOCAL_API_BROWSER: "1", NODE_ENV: "development",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:55434/finsight_test",
  DIRECT_URL: "postgresql://synthetic:synthetic@127.0.0.1:55434/finsight_test" };
describe("local browser fixture guard", () => {
  it("accepts only the explicit private loopback test setup", () => expect(() => guardBrowserFixture(good)).not.toThrow());
  it.each([
    { ...good, FINSIGHT_LOCAL_API_BROWSER: undefined },
    { ...good, NODE_ENV: "production" },
    { ...good, NODE_ENV: "test" },
    { ...good, DIRECT_URL: undefined },
    { ...good, DATABASE_URL: "postgresql://synthetic:synthetic@host.invalid:55434/finsight_test" },
    { ...good, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:55432/finsight_test" },
    { ...good, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:55434/finsight_test_backup" },
    { ...good, DIRECT_URL: "postgresql://synthetic:synthetic@127.0.0.1:55435/finsight_test" },
  ])("fails before any database or app initialization for unsafe setup %#", (env) => {
    expect(() => guardBrowserFixture(env)).toThrow(/fixture|Refusing/);
  });
});
