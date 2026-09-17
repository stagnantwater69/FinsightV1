/*
 * Where the app looks for the backend during development.
 *
 * `EXPO_PUBLIC_API_BASE_URL` is baked into the bundle at build time, so a
 * single address has to serve everyone: the phone on the office WiFi, the
 * same phone on Tailscale, and a teammate running Expo Go who has neither.
 * Whichever address is baked in, it is wrong for somebody, and the failure is
 * the one this is named after: the app loads and then cannot reach the API.
 *
 * Metro already knows the answer. The bundle reached the device from some
 * host, and the backend runs on the same machine, so that host is the one
 * address guaranteed to be reachable from wherever the app is running. In
 * development the host is taken from there and the port and path are kept
 * from the configured URL.
 *
 * Only for development, and only for a private address:
 *   - a release APK has no Metro host and uses the configured URL untouched;
 *   - a tunnelled session (`expo start --tunnel`) is served from a public
 *     hostname that forwards the Metro port ALONE, so pointing the API at it
 *     would just fail differently. A non-IP host is left alone;
 *   - loopback means `adb reverse`, which forwards the Metro port alone for
 *     the same reason. Rewriting the API to 127.0.0.1 would point the phone
 *     at itself, breaking a configured address that was working.
 */

/** Private and carrier-grade ranges the backend can be reached on: LAN, Docker, Tailscale. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  // 100.64.0.0/10 — carrier-grade NAT, which is where Tailscale addresses live.
  return a === 100 && b! >= 64 && b! <= 127;
}

/**
 * The API base URL to use, given the configured one and the host Metro served
 * from (`Constants.expoConfig.hostUri`, e.g. "192.168.1.22:8081").
 *
 * Returns the configured URL unchanged whenever the swap would be a guess.
 */
export function resolveApiBaseUrl(
  configured: string,
  hostUri: string | null | undefined,
  isDevelopment: boolean,
): string {
  if (!configured || !isDevelopment || !hostUri) return configured;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    // A malformed value is a typo in an env file; report it as configured
    // rather than silently substituting something that happens to parse.
    return configured;
  }
  // https means a deployed backend, which no Metro host can stand in for.
  if (url.protocol !== "http:") return configured;
  const metroHost = hostUri.replace(/^[a-z]+:\/\//i, "").split("/")[0]!.split(":")[0]!;
  if (!isPrivateIpv4(metroHost) || metroHost === url.hostname) return configured;
  url.hostname = metroHost;
  return url.toString().replace(/\/$/, "");
}
