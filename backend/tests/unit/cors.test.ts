import cors from "cors";
import express from "express";
import type { NetworkInterfaceInfo } from "node:os";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createCorsOptions } from "../../src/config/cors";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, internal, family: "IPv4", netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` };
}

function setup(nodeEnv = "development", configuredOrigins = "https://app.example.com") {
  const getInterfaces = vi.fn(() => ({
    wifi: [ipv4("10.163.68.74")],
    ethernet: [ipv4("192.168.56.1")],
    virtual: [ipv4("172.27.192.1")],
    tailscale: [ipv4("100.100.0.1")],
    public: [ipv4("203.0.113.2"), ipv4("100.63.0.1"), ipv4("100.128.0.1")],
    loopback: [ipv4("127.0.0.1", true)],
  }));
  const app = express();
  app.use(cors(createCorsOptions(configuredOrigins, nodeEnv, getInterfaces)));
  app.get("/probe", (_req, res) => res.sendStatus(204));
  return { app, getInterfaces };
}

describe("browser CORS origins", () => {
  it.each([
    "http://localhost:8081", "http://127.0.0.1:8081", "http://[::1]:8081", "http://10.163.68.74:8081",
    "http://192.168.56.1:8081", "http://172.27.192.1:8081",
    "http://100.100.0.1:8081",
  ])("permits the development Expo origin %s", async (origin) => {
    const { app } = setup();
    const response = await request(app).options("/probe")
      .set("Origin", origin).set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBe("content-type,authorization");
  });

  it.each([
    "http://10.163.68.75:8081", "http://10.32.98.74:8081", "http://192.168.1.2:8081",
    "http://172.16.1.2:8081", "http://203.0.113.2:8081", "http://10.163.68.74:8082",
    "http://100.100.0.2:8081", "http://100.63.0.1:8081", "http://100.128.0.1:8081",
    "https://10.163.68.74:8081", "http://localhost:8082", "http://127.0.0.2:8081",
    "http://localhost.attacker.example:8081", "http://10.163.68.74.attacker.example:8081",
    "null",
  ])("does not reflect the unapproved origin %s", async (origin) => {
    const { app } = setup();
    const response = await request(app).get("/probe").set("Origin", origin);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("uses current interfaces after Wi-Fi changes without recreating the middleware", async () => {
    const { app, getInterfaces } = setup();
    expect((await request(app).get("/probe").set("Origin", "http://10.163.68.74:8081"))
      .headers["access-control-allow-origin"]).toBe("http://10.163.68.74:8081");
    getInterfaces.mockReturnValue({
      wifi: [ipv4("10.32.98.74")], ethernet: [], virtual: [], tailscale: [], public: [], loopback: [],
    });
    expect((await request(app).get("/probe").set("Origin", "http://10.163.68.74:8081"))
      .headers["access-control-allow-origin"]).toBeUndefined();
    expect((await request(app).get("/probe").set("Origin", "http://10.32.98.74:8081"))
      .headers["access-control-allow-origin"]).toBe("http://10.32.98.74:8081");
  });

  it.each(["production", "test"])("keeps %s restricted to configured origins", async (nodeEnv) => {
    const { app, getInterfaces } = setup(nodeEnv, " https://app.example.com, http://localhost:8081 ");
    for (const origin of ["https://app.example.com", "http://localhost:8081"]) {
      expect((await request(app).get("/probe").set("Origin", origin))
        .headers["access-control-allow-origin"]).toBe(origin);
    }
    for (const origin of ["http://127.0.0.1:8081", "http://[::1]:8081", "http://10.163.68.74:8081", "http://100.100.0.1:8081"]) {
      expect((await request(app).get("/probe").set("Origin", origin))
        .headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(getInterfaces).not.toHaveBeenCalled();
  });

  it("keeps native requests without Origin usable without inspecting interfaces", async () => {
    const { app, getInterfaces } = setup();
    const response = await request(app).get("/probe");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(getInterfaces).not.toHaveBeenCalled();
  });
});
