import { pathToFileURL } from "node:url";

const cli = process.argv[2];
if (!cli) throw new Error("Playwright CLI path is required");
process.on("message", (message) => {
  if (message?.finsightFixtureShutdown === true) process.emit("SIGINT");
});
process.argv = [process.argv[0], cli, ...process.argv.slice(3)];
await import(pathToFileURL(cli).href);
