import { z } from "zod";

/**
 * Both clients show `details.fieldErrors` next to the field. zod 3 said
 * "Required" for a missing field; zod 4 says "Invalid input: expected string,
 * received undefined". Keep the short wording. Messages a schema sets itself
 * still win over this.
 */
z.config({
  customError: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined),
});
