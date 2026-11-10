/**
 * Ask FinSight replies owners rated "not helpful", for turning into eval cases.
 *
 *   npm run report:ask-finsight-feedback [-- --days 30]
 *
 * Read-only. Prints each thumbs-down reply with the question that produced it,
 * the screen it was asked from, and whether the answer check had to revise or
 * trim it. No owner names, emails or business names are printed: the question
 * and answer are what a new tests/ai-eval case needs.
 *
 * Each entry ends with a Case line ready to paste into ask-finsight-eval.ts.
 * The eval runs against a fixed synthetic context, so check the question still
 * makes sense there and add any records it relies on to that fixture.
 */
import { prisma } from "../src/config/prisma";

function daysArgument(): number {
  const index = process.argv.indexOf("--days");
  const days = index >= 0 ? Number(process.argv[index + 1]) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be a whole number from 1 to 365");
  return days;
}

async function main() {
  const days = daysArgument();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rated = await prisma.chatMessage.findMany({
    where: { role: "assistant", feedback: "down", feedbackAt: { gte: since } },
    orderBy: [{ feedbackAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      conversationId: true,
      content: true,
      metadata: true,
      createdAt: true,
      conversation: { select: { originModule: true } },
    },
  });

  console.log(`${rated.length} reply(ies) rated not helpful in the last ${days} day(s).`);
  for (const reply of rated) {
    // The question is the newest owner message before this reply in the same conversation.
    const question = await prisma.chatMessage.findFirst({
      where: { conversationId: reply.conversationId, role: "user", createdAt: { lte: reply.createdAt }, id: { lt: reply.id } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { content: true },
    });
    const amountCheck = (reply.metadata as { amountCheck?: string } | null)?.amountCheck ?? "unknown";
    const asked = question?.content ?? "(question not found)";
    console.log(`\n--- message ${reply.id}, ${reply.conversation.originModule}, ${reply.createdAt.toISOString().slice(0, 10)}, amount check: ${amountCheck}`);
    console.log(`Q: ${asked}`);
    console.log(`A: ${reply.content.replace(/\n/g, "\n   ")}`);
    console.log(`Case: { name: ${JSON.stringify(`owner-rated: ${asked.slice(0, 50)}`)}, question: ${JSON.stringify(asked)} },`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
