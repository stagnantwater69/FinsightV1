import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../../src/lib/zodErrors";
import { moneyAmountSchema } from "../../src/lib/money";

function fieldErrors(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a validation failure");
  return result.error.flatten().fieldErrors as Record<string, string[]>;
}

describe("zod error wording the clients show", () => {
  const schema = z.object({ name: z.string(), amount: moneyAmountSchema });

  it("says Required for a missing field", () => {
    expect(fieldErrors(schema, {})).toEqual({ name: ["Required"], amount: ["Required"] });
  });

  it("keeps a schema's own message for a wrong type", () => {
    expect(fieldErrors(schema, { name: "Rice", amount: "12" }).amount).toEqual(["Amount must be a number"]);
  });
});
