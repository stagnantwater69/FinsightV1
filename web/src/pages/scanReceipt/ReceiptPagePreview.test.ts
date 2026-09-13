import { describe, expect, it } from "vitest";
import { receiptPageImageFromResponse } from "./receiptPageImage";

const source = {
  pageNumber: 2,
  variant: "source",
  label: "Source",
  width: 1200,
  height: 1800,
  url: "https://storage.example.test/receipt?token=short-lived",
  expiresInSeconds: 600,
};

describe("receiptPageImageFromResponse", () => {
  it("accepts a bounded signed URL for the requested evidence page", () => {
    expect(receiptPageImageFromResponse(source, { pageNumber: 2, variant: "source" }))
      .toEqual(source);
  });

  it.each([
    ["wrong page", { ...source, pageNumber: 1 }],
    ["wrong variant", { ...source, variant: "derived" }],
    ["non-http URL", { ...source, url: "file:///private/receipt.jpg" }],
    ["unsafe URL", { ...source, url: "https://storage.example.test/receipt\nnext" }],
    ["expired URL", { ...source, expiresInSeconds: 0 }],
  ])("rejects a %s response", (_label, response) => {
    expect(receiptPageImageFromResponse(response, { pageNumber: 2, variant: "source" })).toBeNull();
  });
});
