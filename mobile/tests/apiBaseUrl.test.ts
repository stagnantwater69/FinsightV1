import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "../src/lib/apiBaseUrl";

const TAILSCALE = "http://100.72.84.96:4000/api/v1";

describe("development API host", () => {
  it("follows the host Metro served from, keeping the port and path", () => {
    // A teammate on the office WiFi, with the Tailscale address baked in.
    expect(resolveApiBaseUrl(TAILSCALE, "192.168.1.22:8081", true)).toBe("http://192.168.1.22:4000/api/v1");
    // The same build loaded over Tailscale keeps reaching it.
    expect(resolveApiBaseUrl("http://192.168.1.22:4000/api/v1", "100.72.84.96:8081", true)).toBe(TAILSCALE);
    expect(resolveApiBaseUrl(TAILSCALE, "exp://10.0.0.5:8081", true)).toBe("http://10.0.0.5:4000/api/v1");
  });

  it("leaves the configured URL alone wherever the swap would be a guess", () => {
    // A release APK: no Metro host, and not development.
    expect(resolveApiBaseUrl(TAILSCALE, null, false)).toBe(TAILSCALE);
    expect(resolveApiBaseUrl(TAILSCALE, "192.168.1.22:8081", false)).toBe(TAILSCALE);
    // A tunnel forwards the Metro port alone, so its hostname is not the API.
    expect(resolveApiBaseUrl(TAILSCALE, "abc-xyz.anonymous.exp.direct", true)).toBe(TAILSCALE);
    expect(resolveApiBaseUrl(TAILSCALE, "203.0.113.10:8081", true)).toBe(TAILSCALE);
    // adb reverse forwards the Metro port alone; 127.0.0.1:4000 is the phone itself.
    expect(resolveApiBaseUrl(TAILSCALE, "127.0.0.1:8081", true)).toBe(TAILSCALE);
    expect(resolveApiBaseUrl(TAILSCALE, "localhost:8081", true)).toBe(TAILSCALE);
    // A deployed backend is never stood in for by a Metro host.
    expect(resolveApiBaseUrl("https://api.finsight.app/api/v1", "192.168.1.22:8081", true))
      .toBe("https://api.finsight.app/api/v1");
    expect(resolveApiBaseUrl("not a url", "192.168.1.22:8081", true)).toBe("not a url");
    expect(resolveApiBaseUrl("", "192.168.1.22:8081", true)).toBe("");
    // Already right: returned unchanged rather than re-serialised.
    expect(resolveApiBaseUrl(TAILSCALE, "100.72.84.96:8081", true)).toBe(TAILSCALE);
  });
});
