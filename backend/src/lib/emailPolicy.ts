/**
 * Email normalisation and the throwaway-domain check.
 *
 * WHY NORMALISATION LIVES HERE rather than in each Zod schema inline. Supabase
 * Auth lowercases addresses; the Prisma `User_Email` column is a case-sensitive
 * unique index. When those two disagree, the profile row and the identity it
 * mirrors drift — and Prisma's uniqueness turns out to have been enforced only
 * by Supabase happening to reject the duplicate first, which is luck rather
 * than a constraint. One function, used by every schema that accepts an
 * address, is the only way that stays true.
 *
 * WHAT `isDisposableEmail` IS FOR, AND WHAT IT IS NOT. It reports; it does not
 * refuse. Registration once rejected on it and no longer does, because the
 * coverage maths fails in both directions at once: someone signing up in
 * earnest is not using a throwaway, and someone farming accounts uses one of
 * the thousands of services no hand-kept list contains. What is left is a
 * narrow middle that barely exists, set against a false positive that is silent
 * and expensive — an owner whose business email runs on a small provider is
 * turned away and tells nobody.
 *
 * Email confirmation is the control that carries this weight. This is a
 * tripwire beside it: `registerUser` logs a `register.disposable_domain` event,
 * which is uninteresting one at a time and tells you something real in bulk.
 * See docs/AUTH-HARDENING-PLAN.md for the same reasoning applied to CAPTCHA.
 */

/** Lowercased and trimmed — the one shape an address is stored and compared in. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Throwaway-inbox providers.
 *
 * Deliberately short and conservative. A long list scraped from the internet
 * ages badly and eventually blocks a real small provider that somebody's
 * business email actually runs on — which, for this product, means turning away
 * a paying owner to stop a signup that verification already made worthless.
 * These are the large, unambiguous, publicly-advertised disposable services.
 */
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "discard.email",
  "dispostable.com",
  "fakeinbox.com",
  "getairmail.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamailblock.com",
  "mailinator.com",
  "maildrop.cc",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "sharklasers.com",
  "spam4.me",
  "temp-mail.org",
  "tempmail.com",
  "tempmailo.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.net",
]);

/**
 * True when the address belongs to a known throwaway provider.
 *
 * Subdomains count: `foo.mailinator.com` is the same service, and wildcard
 * inboxes are the normal way these are used.
 */
export function isDisposableEmail(value: string): boolean {
  const domain = normalizeEmail(value).split("@")[1];
  if (!domain) return false;
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
