import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as auth from "../../src/controllers/auth.controller";
import * as businessProfile from "../../src/controllers/businessProfile.controller";
import * as csvImport from "../../src/controllers/csvImport.controller";
import * as expenseCategory from "../../src/controllers/expenseCategory.controller";
import * as expenseRecord from "../../src/controllers/expenseRecord.controller";
import * as salesRecord from "../../src/controllers/salesRecord.controller";

/**
 * Required free-text fields must hold something other than whitespace.
 *
 * `.min(1)` alone counts spaces, so `"   "` used to pass as a category name or
 * a record description and then render as a blank row nobody could identify.
 *
 * The create schemas need many unrelated fields to parse, so these cases look
 * only at issues on the field under test rather than building a full body.
 */
const CASES: Array<[label: string, schema: z.ZodTypeAny, field: string]> = [
  ["category create", expenseCategory.createSchema, "name"],
  ["category update", expenseCategory.updateSchema, "name"],
  ["business profile create name", businessProfile.createSchema, "name"],
  ["business profile create type", businessProfile.createSchema, "type"],
  ["business profile update name", businessProfile.updateSchema, "name"],
  ["expense create", expenseRecord.createSchema, "description"],
  ["expense update", expenseRecord.updateSchema, "description"],
  ["sale create", salesRecord.createSchema, "description"],
  ["sale update", salesRecord.updateSchema, "description"],
  ["register first name", auth.registerSchema, "firstName"],
  ["register last name", auth.registerSchema, "lastName"],
  ["profile update first name", auth.updateProfileSchema, "firstName"],
  ["profile update last name", auth.updateProfileSchema, "lastName"],
  ["CSV confirm title", csvImport.confirmSchema, "title"],
  ["staged CSV confirm title", csvImport.stagedConfirmSchema, "title"],
];

function fieldIssues(schema: z.ZodTypeAny, field: string, value: string) {
  const result = schema.safeParse({ [field]: value });
  return result.success ? [] : result.error.issues.filter((issue) => issue.path[0] === field);
}

describe("required text fields reject whitespace-only values", () => {
  it.each(CASES)("%s refuses blank %s", (_label, schema, field) => {
    for (const blank of ["   ", "\t", " \n "]) {
      expect(fieldIssues(schema, field, blank)).not.toHaveLength(0);
    }
  });

  it.each(CASES)("%s accepts padded text in %s", (_label, schema, field) => {
    expect(fieldIssues(schema, field, "  Rent  ")).toHaveLength(0);
  });
});

describe("required text fields are stored trimmed", () => {
  it.each([
    ["category update", expenseCategory.updateSchema, "name"],
    ["business profile update", businessProfile.updateSchema, "name"],
    ["expense update", expenseRecord.updateSchema, "description"],
    ["sale update", salesRecord.updateSchema, "description"],
    ["profile update", auth.updateProfileSchema, "firstName"],
  ] as const)("%s trims %s", (_label, schema, field) => {
    expect(schema.parse({ [field]: "  Rent  " })).toEqual({ [field]: "Rent" });
  });
});
