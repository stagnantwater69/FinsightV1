import type { CorsOptions } from "cors";
import { networkInterfaces } from "node:os";

function isLocalExpoOrigin(origin: string, interfaces: ReturnType<typeof networkInterfaces>): boolean {
  if (["http://localhost:8081", "http://127.0.0.1:8081", "http://[::1]:8081"].includes(origin)) return true;
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [first, second] = entry.address.split(".").map(Number);
      const privateAddress = first === 10
        || (first === 172 && second !== undefined && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 100 && second !== undefined && second >= 64 && second <= 127);
      if (privateAddress && origin === `http://${entry.address}:8081`) return true;
    }
  }
  return false;
}

export function createCorsOptions(
  configuredOrigins: string,
  nodeEnv: string,
  getInterfaces: typeof networkInterfaces = networkInterfaces,
): CorsOptions {
  const allowedOrigins = new Set(configuredOrigins.split(",").map((origin) => origin.trim()).filter(Boolean));
  return {
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin)
        || (nodeEnv === "development" && isLocalExpoOrigin(origin, getInterfaces())));
    },
    credentials: true,
    exposedHeaders: ["Server-Timing", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "X-Next-Cursor"],
  };
}
