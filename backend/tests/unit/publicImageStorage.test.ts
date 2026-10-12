import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const upload = vi.fn();
const list = vi.fn();
const remove = vi.fn();
const getPublicUrl = vi.fn();
const from = vi.fn(() => ({ upload, list, remove, getPublicUrl }));

vi.mock("../../src/config/supabase", () => ({
  supabaseAdmin: { storage: { from } },
  SUPABASE_REQUEST_TIMEOUT_MS: 60_000,
}));
vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const {
  PUBLIC_IMAGE_UPLOAD_SETTLE_MS,
  PUBLIC_IMAGE_UPLOAD_TRANSACTION_TIMEOUT_MS,
  deleteSupersededPublicImages,
  listPublicImagePaths,
  publicImagePathFromUrl,
  uploadBusinessLogo,
  uploadUserAvatar,
} = await import("../../src/services/storage.service");

let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;
let animatedWebp: Buffer;
let oversizedPng: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).jpeg().toBuffer();
  png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).webp().toBuffer();
  const frames = Buffer.alloc(10 * 20 * 3, 255);
  frames.fill(0, 10 * 10 * 3);
  animatedWebp = await sharp(frames, { raw: { width: 10, height: 20, pageHeight: 10, channels: 3 } })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  oversizedPng = await sharp({
    create: { width: 5001, height: 5000, channels: 3, background: "white" },
  }).png().toBuffer();
});

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockResolvedValue({ data: { path: "ok" }, error: null });
  remove.mockResolvedValue({ data: {}, error: null });
  getPublicUrl.mockImplementation((path: string) => ({
    data: { publicUrl: `https://storage.test/storage/v1/object/public/avatars/${path}` },
  }));
});

describe("public profile-image uploads", () => {
  it("keeps the deletion settle window longer than both Storage attempts and the upload transaction", () => {
    expect(PUBLIC_IMAGE_UPLOAD_TRANSACTION_TIMEOUT_MS).toBe(15_000);
    expect(PUBLIC_IMAGE_UPLOAD_SETTLE_MS).toBe(135_250);
  });

  it.each([
    ["image/jpeg", "avatar.client.png", () => jpeg],
    ["image/png", "avatar.client.webp", () => png],
    ["image/webp", "avatar.client.jpg", () => webp],
  ])("uses one canonical user key for valid %s bytes", async (mimetype, originalname, bytes) => {
    const url = await uploadUserAvatar(7, bytes(), mimetype, originalname);

    expect(upload).toHaveBeenCalledWith(
      "users/7",
      bytes(),
      { contentType: mimetype, upsert: true },
    );
    expect(url).toMatch(/^https:\/\/storage\.test\/storage\/v1\/object\/public\/avatars\/users\/7\?v=\d+$/);
  });

  it("uses one canonical business key across filename extensions", async () => {
    await uploadBusinessLogo(19, png, "image/png", "logo.any-extension");
    expect(upload).toHaveBeenCalledWith(
      "businesses/19",
      png,
      { contentType: "image/png", upsert: true },
    );
  });

  it.each([
    ["forged MIME", () => png, "image/jpeg"],
    ["truncated image", () => png.subarray(0, 40), "image/png"],
    ["arbitrary bytes", () => Buffer.from("not an image"), "image/png"],
    ["multiple frames", () => animatedWebp, "image/webp"],
    ["more than 25 megapixels", () => oversizedPng, "image/png"],
  ])("rejects %s before Storage is called", async (_label, bytes, mimetype) => {
    await expect(uploadUserAvatar(7, bytes(), mimetype, "avatar.bin")).rejects.toMatchObject({ status: 400 });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("public image inventory", () => {
  it("lists every owned canonical or legacy key across more than ten pages", async () => {
    const objects = Array.from({ length: 1_103 }, (_, index) => ({
      id: `object-${index}`,
      name: `7.${String(index).padStart(4, "0")}`,
    }));
    list.mockImplementation(async (_folder: string, options: { offset: number; limit: number }) => ({
      data: objects.slice(options.offset, options.offset + options.limit),
      error: null,
    }));

    const paths = await listPublicImagePaths("users/7");

    expect(paths).toHaveLength(1_103);
    expect(paths[0]).toBe("users/7.0000");
    expect(paths.at(-1)).toBe("users/7.1102");
    expect(list).toHaveBeenCalledTimes(12);
  });

  it("deletes all legacy keys while preserving the canonical object", async () => {
    list.mockResolvedValue({
      data: [
        { id: "canonical", name: "7" },
        { id: "legacy-png", name: "7.png" },
        { id: "legacy-jpeg", name: "7.jpeg" },
        { id: "other-user", name: "70.png" },
      ],
      error: null,
    });

    await expect(deleteSupersededPublicImages("users/7")).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(["users/7.png"]);
    expect(remove).toHaveBeenCalledWith(["users/7.jpeg"]);
  });

  it("parses only owned avatar and logo URLs and ignores cache-bust parameters", () => {
    expect(publicImagePathFromUrl(
      "https://storage.test/storage/v1/object/public/avatars/users/7?v=123",
    )).toBe("users/7");
    expect(publicImagePathFromUrl(
      "https://storage.test/storage/v1/object/public/avatars/businesses/19.png?v=123",
    )).toBe("businesses/19.png");
    expect(publicImagePathFromUrl("https://example.test/not-storage/users/7")).toBeNull();
  });
});
