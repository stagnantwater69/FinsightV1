import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory avatars bucket: enough Storage for the real upload path to run.
const store = vi.hoisted(() => new Map<string, { bytes: Buffer; type: string }>());

vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  const bucket = {
    upload: async (path: string, bytes: Buffer, options: { contentType: string }) => {
      store.set(path, { bytes, type: options.contentType });
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      const object = store.get(path);
      return object
        ? { data: new Blob([new Uint8Array(object.bytes)], { type: object.type }), error: null }
        : { data: null, error: { message: "not found" } };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/storage/v1/object/public/avatars/${path}` } }),
    list: async (folder: string, options: { offset: number }) => ({
      data: options.offset > 0 ? [] : [...store.keys()]
        .filter((key) => key.startsWith(`${folder}/`))
        .map((key) => ({ id: key, name: key.slice(folder.length + 1), created_at: "2020-01-01T00:00:00Z" })),
      error: null,
    }),
    remove: async (paths: string[]) => {
      for (const path of paths) store.delete(path);
      return { data: [], error: null };
    },
  };
  return { ...actual, supabaseAdmin: { ...actual.supabaseAdmin, storage: { from: () => bucket } } };
});

import { prisma } from "../../src/config/prisma";
import { rekeyGuessablePublicImages } from "../../src/services/publicImageRekey.service";
import { publicImagePathFromUrl } from "../../src/services/storage.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const URL_PREFIX = "https://storage.test/storage/v1/object/public/avatars/";
const RANDOM_KEY = /^(users|businesses)\/\d+\.[0-9a-f-]{36}$/;
let jpeg: Buffer;
let png: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).jpeg().toBuffer();
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
});
beforeEach(async () => {
  await resetDb();
  store.clear();
});
afterAll(disconnectDb);

describe("rekeyGuessablePublicImages", () => {
  it("counts without --apply, then moves legacy avatars and logos and deletes the old objects", async () => {
    const owner = await makeOwnerWithProfile({}, ["Inventory"]);
    const current = await makeOwnerWithProfile({ name: "Already random" }, ["Inventory"]);
    const randomPath = `users/${current.user.id}.0f8fad5b-d9cb-469f-a165-70867728950e`;
    store.set(`users/${owner.user.id}`, { bytes: jpeg, type: "image/jpeg" });
    store.set(`businesses/${owner.profile.id}.png`, { bytes: png, type: "image/png" });
    store.set(randomPath, { bytes: jpeg, type: "image/jpeg" });
    await prisma.user.update({ where: { id: owner.user.id }, data: { avatarUrl: `${URL_PREFIX}users/${owner.user.id}?v=1` } });
    await prisma.businessProfile.update({
      where: { id: owner.profile.id },
      data: { logoUrl: `${URL_PREFIX}businesses/${owner.profile.id}.png?v=1` },
    });
    await prisma.user.update({ where: { id: current.user.id }, data: { avatarUrl: `${URL_PREFIX}${randomPath}` } });

    expect(await rekeyGuessablePublicImages({ apply: false })).toEqual({ apply: false, guessable: 2, moved: 0, failed: 0 });
    expect(store.has(`users/${owner.user.id}`)).toBe(true);

    expect(await rekeyGuessablePublicImages({ apply: true })).toEqual({ apply: true, guessable: 2, moved: 2, failed: 0 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const profile = await prisma.businessProfile.findUniqueOrThrow({ where: { id: owner.profile.id } });
    const avatarPath = publicImagePathFromUrl(user.avatarUrl!)!;
    const logoPath = publicImagePathFromUrl(profile.logoUrl!)!;
    expect(avatarPath).toMatch(RANDOM_KEY);
    expect(logoPath).toMatch(RANDOM_KEY);
    expect(store.get(avatarPath)?.bytes.equals(jpeg)).toBe(true);
    expect(store.has(`users/${owner.user.id}`)).toBe(false);
    expect(store.has(`businesses/${owner.profile.id}.png`)).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: current.user.id } })).avatarUrl).toBe(`${URL_PREFIX}${randomPath}`);

    expect(await rekeyGuessablePublicImages({ apply: false })).toMatchObject({ guessable: 0 });
  });

  it("keeps going past an image it cannot read", async () => {
    const missing = await makeOwnerWithProfile({}, ["Inventory"]);
    const present = await makeOwnerWithProfile({ name: "Present" }, ["Inventory"]);
    store.set(`users/${present.user.id}`, { bytes: jpeg, type: "image/jpeg" });
    await prisma.user.update({ where: { id: missing.user.id }, data: { avatarUrl: `${URL_PREFIX}users/${missing.user.id}` } });
    await prisma.user.update({ where: { id: present.user.id }, data: { avatarUrl: `${URL_PREFIX}users/${present.user.id}` } });

    expect(await rekeyGuessablePublicImages({ apply: true })).toEqual({ apply: true, guessable: 2, moved: 1, failed: 1 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: missing.user.id } })).avatarUrl).toBe(`${URL_PREFIX}users/${missing.user.id}`);
  });
});
