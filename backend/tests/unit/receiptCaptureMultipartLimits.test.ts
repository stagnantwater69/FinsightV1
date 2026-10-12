import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MulterError } from "multer";
import { uploadReceiptImage } from "../../src/middleware/upload.middleware";
import { errorHandler } from "../../src/middleware/error.middleware";

const accepted = vi.fn();
const app = express();
app.post("/capture", uploadReceiptImage.single("file"), (req, res) => {
  accepted(req.body);
  res.json({ fileBytes: req.file?.size, fields: Object.keys(req.body) });
});
app.get("/file-size-error", (_req, _res, next) => next(new MulterError("LIMIT_FILE_SIZE")));
app.get("/field-size-error", (_req, _res, next) => next(new MulterError("LIMIT_FIELD_VALUE")));
app.use(errorHandler);

beforeEach(() => accepted.mockClear());

describe("capture helper multipart boundaries", () => {
  it("accepts one file plus the bounded corners field", async () => {
    const result = await request(app).post("/capture").field("corners", "x".repeat(2000))
      .attach("file", Buffer.from("synthetic image bytes"), { filename: "receipt.jpg", contentType: "image/jpeg" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ fileBytes: 21, fields: ["corners"] });
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it.each(["x".repeat(2001), "é".repeat(1001)])("rejects fields above 2000 bytes before the controller", async (field) => {
    const result = await request(app).post("/capture").field("corners", field);
    expect(result.status).toBe(413);
    expect(result.body.code).toBe("UPLOAD_FIELD_TOO_LARGE");
    expect(accepted).not.toHaveBeenCalled();
  });

  it("rejects a second text field before the controller", async () => {
    const result = await request(app).post("/capture").field("corners", "{}").field("extra", "value");
    expect(result.status).toBe(400);
    expect(["UPLOAD_TOO_MANY_FIELDS", "UPLOAD_TOO_MANY_PARTS"]).toContain(result.body.code);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("rejects names above 100 bytes and additional file parts", async () => {
    const named = await request(app).post("/capture").field("x".repeat(101), "value");
    expect(named.status).toBe(400);
    expect(named.body.code).toBe("UPLOAD_FIELD_NAME_TOO_LONG");
    const files = await request(app).post("/capture")
      .attach("file", Buffer.from("first"), { filename: "one.jpg", contentType: "image/jpeg" })
      .attach("file", Buffer.from("second"), { filename: "two.jpg", contentType: "image/jpeg" });
    expect(files.status).toBe(400);
    expect(["UPLOAD_TOO_MANY_FILES", "UPLOAD_UNEXPECTED_FILE"]).toContain(files.body.code);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each([["/file-size-error", "UPLOAD_FILE_TOO_LARGE"], ["/field-size-error", "UPLOAD_FIELD_TOO_LARGE"]])(
    "returns a stable 413 contract for %s on receipt routes", async (path, code) => {
      const result = await request(app).get(path);
      expect(result.status).toBe(413);
      expect(result.body).toMatchObject({ code, error: expect.any(String) });
    },
  );
});
