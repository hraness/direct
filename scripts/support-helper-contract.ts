import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Exercise a copied skill without a package install or access to user preferences. */
export async function verifySupportHelper(skillRoot: string): Promise<void> {
  const isolated = await mkdtemp(join(tmpdir(), "direct-skill-support-"));
  try {
    const copied = join(isolated, "copied skill");
    mkdirSync(join(copied, "scripts"), { recursive: true });
    copyFileSync(join(skillRoot, "scripts", "support.mjs"), join(copied, "scripts", "support.mjs"));
    const script = await realpath(join(copied, "scripts", "support.mjs"));
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: isolated,
      XDG_STATE_HOME: join(isolated, "state"),
      HRANESS_SUPPORT_AUDIENCE: "agent",
      HRANESS_SUPPORT_EMAIL: "off",
    };
    const invoke = (args: readonly string[], extra: Partial<NodeJS.ProcessEnv> = {}) => {
      const result = spawnSync("node", [script, ...args], {
        cwd: isolated, env: { ...env, ...extra }, encoding: "utf8",
        timeout: 5_000, maxBuffer: 64 * 1_024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const protocol = invoke(["support", "protocol", "--json"]);
    assert.equal(protocol.schemaVersion, "hraness-support-protocol-v1");
    const commands = protocol.commands as Record<string, string[]>;
    assert.deepEqual(commands.offer?.slice(1), [script, "support", "offer", "--json"]);
    assert.equal((await readdir(isolated)).join(","), "copied skill");
    const offer = protocol.offer as { product: { id: string }; actions: { kind: string; url: string }[] };
    assert.equal(offer.product.id, "direct");
    assert.deepEqual(offer.actions.map(action => action.kind), ["support"]);
    assert.equal(offer.actions[0]?.url, "https://account.hraness.com/support?product=direct&source=agent#support");
    const quiet = invoke(["support", "offer", "--json"], { HRANESS_SUPPORT: "off" });
    assert.equal(quiet.kind, "quiet");
    assert.equal((await readdir(isolated)).join(","), "copied skill");
    const offered = invoke(["support", "offer", "--json"]);
    assert.equal(offered.kind, "offer");
    const invitation = offered.invitation as { id: string };
    assert.equal(typeof invitation.id, "string");
    const result = spawnSync(commands.shown?.[0] ?? "", [script, "support", "shown", invitation.id], {
      cwd: isolated, env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const next = invoke(["support", "offer", "--json"]);
    assert.equal(next.kind, "quiet");
    assert.equal(next.reason, "cooldown");
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}
