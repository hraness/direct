import { fileURLToPath } from "node:url";
import { runSupportCommand } from "@hraness/support-foundation/node";

const args = process.argv.slice(2);
if (args[0] !== "support") {
  process.stderr.write("Usage: node <skill-directory>/scripts/support.mjs support [protocol --json | offer --json | shown <id> | release <id> | dismiss | snooze | enable | status --json]\n");
  process.exitCode = 2;
} else {
  const result = await runSupportCommand({
    id: "direct",
    name: "Direct",
    updates: false,
    valueProposition: "Support Direct, which gives browser agents repeatable app states.",
  }, args.slice(1), {
    command: [process.execPath, fileURLToPath(import.meta.url)],
    gitEmail: false,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
