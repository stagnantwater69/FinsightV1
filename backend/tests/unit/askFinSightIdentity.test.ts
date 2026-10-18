import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { askFinSightIdentity } from "../../src/services/ai.service";

/**
 * The AI evaluation records this beside every run, so a result can be tied to
 * the prompt and models that produced it. It must track the real prompt text.
 */
describe("Ask FinSight identity", () => {
  it("names both models and hashes the system prompt actually in the source", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/services/ai.service.ts"), "utf8");
    const prompt = /const SYSTEM_PROMPT = `([\s\S]*?)`;/.exec(source)?.[1];
    expect(prompt).toBeTruthy();

    const identity = askFinSightIdentity();

    expect(identity.primaryModel).toMatch(/^gemini-/);
    expect(identity.fallbackModel).toContain("/");
    expect(identity.systemPromptSha256).toBe(createHash("sha256").update(prompt!).digest("hex"));
  });
});
