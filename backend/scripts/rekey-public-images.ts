import { prisma } from "../src/config/prisma";
import { rekeyGuessablePublicImages } from "../src/services/publicImageRekey.service";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run ops:public-images:rekey [-- --apply]\n" +
      "Counts avatars and logos still at a guessable key (users/<id>, businesses/<id>.png).\n" +
      "--apply moves each to a random key through the normal upload path and deletes the old object.\n",
    );
    return;
  }
  const result = await rekeyGuessablePublicImages({ apply: process.argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Public image rekey failed"}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
