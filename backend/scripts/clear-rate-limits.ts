/**
 * Empties the rate-limit buckets, for development.
 *
 * WHY THIS SCRIPT EXISTS. The limiter is DB-backed on purpose — that is what
 * makes it survive a restart and hold across more than one backend process,
 * and it is one of this project's hard rules. The cost is that a developer
 * testing password recovery twenty times in an afternoon cannot get their
 * budget back by restarting anything; the buckets outlive the process, which is
 * exactly the property production needs and exactly the one that makes local
 * testing miserable.
 *
 * The alternative people reach for is an environment flag that switches the
 * limiter off, and that is the thing worth avoiding: a config value that
 * disables a security control is one bad deployment away from being set in
 * production, silently, with nothing on screen to say so. A script someone has
 * to run by hand cannot ship by accident.
 *
 * REFUSES TO RUN IN PRODUCTION, because clearing these live would hand every
 * bucket back to whoever is currently being throttled — which, if anyone is,
 * is precisely the moment not to.
 *
 *   npm run ratelimit:clear            # every bucket
 *   npm run ratelimit:clear -- auth    # only buckets whose key contains "auth"
 */
import { prisma } from "../src/config/prisma";
import { env } from "../src/config/env";

async function main() {
  if (env.NODE_ENV === "production") {
    console.error("Refusing to clear rate limits in production.");
    process.exitCode = 1;
    return;
  }

  const filter = process.argv[2];
  const { count } = await prisma.apiRateLimit.deleteMany(
    filter ? { where: { key: { contains: filter } } } : {},
  );

  console.log(
    filter
      ? `Cleared ${count} rate-limit bucket(s) matching "${filter}".`
      : `Cleared ${count} rate-limit bucket(s).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
