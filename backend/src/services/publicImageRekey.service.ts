import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { updateAvatar } from "./auth.service";
import { updateBusinessLogo } from "./businessProfile.service";
import { downloadPublicImage, isGuessablePublicImagePath, publicImagePathFromUrl } from "./storage.service";

export interface PublicImageRekeyResult {
  apply: boolean;
  guessable: number;
  moved: number;
  failed: number;
}

/**
 * Moves avatars and logos saved before uploads got a random key (users/7,
 * businesses/19.png) to one. Each image goes through the owner's own upload
 * path, so it is validated again, written under the row lock, and the old
 * object is deleted once the new URL is saved. Without `apply` it only counts.
 */
export async function rekeyGuessablePublicImages({ apply }: { apply: boolean }): Promise<PublicImageRekeyResult> {
  const users = await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { id: true, avatarUrl: true },
    orderBy: { id: "asc" },
  });
  const profiles = await prisma.businessProfile.findMany({
    where: { logoUrl: { not: null } },
    select: { id: true, userId: true, logoUrl: true },
    orderBy: { id: "asc" },
  });
  const targets = [
    ...users.map((user) => ({ url: user.avatarUrl!, move: (buffer: Buffer, mimetype: string, name: string) =>
      updateAvatar(user.id, buffer, mimetype, name) })),
    ...profiles.map((profile) => ({ url: profile.logoUrl!, move: (buffer: Buffer, mimetype: string, name: string) =>
      updateBusinessLogo(profile.userId, profile.id, buffer, mimetype, name) })),
  ].flatMap((target) => {
    const path = publicImagePathFromUrl(target.url);
    return path && isGuessablePublicImagePath(path) ? [{ ...target, path }] : [];
  });

  const result: PublicImageRekeyResult = { apply, guessable: targets.length, moved: 0, failed: 0 };
  if (!apply) return result;
  for (const target of targets) {
    try {
      const image = await downloadPublicImage(target.path);
      if (!image) throw new Error("could not download the stored image");
      await target.move(image.buffer, image.mimetype, target.path);
      result.moved += 1;
    } catch (error) {
      // One unreadable or refused image (an inactive account, say) must not stop the rest.
      result.failed += 1;
      logger.warn({ err: error, path: target.path }, "could not move a public image to a random key");
    }
  }
  return result;
}
