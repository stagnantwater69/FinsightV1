import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "../src/lib/apiBaseUrl";

const TAILSCALE = "http://100.72.84.96:4000/api/v1";
const STALE_LAN = "http://10.32.98.74:4000/api/v1";

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

describe("development browser API host", () => {
  it.each([
    ["http://localhost:8081", "http://localhost:4000/api/v1"],
    ["http://127.0.0.1:8081", "http://127.0.0.1:4000/api/v1"],
    ["http://[::1]:8081", "http://[::1]:4000/api/v1"],
    ["http://10.163.68.74:8081", "http://10.163.68.74:4000/api/v1"],
    ["http://100.72.84.96:8081", TAILSCALE],
  ])("uses the current browser origin %s despite a stale Metro host", (origin, expected) => {
    expect(resolveApiBaseUrl(STALE_LAN, "10.32.98.74:8081", true, origin)).toBe(expected);
  });

  it("still finds the API when Expo web does not expose a Metro host", () => {
    expect(resolveApiBaseUrl(STALE_LAN, null, true, "http://localhost:8081"))
      .toBe("http://localhost:4000/api/v1");
  });

  it("preserves the configured API port, path and query", () => {
    expect(resolveApiBaseUrl("http://10.32.98.74:4200/custom/api?version=1", null, true, "http://localhost:8081"))
      .toBe("http://localhost:4200/custom/api?version=1");
  });

  it.each([
    "https://localhost:8081",
    "https://10.163.68.74:8081",
    "http://abc-xyz.anonymous.exp.direct:8081",
    "http://203.0.113.10:8081",
    "http://127.attacker.example:8081",
    "file:///preview.html",
    "not an origin",
    "",
    null,
  ])("does not infer an API from browser origin %s or fall back to a LAN Metro host", (origin) => {
    expect(resolveApiBaseUrl(STALE_LAN, "10.163.68.74:8081", true, origin)).toBe(STALE_LAN);
  });

  it.each([
    "https://api.finsight.app/api/v1",
    "https://10.32.98.74:4000/api/v1",
    "http://api.finsight.app/api/v1",
    "http://203.0.113.10:4000/api/v1",
    "http://127.attacker.example:4000/api/v1",
  ])("preserves the explicit remote or secure backend %s", (configured) => {
    expect(resolveApiBaseUrl(configured, "10.163.68.74:8081", true, "http://localhost:8081"))
      .toBe(configured);
    expect(resolveApiBaseUrl(configured, "10.163.68.74:8081", true)).toBe(configured);
  });

  it("leaves release configuration unchanged even in a local browser", () => {
    expect(resolveApiBaseUrl(STALE_LAN, "10.163.68.74:8081", false, "http://localhost:8081"))
      .toBe(STALE_LAN);
  });

  it("keeps native emulator and adb reverse semantics separate from browser loopback", () => {
    const emulator = "http://10.0.2.2:4000/api/v1";
    expect(resolveApiBaseUrl(emulator, "localhost:8081", true)).toBe(emulator);
    expect(resolveApiBaseUrl(emulator, "127.0.0.1:8081", true)).toBe(emulator);
    expect(resolveApiBaseUrl(emulator, "10.0.2.2:8081", true)).toBe(emulator);
    expect(resolveApiBaseUrl(emulator, "192.168.1.22:8081", true)).toBe("http://192.168.1.22:4000/api/v1");
    expect(resolveApiBaseUrl(emulator, "localhost:8081", true, "http://localhost:8081"))
      .toBe("http://localhost:4000/api/v1");
  });
});
