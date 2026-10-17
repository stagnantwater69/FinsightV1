/** Private IPv4 ranges used by LAN, Docker, and Tailscale development hosts. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  return a === 100 && b! >= 64 && b! <= 127;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Local development keeps the API port/path and follows the bundle host.
 * The browser's origin avoids Metro addresses left over from a previous WiFi.
 *
 * EXPO_PUBLIC_API_BASE_URL is baked in at build time, so one address cannot
 * suit every phone and network; the host that served the bundle runs the
 * backend too, so it is the address known to be reachable. Only private
 * hosts are followed: a tunnel (`expo start --tunnel`) or `adb reverse`
 * loopback forwards the Metro port alone, so pointing the API there breaks
 * an address that was working. Release builds have no Metro host and keep
 * the configured URL.
 */
export function resolveApiBaseUrl(
  configured: string,
  hostUri: string | null | undefined,
  isDevelopment: boolean,
  browserOrigin?: string | null,
): string {
  if (!configured || !isDevelopment) return configured;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return configured;
  }
  if (url.protocol !== "http:" || (!isPrivateIpv4(url.hostname) && !isLoopback(url.hostname))) {
    return configured;
  }

  let host: string;
  if (browserOrigin !== undefined) {
    if (!browserOrigin) return configured;
    let browser: URL;
    try {
      browser = new URL(browserOrigin);
    } catch {
      return configured;
    }
    // HTTPS previews require an explicitly configured HTTPS API.
    if (browser.protocol !== "http:" || (!isPrivateIpv4(browser.hostname) && !isLoopback(browser.hostname))) {
      return configured;
    }
    host = browser.hostname;
  } else {
    if (!hostUri) return configured;
    try {
      host = new URL(hostUri.includes("://") ? hostUri : `http://${hostUri}`).hostname;
    } catch {
      return configured;
    }
    // Native loopback and public tunnels may forward only Metro, not the API.
    if (!isPrivateIpv4(host)) return configured;
  }

  if (host === url.hostname) return configured;
  url.hostname = host;
  return url.toString().replace(/\/$/, "");
}
