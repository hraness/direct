import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  acquireVerificationServer, agentBrowserProcessTimeoutMs, bindDirectBrowserContractEvidence,
  boundedAgentBrowserSessionName, isolatedAgentBrowserEnvironment, parseAgentBrowserEnvelope,
  readDirectBrowserContract, runVerificationCommand, spawnVerificationServer, stopVerificationServer,
  type AgentBrowser, type DirectSessionBrowserContract,
} from "@hraness/direct/tooling/browser-verification";
import { parseDefinitionCoverageSnapshot } from "@hraness/direct/testing";
import { todoDirectDefinition } from "./direct/definition.js";
import { POPULATED_TODOS } from "./direct/world.js";
import { TODO_STORAGE_KEY } from "./src/local-storage-todo-port.js";
import {
  TODO_APPEARANCE_CASES, TODO_APPEARANCE_WIDTHS, TODO_BREAKPOINT_WIDTHS, TODO_STYLE_KEYS,
  admitTodoContext, assertTodoStable, assertTodoStaticCss, assertTodoParkedTabs, assertTodoConsole, boundedTodoBatches, compareTodoAppearance, exactRecord,
  parseTodoAppearanceInput, parseTodoAppearanceSample, parseTodoDriverResult, parseTodoEvaluation, parseTodoNativeTabs as parseTabs, parseTodoOwnedClose, todoCasePath, todoFailureText as errorText, withTodoCleanup as withCleanup,
  type TodoAppearanceCase, type TodoAppearanceDifference, type TodoAppearanceInput,
  type TodoAppearanceSample, type TodoSourceIdentity,
} from "./native-appearance-contract.js";

const ownFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(ownFile), "../..");
const maxFileBytes = 32 * 1024 * 1024;
const maxArtifactBytes = 128 * 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Read ordinary files without opening a FIFO or following a replaced final link. */
async function ordinaryFile(path: string, maximum = maxFileBytes): Promise<Buffer> {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, "bounded ordinary file required");
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await descriptor.stat();
    assert.ok(first.isFile() && first.dev === before.dev && first.ino === before.ino && first.size === before.size, "file changed before open");
    const bytes = await descriptor.readFile();
    const last = await descriptor.stat();
    const named = await lstat(path);
    assert.ok(bytes.length <= maximum && last.size === bytes.length && first.size === last.size && first.mtimeMs === last.mtimeMs && first.ctimeMs === last.ctimeMs && named.dev === last.dev && named.ino === last.ino && !named.isSymbolicLink(), "file changed during read");
    return bytes;
  } finally { await descriptor.close(); }
}

/** Receipt format is public; absolute paths remain only in the private input. */
export async function todoBuildInventory(directory: string): Promise<{ readonly sha256: string; readonly files: readonly (readonly [string, number, number, string])[] }> {
  assert.equal(await realpath(directory), directory, "build directory must be canonical");
  const files: [string, number, number, string][] = [];
  let total = 0, directories = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "build inventory cannot contain links");
    if (info.isDirectory()) {
      assert.ok(++directories <= 32, "build directory census exceeded");
      assert.equal(await realpath(path), path, "build directory changed or traverses a link");
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      const after = await lstat(path);
      assert.ok(after.isDirectory() && info.dev === after.dev && info.ino === after.ino && info.mtimeMs === after.mtimeMs, "build directory changed during inventory");
      return;
    }
    const name = relative(directory, path);
    assert.match(name, /^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/u, "unsafe build path");
    const bytes = await ordinaryFile(path);
    total += bytes.length;
    assert.ok(files.length < 256 && total <= maxArtifactBytes, "build inventory exceeds bound");
    files.push([name, info.mode & 0o777, bytes.length, sha256(bytes)]);
  }
  await visit(directory);
  assert.ok(files.some(([name]) => name.endsWith(".html")) && files.some(([name]) => name.endsWith(".js")), "empty or unrelated build");
  return { sha256: sha256(JSON.stringify(files)), files };
}
async function verifySource(source: TodoSourceIdentity): Promise<void> {
  assert.equal(await realpath(source.repository), source.repository);
  const git = async (...args: string[]) => {
    const command = spawnVerificationServer({ command: ["/usr/bin/git", "--no-optional-locks", "-C", source.repository, ...args], cwd: repositoryRoot, logLimit: 1024 * 1024 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await withCleanup(async () => Promise.race([command.exited.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), 10_000); })]), async () => {
      if (timer !== undefined) clearTimeout(timer);
      await stopVerificationServer(command, 1000);
    });
    const snapshot = command.outputSnapshot?.();
    assert.ok(completed && command.exitCode() === 0 && snapshot && snapshot.stdout.state === "eof" && snapshot.stderr.state === "eof" && snapshot.stdout.bytesRead < 1024 * 1024 && snapshot.stderr.bytesRead === 0, "Git identity inventory must be complete, bounded and successful");
    return (await command.output).trim();
  };
  assert.equal(await git("rev-parse", "HEAD"), source.commit);
  assert.equal(await git("rev-parse", "HEAD^{tree}"), source.tree);
  assert.equal(await git("status", "--porcelain=v1", "--untracked-files=no"), "", "native tracked source must be sealed and clean");
  const allowedOutputs = [source.production, source.direct].map((build) => relative(source.repository, build.directory));
  assert.ok(allowedOutputs.every((path) => path !== "" && !path.startsWith("..")), "builds must remain inside their exact source checkout");
  const untracked = (await git("ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
  assert.ok(untracked.every((path) => allowedOutputs.some((root) => path.startsWith(`${root}/`))), "untracked non-build work in native source");
  assert.equal(sha256(await ordinaryFile(join(source.repository, "bun.lock"))), source.lockSha256);
  for (const build of [source.production, source.direct]) assert.equal((await todoBuildInventory(build.directory)).sha256, build.inventorySha256);
}

async function serveBuild(directory: string, port: number, expected: string): Promise<void> {
  const inventory = await todoBuildInventory(directory);
  assert.equal(inventory.sha256, expected);
  const files = new Map(inventory.files.map(([name, , , hash]) => [`/${name}`, hash]));
  const requests: { path: string; status: number }[] = [];
  const denied: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__todo_native_receipt" && request.method === "GET") return Response.json({ inventorySha256: inventory.sha256, requests, denied });
    const path = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    if (request.method !== "GET" || requests.length >= 1024 || url.origin !== `http://127.0.0.1:${port}` || /%|\\|\/\.{1,2}(?:\/|$)/u.test(path)) {
      if (denied.length < 32) denied.push("unadmitted request");
      return new Response("Rejected", { status: 403 });
    }
    if (path === "/favicon.ico" && !files.has(path)) return new Response(null, { status: 204 });
    const hash = files.get(path);
    if (hash === undefined) {
      if (denied.length < 32) denied.push(path.slice(0, 256));
      return new Response("Not found", { status: 404 });
    }
    const bytes = await ordinaryFile(join(directory, path.slice(1)));
    assert.equal(sha256(bytes), hash, "served build changed");
    requests.push({ path, status: 200 });
    const type = path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") || path.endsWith(".map") ? "application/json" : path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    return new Response(new Uint8Array(bytes), { headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } });
  let closing = false;
  const close = () => { if (!closing) { closing = true; void server.stop(true); } };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

type ProcessIdentity = { readonly pid: number; readonly parent: number; readonly started: string; readonly command: string };
async function processInventory(pids?: readonly number[]): Promise<ProcessIdentity[]> {
  const command = spawnVerificationServer({ command: ["/bin/ps", "-ww", ...(pids === undefined ? ["-ax"] : ["-p", pids.join(",")]), "-o", "pid=,ppid=,lstart=,command="], cwd: repositoryRoot, logLimit: 4 * 1024 * 1024 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await withCleanup(async () => Promise.race([command.exited.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), 3000); })]), async () => {
    if (timer !== undefined) clearTimeout(timer);
    await stopVerificationServer(command, 1000);
  });
  const snapshot = command.outputSnapshot?.();
  assert.ok(completed && snapshot && snapshot.stdout.state === "eof" && snapshot.stderr.state === "eof" && snapshot.stdout.bytesRead < 4 * 1024 * 1024 && snapshot.stderr.bytesRead === 0, "process census must be complete and bounded");
  const out = await command.output;
  assert.ok(command.exitCode() === 0 || (pids !== undefined && command.exitCode() === 1 && out.trim() === ""), "process census failed");
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/u.exec(line);
    assert.ok(match, "unexpected process census grammar");
    const [, pid, parent, started, argv] = match;
    assert.ok(pid && parent && started && argv, "incomplete process census row");
    return { pid: Number(pid), parent: Number(parent), started, command: argv };
  });
}
function ownProcessClosure(all: readonly ProcessIdentity[], roots: readonly ProcessIdentity[]): ProcessIdentity[] {
  const result = new Map(roots.map((row) => [row.pid, row]));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of all) if (!result.has(row.pid) && result.has(row.parent)) { result.set(row.pid, row); changed = true; }
  }
  return [...result.values()];
}

interface NativeBatch {
  readonly browser: Pick<AgentBrowser, "run" | "evaluate">;
  readonly newContext: (label: string) => Promise<void>;
  readonly parkContext: () => Promise<void>;
  readonly close: () => Promise<void>;
}
async function createNativeBatch(input: TodoAppearanceInput, directory: string, record: (label: string, value: unknown) => Promise<void>): Promise<NativeBatch> {
  const session = boundedAgentBrowserSessionName("todo", process.pid, randomUUID());
  // Short socket root is an exact new private leaf; no ambient cache/session is adopted.
  const sockets = await mkdtemp("/private/tmp/tn-");
  await chmod(sockets, 0o700);
  const home = join(directory, "home"), temporary = join(directory, "tmp"), config = join(directory, "agent-browser.json");
  await mkdir(home, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600, flag: "wx" });
  const env = isolatedAgentBrowserEnvironment({ configPath: config, defaultTimeoutMs: 15_000, idleTimeoutMs: 60_000, session,
    inheritedEnvironment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: temporary, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: temporary, LANG: "en_US.UTF-8" } });
  env.AGENT_BROWSER_SOCKET_DIR = sockets;
  const prefix = [input.browser.driver, "--config", config, "--session", session, "--engine", "chrome", "--executable-path", input.browser.executable, "--allowed-domains", "127.0.0.1", "--json"];
  let used = false, contexts = 0, operations = 0, bootstrap: string | undefined, scenarioTabs = new Set<string>();
  const observed = new Map<number, ProcessIdentity>();
  let daemon: ProcessIdentity | undefined, browserRoot: ProcessIdentity | undefined;
  const runDirectory = join(sockets, "namespaces", session, "run");
  const bindDaemon = async (all: readonly ProcessIdentity[]) => {
    const pid = Number((await ordinaryFile(join(runDirectory, `${session}.pid`), 64)).toString().trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const named = all.find((row) => row.pid === pid);
    // v0.32.3 launches its native daemon with no argv; session is carried in
    // the child-only environment and this exact private namespaced pid file.
    assert.ok(named && named.command === input.browser.driver, "daemon identity not bound to exact native driver");
    if (daemon === undefined) daemon = named;
    else assert.deepEqual(named, daemon, "original daemon changed");
    observed.set(named.pid, named);
    return named;
  };
  const census = async () => {
    const all = await processInventory();
    const admittedDaemon = await bindDaemon(all);
    const chromeRoots = all.filter((row) => row.command.startsWith(`${input.browser.executable} `) && row.command.includes(`--user-data-dir=${temporary}/`));
    assert.equal(chromeRoots.length, 1, "one exact private Chromium root required");
    if (browserRoot === undefined) browserRoot = chromeRoots[0];
    else assert.deepEqual(chromeRoots[0], browserRoot, "browser root changed during batch");
    const roots = [admittedDaemon, ...chromeRoots];
    const closure = ownProcessClosure(all, roots);
    for (const row of closure) observed.set(row.pid, row);
    assert.ok(closure.some((row) => row.command.includes(input.browser.executable)), "owned Chromium root not observed");
    await record(`census-${operations}`, closure.map(({ pid, parent, started }) => ({ pid, parent, started })));
  };
  const run = async (args: readonly string[]): Promise<unknown> => {
    operations += 1;
    assert.ok(operations <= 1500, "native batch command count exceeded");
    if (daemon !== undefined && browserRoot !== undefined) {
      const current = await processInventory([daemon.pid, browserRoot.pid]);
      for (const owner of [daemon, browserRoot]) assert.ok(current.some((row) => row.pid === owner.pid && row.started === owner.started && row.command === owner.command), "original browser/daemon owner lost; implicit relaunch forbidden");
    }
    const command = spawnVerificationServer({ command: [...prefix, ...args], cwd: repositoryRoot, env, logLimit: 1024 * 1024 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    try {
      completed = await Promise.race([command.exited.then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), agentBrowserProcessTimeoutMs(args, 15_000)); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await stopVerificationServer(command, 3000);
    }
    const snapshot = command.outputSnapshot?.();
    await record(`command-${operations}-terminal`, { command: args[0], completed, exitCode: command.exitCode(), snapshot });
    assert.ok(snapshot && snapshot.stdout.state === "eof" && snapshot.stderr.state === "eof" && snapshot.stdout.bytesRead < 1024 * 1024 && snapshot.stderr.bytesRead === 0, "driver output must be complete, bounded JSON without stderr");
    assert.ok(completed && command.exitCode() === 0, `Todo native ${args[0]} did not complete successfully`);
    const raw = await command.output;
    const value = parseAgentBrowserEnvelope(raw);
    // Command labels never include script bodies or page contents.
    await record(`command-${operations}`, { command: args[0], result: value });
    return parseTodoDriverResult(value, operations === 1);
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    return parseTodoEvaluation(await run(["eval", expression]), input.port);
  };
  async function close(): Promise<void> {
    if (!used) return;
    const failures: unknown[] = [];
    try { await census(); } catch (error) { failures.push(error); }
    let closed = false;
    try {
      const all = await processInventory();
      // Even when initial launch failed, only the exact private pid/socket can
      // admit this cleanup. Missing custody never starts a replacement daemon.
      const admittedDaemon = await bindDaemon(all);
      const socketPath = join(runDirectory, `${session}.sock`);
      const socketIdentity = await lstat(socketPath);
      assert.ok(socketIdentity.isSocket() && !socketIdentity.isSymbolicLink() && socketIdentity.uid === process.getuid?.(), "private owned daemon socket required");
      assert.equal(await realpath(runDirectory), runDirectory);
      const current = await processInventory([admittedDaemon.pid]);
      assert.deepEqual(current, [admittedDaemon], "original daemon lost before close");
      const named = await lstat(socketPath);
      assert.ok(named.isSocket() && named.dev === socketIdentity.dev && named.ino === socketIdentity.ino && named.uid === socketIdentity.uid, "daemon socket replaced");
      // agent-browser v0.32.3 connection.rs:1094 uses one newline JSON request.
      // Unlike its CLI close, this cannot call ensure_daemon/respawn on failure.
      const id = randomUUID();
      const raw = await new Promise<string>((resolveResult, reject) => {
        const connection = createConnection(socketPath);
        let response = "", terminal = false;
        const finish = (error?: Error) => {
          if (terminal) return;
          terminal = true; clearTimeout(timer); connection.destroy();
          if (error) reject(error); else resolveResult(response);
        };
        const timer = setTimeout(() => finish(new Error("Owned daemon close timed out")), 10_000);
        connection.setEncoding("utf8");
        connection.once("connect", () => connection.write(`${JSON.stringify({ id, action: "close" })}\n`));
        connection.on("data", (chunk: string) => {
          response += chunk;
          if (Buffer.byteLength(response) > 16_384) finish(new Error("Owned close response exceeded bound"));
          else if (response.includes("\n")) finish();
        });
        connection.once("error", (error) => finish(error));
        connection.once("end", () => finish(new Error("Owned close ended without a complete response")));
      });
      const envelope: unknown = JSON.parse(raw);
      const result = parseTodoOwnedClose(envelope, id);
      await record("whole-browser-close-response", result);
      closed = true;
    } catch (error) { failures.push(error); }
    const deadline = Date.now() + 10_000;
    let survivors: ProcessIdentity[] = [];
    let censusComplete = false;
    try {
      do {
        const all = await processInventory();
        survivors = all.filter((row) => observed.get(row.pid)?.started === row.started || row.command.includes(temporary) || row.command.includes(sockets));
        if (survivors.length === 0) break;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      censusComplete = true;
      assert.deepEqual(survivors, [], "owned browser/daemon descendants survived whole-browser close");
    } catch (error) { failures.push(error); }
    await record("final-close", { commandSucceeded: closed, censusComplete, survivors: survivors.map(({ pid, parent, started }) => ({ pid, parent, started })), failures: failures.map(errorText), sockets,
      listenerEvidence: censusComplete && survivors.length === 0 ? "No surviving owned process can retain a listener" : "Unproven: surviving or unobserved process state" });
    used = false;
    if (failures.length > 0) throw new AggregateError(failures, `Owned close: ${failures.map(errorText).join("; ")}`);
  }
  return { browser: { run, evaluate },
    async newContext(label) {
      contexts = admitTodoContext(contexts);
      if (!used) {
        used = true;
        await run(["open"]); // Installs allowlist while retaining inert no-URL bootstrap.
        await census();
        const tabs = parseTabs(await run(["tab"]));
        const [initialTab] = tabs;
        assert.equal(tabs.length, 1); assert.ok(initialTab); assert.equal(initialTab.url, "about:blank");
        bootstrap = initialTab.tabId;
        await census();
      }
      const before = parseTabs(await run(["tab"]));
      const created = exactRecord(await run(["window", "new"]), ["tabId", "total"], "agent-browser0.32.3 window");
      assert.ok(typeof created.tabId === "string" && /^t\d+$/u.test(created.tabId) && typeof created.total === "number" && Number.isSafeInteger(created.total));
      await record(`fresh-${contexts}`, { label, result: created });
      const after = parseTabs(await run(["tab"]));
      assert.equal(created.total, after.length, "new window total must match complete tab census");
      assert.equal(after.length, before.length + 1, "new window must preserve all prior tabs");
      assert.ok(before.every((tab) => after.some((next) => next.tabId === tab.tabId)), "new window lost a prior tab");
      scenarioTabs = new Set(after.filter((tab) => !before.some((old) => old.tabId === tab.tabId)).map((tab) => tab.tabId));
      assert.equal(scenarioTabs.size, 1, "fresh window must create exactly one new context tab");
      assert.ok(scenarioTabs.has(created.tabId));
      assert.ok(after.some((tab) => tab.active && scenarioTabs.has(tab.tabId)));
    },
    async parkContext() {
      const before = parseTabs(await run(["tab"]));
      assert.equal(scenarioTabs.size, 1);
      const [tabId] = scenarioTabs;
      assert.ok(tabId && tabId !== bootstrap);
      // v0.32.3 can re-admit a queued target event after tab_close removes its
      // target, then fail network-control installation against the dead target.
      // Do not suppress that failure or disable the allowlist. Retain at most
      // eight genuine isolated contexts, parked inert until whole-browser close.
      await run(["open", "about:blank"]);
      const after = parseTabs(await run(["tab"]));
      assertTodoParkedTabs(before, after, tabId, contexts);
      await record(`parked-${contexts}`, { tabs: after, disposed: false });
      const errors = exactRecord(await run(["errors"]), ["errors"], "parked native page errors");
      const messages = await run(["console"]);
      await record(`parked-${contexts}-diagnostics`, { errors, messages });
      assert.deepEqual(errors.errors, [], "browser page errors after parking");
      assertTodoConsole(messages);
      await census();
    }, close };
}

const sampleProgram = `(() => {
  const styles = {}, boxes = [], keys = ${JSON.stringify(TODO_STYLE_KEYS)};
  const add = (name, node) => { if (!(node instanceof HTMLElement)) return;
    const rect = node.getBoundingClientRect(), computed = getComputedStyle(node);
    if (computed.display === 'none' || rect.width === 0 || rect.height === 0) return;
    boxes.push({name,x:rect.x,y:rect.y,width:rect.width,height:rect.height});
    styles[name] = Object.fromEntries(keys.map(key => [key, computed[key]])); };
  const todo = document.querySelector('main[aria-busy]');
  add('body', document.body); add('todo', todo);
  if (todo) { add('header', todo.querySelector('header')); add('eyebrow',todo.querySelector('header > p')); add('heading', todo.querySelector('h1'));
    add('remaining', todo.querySelector('header > span')); add('list', todo.querySelector('ul'));
    add('state', [...todo.children].find(e => e.tagName === 'P')); add('error', todo.querySelector('[role=alert]'));
    add('error-message',todo.querySelector('[role=alert] p')); add('retry', todo.querySelector('button'));
    [...todo.querySelectorAll('li')].forEach((li,i) => { add('item'+i,li); add('label'+i,li.querySelector('label')); add('checkbox'+i,li.querySelector('input')); add('title'+i,li.querySelector('label > span')); }); }
  const nav = document.querySelector('nav[aria-label="Todo scenarios"]');
  if (nav) { const aside=nav.closest('aside'); add('workbench',aside?.parentElement); add('sidebar',aside); add('sidebar-header',aside?.querySelector('header'));
    add('sidebar-eyebrow',aside?.querySelector('header > p')); add('sidebar-heading',aside?.querySelector('header > h1')); add('sidebar-description',aside?.querySelector('header > span')); add('navigation',nav);
    [...nav.querySelectorAll('a')].forEach((a,i)=>{add('scenario'+i,a);add('scenario-title'+i,a.querySelector('strong'));add('scenario-description'+i,a.querySelector('small'));});
    const details=aside?.querySelector('details'); add('details',details); add('summary',details?.querySelector('summary'));
    if(details?.open){add('claims',details.querySelector('ul'));[...details.querySelectorAll('li')].forEach((li,i)=>{add('claim'+i,li);add('claim-mode'+i,li.querySelector('strong'));});}
    const stage=document.querySelector('section[aria-label$=" scenario"]'); add('stage',stage); add('stage-header',stage?.querySelector('header'));
    add('stage-eyebrow',stage?.querySelector('header > p')); add('stage-heading',stage?.querySelector('header > h2')); add('stage-description',stage?.querySelector('header > span')); add('frame',stage?.querySelector('main[aria-busy]')?.parentElement); }
  if (!todo) { const error=document.querySelector('main[role=alert]'); add('activation-error',error); add('activation-eyebrow',error?.querySelector('p')); add('activation-heading',error?.querySelector('h1')); add('activation-description',error?.querySelector('span')); add('recovery',error?.querySelector('a')); }
  return {layout:{schema:'direct.named-layout-sample/v1',viewport:{width:innerWidth,height:innerHeight},boxes}, styles, horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
})()`;
const renderSettleProgram = `(async () => { await document.fonts.ready; await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); return true; })()`;
const semanticsProgram = `(() => {const todo=document.querySelector('main[aria-busy]');return {busy:todo?.getAttribute('aria-busy')??null,heading:todo?.querySelector('h1')?.textContent??null,empty:document.body.innerText.includes('No tasks in this list.'),checked:[...document.querySelectorAll('input[type=checkbox]')].map(e=>e.checked),titles:[...document.querySelectorAll('input[type=checkbox]')].map(e=>e.closest('label')?.querySelector('span')?.textContent),alert:document.querySelector('[role=alert]')?.textContent??null,bridge:typeof window.__direct==='object'};})()`;
const focusProgram = `(() => {const e=document.activeElement;if(!(e instanceof HTMLElement))return false;const s=getComputedStyle(e),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e.matches(':focus-visible')&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&s.outlineColor!=='rgba(0, 0, 0, 0)'&&r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1&&hit!==null&&(hit===e||e.contains(hit));})()`;
const cssAuditProgram = `(() => {
  if (!Object.hasOwn(window,'__todoStyleAudit')) {
    const mutations=[];
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element&&(node.matches('style')||node.querySelector('style'))){if(mutations.length<16)mutations.push('STYLE insertion');}});
    observer.observe(document,{subtree:true,childList:true});
    Object.defineProperty(window,'__todoStyleAudit',{value:{mutations,observer},configurable:false});
  }
  const roots=[document], nodes=[...document.querySelectorAll('*')];
  if(nodes.length>2048)throw new Error('CSS observation node bound exceeded');
  for(const node of nodes)if(node.shadowRoot)roots.push(node.shadowRoot);
  return {styleNodes:roots.reduce((n,root)=>n+root.querySelectorAll('style').length,0),adoptedSheets:roots.reduce((n,root)=>n+root.adoptedStyleSheets.length,0),mutations:[...window.__todoStyleAudit.mutations]};
})()`;
async function assertStaticCss(browser: Pick<AgentBrowser, "evaluate">): Promise<void> {
  assertTodoStaticCss(await browser.evaluate(cssAuditProgram));
}

async function settle(browser: Pick<AgentBrowser, "run" | "evaluate">, scenario: TodoAppearanceCase): Promise<DirectSessionBrowserContract | null> {
  const isDirect = scenario.startsWith("todos.");
  await browser.run(["wait", "--fn", scenario === "unknown" || scenario === "duplicate" ? "document.querySelector('main[role=alert]') !== null" : "document.querySelector('main[aria-busy]')?.getAttribute('aria-busy') === 'false'", "--timeout", "15000"]);
  await browser.evaluate(renderSettleProgram);
  if (!isDirect) return null;
  const deadline = Date.now() + 5000;
  let previous: DirectSessionBrowserContract | undefined;
  let quietSince = 0;
  while (Date.now() < deadline) {
    const contract = await readDirectBrowserContract(browser, { source: "scenario", scenario, route: "/" });
    assert.ok(parseDefinitionCoverageSnapshot(contract.manifest.coverage, todoDirectDefinition).ok, "coverage diverged from authored definition");
    assert.ok(Object.values(contract.probe.violations).every((value) => value === 0), "Direct violations");
    if (previous !== undefined) bindDirectBrowserContractEvidence(previous, contract);
    if (contract.probe.isQuiescent && previous !== undefined && JSON.stringify(contract.probe) === JSON.stringify(previous.probe)) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince >= 120) return contract;
    } else quietSince = 0;
    previous = contract;
    await Bun.sleep(25);
  }
  throw new Error("Direct probe never joined a stable quiet interval");
}

async function semantics(browser: Pick<AgentBrowser, "evaluate">): Promise<Record<string, unknown>> {
  return exactRecord(await browser.evaluate(semanticsProgram), ["busy", "heading", "empty", "checked", "titles", "alert", "bridge"], "Todo semantics");
}
async function assertNavigation(browser: Pick<AgentBrowser, "evaluate">, active: string): Promise<void> {
  const rows = await browser.evaluate(`[...document.querySelectorAll('nav[aria-label="Todo scenarios"] a')].map(a=>({href:a.getAttribute('href'),current:a.getAttribute('aria-current'),title:a.querySelector('strong')?.textContent,description:a.querySelector('small')?.textContent}))`);
  assert.deepEqual(rows, todoDirectDefinition.scenarios.list().map((scenario) => ({ href: todoCasePath(scenario.id as TodoAppearanceCase), current: scenario.id === active ? "page" : null, title: scenario.title, description: scenario.description })), "finite scenario navigation identity or selection changed");
}
async function keyboardTarget(browser: Pick<AgentBrowser, "run" | "evaluate">, selector: string, key: string | undefined, observe: () => Promise<void>): Promise<void> {
  for (let index = 0; index < 24; index++) {
    const matched = await browser.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`);
    if (matched === true) {
      await browser.evaluate(renderSettleProgram);
      const visible = await browser.evaluate(focusProgram);
      assert.equal(visible, true, "native keyboard focus indicator missing or clipped");
      await observe();
      if (key !== undefined) await browser.run(["press", key]);
      return;
    }
    await browser.run(["press", "Tab"]);
  }
  throw new Error("native keyboard target not reached within the finite tab cycle");
}

async function checkCase(batch: NativeBatch, baseUrl: string, scenario: TodoAppearanceCase, width: number,
  saveSample: (key: string, value: TodoAppearanceSample) => void, record: (key: string, value: unknown) => Promise<void>, directory: string, countScreenshot: (bytes: number) => void): Promise<void> {
  const browser = batch.browser, label = `${scenario}-${width}`;
  let activeScenario = scenario;
  await batch.newContext(label);
  await withCleanup(async () => {
    await browser.run(["set", "viewport", String(width), width === 1280 ? "900" : "844", "1"]);
    await browser.run(["set", "media", "light", "reduced-motion"]);
    await browser.run(["open", `${baseUrl}${todoCasePath(scenario)}`]);
    const identity = exactRecord(await browser.evaluate("({userAgent:navigator.userAgent,platform:navigator.platform,width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})"), ["userAgent", "platform", "width", "height", "deviceScaleFactor", "reducedMotion"], "browser presentation identity");
    assert.equal(identity.width, width); assert.equal(identity.height, width === 1280 ? 900 : 844);
    assert.equal(identity.deviceScaleFactor, 1); assert.equal(identity.reducedMotion, true);
    assert.ok(typeof identity.userAgent === "string" && typeof identity.platform === "string");
    await record(`${label}-browser`, identity);
    const initial = await settle(browser, scenario);
    await assertStaticCss(browser);
    await record(`${label}-initial-contract`, initial);
    const observe = async (state: string) => {
      await settle(browser, activeScenario);
      await assertStaticCss(browser);
      const first = parseTodoAppearanceSample(await browser.evaluate(sampleProgram));
      await browser.evaluate(renderSettleProgram);
      const second = parseTodoAppearanceSample(await browser.evaluate(sampleProgram));
      assertTodoStable(first, second);
      const key = `${label}/${state}`;
      saveSample(key, second);
      await record(`${label}-${state}-sample`, second);
      const screenshotPath = join(directory, `${label}-${state}.png`);
      await browser.run(["screenshot", screenshotPath]);
      const screenshot = await ordinaryFile(screenshotPath, 8 * 1024 * 1024);
      countScreenshot(screenshot.length);
      await record(`${label}-${state}-screenshot`, { file: basename(screenshotPath), size: screenshot.length, sha256: sha256(screenshot) });
    };
    const focus = (selector: string, name: string, key?: string) => keyboardTarget(browser, selector, key, () => observe(`focus-${name}`));
    const current = await semantics(browser);
    if (scenario === "production") {
      assert.equal(current.bridge, false); assert.equal(current.empty, true); assert.deepEqual(current.checked, []);
      await observe("empty");
      await browser.evaluate(`localStorage.setItem(${JSON.stringify(TODO_STORAGE_KEY)},${JSON.stringify(JSON.stringify(POPULATED_TODOS))})`);
      await browser.run(["reload"]); await settle(browser, scenario);
      assert.deepEqual((await semantics(browser)).checked, [false, true]);
      await observe("populated");
      await focus('input[type="checkbox"]', "checkbox", "Space"); await settle(browser, scenario);
      assert.deepEqual((await semantics(browser)).checked, [true, true]);
      await browser.run(["reload"]); await settle(browser, scenario);
      assert.deepEqual((await semantics(browser)).checked, [true, true]);
      await observe("persisted");
      await browser.evaluate(`localStorage.setItem(${JSON.stringify(TODO_STORAGE_KEY)},'{')`);
      await browser.run(["reload"]); await settle(browser, scenario);
      assert.match(String((await semantics(browser)).alert), /Stored todos are not valid JSON/u);
      await observe("malformed-storage");
      await browser.evaluate(`localStorage.setItem(${JSON.stringify(TODO_STORAGE_KEY)},'[]')`);
      await focus("button", "retry", "Enter"); await settle(browser, scenario);
      assert.equal((await semantics(browser)).empty, true);
      assert.equal((await semantics(browser)).bridge, false);
    } else if (scenario === "unknown" || scenario === "duplicate") {
      assert.equal(current.bridge, false); assert.match(String(current.alert), /Todo Direct could not start/u);
      await observe("rejected");
      await focus("main[role=alert] a", "recovery", "Enter");
      const recovered = await settle(browser, "todos.populated");
      assert.ok(recovered); assert.deepEqual((await semantics(browser)).checked, [false, true]);
      await assertNavigation(browser, "todos.populated");
      await record(`${label}-recovered-contract`, recovered);
    } else {
      await assertNavigation(browser, scenario);
      assert.equal(current.bridge, true); assert.equal(current.heading, "Today");
      assert.deepEqual(current.checked, scenario === "todos.empty" ? [] : [false, true]);
      if (scenario !== "todos.empty") assert.deepEqual(current.titles, POPULATED_TODOS.map((todo) => todo.title));
      else assert.equal(current.empty, true);
      await observe("initial");
      if (scenario === "todos.populated" && width === 1280) {
        for (const edge of TODO_BREAKPOINT_WIDTHS) {
          await browser.run(["set", "viewport", String(edge), "900", "1"]);
          await observe(`edge-${edge}`);
        }
        await browser.run(["set", "viewport", String(width), "900", "1"]);
      }
      if (scenario !== "todos.empty") {
        await focus('input[type="checkbox"]', "checkbox", "Space"); await settle(browser, scenario);
        const next = await semantics(browser);
        assert.deepEqual(next.checked, scenario === "todos.write-failure" ? [false, true] : [true, true]);
        if (scenario === "todos.write-failure") assert.match(String(next.alert), /The deterministic store rejected this change/u);
        else assert.equal(next.alert, null);
        await observe("after-action");
      }
      await focus("summary", "summary-closed", "Enter");
      assert.equal(await browser.evaluate("document.querySelector('details')?.open"), true);
      await focus("summary", "summary-open", "Space");
      assert.equal(await browser.evaluate("document.querySelector('details')?.open"), false);
      for (let index = 1; index <= 3; index++) await focus(`nav[aria-label="Todo scenarios"] a:nth-child(${index})`, `scenario-${index}`);
      const final = await settle(browser, scenario);
      assert.ok(initial && final); bindDirectBrowserContractEvidence(initial, final);
      await record(`${label}-final-contract`, final);
      await browser.run(["reload"]); await settle(browser, scenario);
      assert.deepEqual((await semantics(browser)).checked, scenario === "todos.empty" ? [] : [false, true], "fresh fixture reload did not restore its declared state");
      const destination: TodoAppearanceCase = scenario === "todos.empty" ? "todos.populated" : "todos.empty";
      const destinationIndex = destination === "todos.empty" ? 1 : 2;
      await focus(`nav[aria-label="Todo scenarios"] a:nth-child(${destinationIndex})`, "navigate", "Enter");
      activeScenario = destination;
      const navigated = await settle(browser, destination);
      assert.ok(navigated); await assertNavigation(browser, destination);
      assert.deepEqual((await semantics(browser)).checked, destination === "todos.empty" ? [] : [false, true]);
      await record(`${label}-navigated-contract`, navigated);
      await observe(`navigated-${destination}`);
    }
    await browser.evaluate(renderSettleProgram);
    await assertStaticCss(browser);
    const errors = exactRecord(await browser.run(["errors"]), ["errors"], "agent-browser0.32.3 errors");
    await record(`${label}-errors`, errors); assert.deepEqual(errors.errors, [], "browser page errors");
    const messages = exactRecord(await browser.run(["console"]), ["messages"], "agent-browser0.32.3 console");
    await record(`${label}-console`, messages);
    assertTodoConsole(messages);
  }, () => batch.parkContext());
}

async function checkNegativeControls(batch: NativeBatch, baseUrl: string, record: (key: string, value: unknown) => Promise<void>): Promise<void> {
  for (const control of ["stylesheet", "focus", "descendant-paint"] as const) {
    await batch.newContext(`negative-${control}`);
    await withCleanup(async () => {
      const browser = batch.browser;
      await browser.run(["set", "viewport", "1280", "900", "1"]);
      await browser.run(["set", "media", "light", "reduced-motion"]);
      const navigate = async () => { await browser.run(["open", `${baseUrl}${todoCasePath("todos.populated")}`]); await settle(browser, "todos.populated"); await assertStaticCss(browser); };
      await navigate();
      const before = parseTodoAppearanceSample(await browser.evaluate(sampleProgram));
      if (control === "stylesheet") {
        await browser.evaluate(`(() => {const sheets=[...document.styleSheets].filter(sheet=>sheet.href===location.origin+'/stylex.css');if(sheets.length!==1||sheets[0].disabled)throw new Error('Exact final StyleX sheet absent');sheets[0].disabled=true;return true;})()`);
        await browser.evaluate(renderSettleProgram);
        const changed = parseTodoAppearanceSample(await browser.evaluate(sampleProgram));
        const differences = compareTodoAppearance("negative-stylesheet", before, changed);
        assert.ok(differences.length > 0, "final StyleX stylesheet removal did not trip the comparison oracle");
        await record("negative-stylesheet", { rejected: true, differences });
      } else if (control === "focus") {
        await keyboardTarget(browser, 'input[type="checkbox"]', undefined, async () => {});
        assert.equal(await browser.evaluate(focusProgram), true);
        await browser.evaluate("(() => {document.activeElement.style.setProperty('outline','none','important');return true;})()");
        await browser.evaluate(renderSettleProgram);
        assert.equal(await browser.evaluate(focusProgram), false, "focus suppression did not trip the native focus oracle");
        await record("negative-focus", { positiveBefore: true, rejectedAfterSuppression: true });
      } else {
        await browser.evaluate(`(() => {const child=document.querySelector('nav[aria-label="Todo scenarios"] a small');if(!(child instanceof HTMLElement))throw new Error('Scenario description absent');child.style.setProperty('opacity','0','important');return true;})()`);
        const changed = parseTodoAppearanceSample(await browser.evaluate(sampleProgram));
        const differences = compareTodoAppearance("negative-descendant", before, changed);
        assert.ok(differences.some((difference) => difference.box === "scenario-description0" && difference.property === "opacity" && difference.current === "0"), "descendant-only opacity mutation did not trip the oracle");
        await record("negative-descendant-paint", { rejected: true, differences });
      }
      // Recovery is a new document from immutable files, not an oracle bypass.
      await navigate();
      assert.deepEqual(compareTodoAppearance(`negative-${control}-recovery`, before, parseTodoAppearanceSample(await browser.evaluate(sampleProgram))), []);
      await keyboardTarget(batch.browser, 'input[type="checkbox"]', undefined, async () => {});
      await record(`negative-${control}-recovered`, { appearance: true, nativeFocus: true });
    }, () => batch.parkContext());
  }
}

async function runSource(input: TodoAppearanceInput, source: TodoSourceIdentity, label: string, directory: string): Promise<Map<string, TodoAppearanceSample>> {
  const samples = new Map<string, TodoAppearanceSample>();
  let receiptNumber = 0, receiptBytes = 0;
  const countScreenshot = (bytes: number) => { receiptBytes += bytes; assert.ok(receiptBytes <= maxArtifactBytes, "screenshot receipt quota exceeded"); };
  const record = async (key: string, value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    receiptBytes += bytes.length;
    assert.ok(bytes.length <= 1024 * 1024 && receiptBytes <= maxArtifactBytes && receiptNumber < 8000, "private native receipt quota exceeded");
    await writeFile(join(directory, `${String(++receiptNumber).padStart(5, "0")}-${key}.json`), bytes, { mode: 0o600, flag: "wx" });
  };
  for (const kind of ["production", "direct"] as const) {
    const build = source[kind], baseUrl = `http://127.0.0.1:${input.port}`;
    const lease = await acquireVerificationServer({ baseUrl, label: `${label} ${kind}`, reuseExistingLocalServer: false,
      readinessPath: kind === "production" ? "/" : "/direct/", startupTimeoutMs: 10_000,
      startServer: () => spawnVerificationServer({ command: [process.execPath, ownFile, "--serve", build.directory, String(input.port), build.inventorySha256], cwd: repositoryRoot, detachedProcessGroup: true, logLimit: 12_000 }) });
    if (lease.source !== "started") throw new Error("native harness cannot adopt a server");
    await withCleanup(async () => {
      const cases = TODO_APPEARANCE_CASES.filter((scenario) => (scenario === "production") === (kind === "production"))
        .flatMap((scenario) => TODO_APPEARANCE_WIDTHS.map((width) => ({ scenario, width })));
      for (const [index, casesInBatch] of boundedTodoBatches(cases).entries()) {
        const batchDirectory = join(directory, `${kind}-batch-${index}`);
        await mkdir(batchDirectory, { mode: 0o700 });
        const batch = await createNativeBatch(input, batchDirectory, (key, value) => record(`${kind}-${index}-${key}`, value));
        await withCleanup(async () => { for (const row of casesInBatch) await checkCase(batch, baseUrl, row.scenario, row.width, (key, value) => {
          assert.ok(!samples.has(key), "duplicate appearance sample"); samples.set(key, value);
        }, record, batchDirectory, countScreenshot); }, () => batch.close());
      }
      if (kind === "direct" && source === input.current) {
        const negativeDirectory = join(directory, "negative-controls");
        await mkdir(negativeDirectory, { mode: 0o700 });
        const batch = await createNativeBatch(input, negativeDirectory, (key, value) => record(`negative-${key}`, value));
        await withCleanup(() => checkNegativeControls(batch, baseUrl, record), () => batch.close());
      }
      const response = await fetch(`${baseUrl}/__todo_native_receipt`, { signal: AbortSignal.timeout(1500) });
      const receipt = exactRecord(await response.json(), ["inventorySha256", "requests", "denied"], "owned static server receipt");
      assert.equal(receipt.inventorySha256, build.inventorySha256); assert.deepEqual(receipt.denied, []);
      await record(`${kind}-server`, receipt);
    }, async () => {
      await stopVerificationServer(lease.server, 5000);
      const probe = await fetch(`${baseUrl}/__todo_native_receipt`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
      await record(`${kind}-server-close`, { ownedProcessExited: lease.server.exitCode() !== undefined && lease.server.exitCode() !== null, loopbackResponding: probe, output: lease.server.outputSnapshot?.() });
      assert.equal(probe, false, "loopback server still responds after owned shutdown");
    });
    assert.equal((await todoBuildInventory(build.directory)).sha256, build.inventorySha256);
  }
  return samples;
}

export async function runTodoAppearance(input: TodoAppearanceInput): Promise<string> {
  assert.equal(Bun.version, "1.3.14");
  assert.equal(await realpath(input.browser.driver), input.browser.driver, "use the native executable, not a shim with chmod side effects");
  assert.equal(await realpath(input.browser.executable), input.browser.executable, "browser executable must be canonical");
  assert.equal(basename(input.browser.driver), `agent-browser-${process.platform}-${process.arch}`);
  assert.equal(sha256(await ordinaryFile(input.browser.driver, 128 * 1024 * 1024)), input.browser.driverSha256);
  assert.equal(sha256(await ordinaryFile(input.browser.executable, 256 * 1024 * 1024)), input.browser.executableSha256);
  const driverVersion = await runVerificationCommand({ command: [input.browser.driver, "--version"], cwd: repositoryRoot, label: "pinned driver version", timeoutMs: 5000 });
  assert.equal(driverVersion.trim(), "agent-browser 0.32.3");
  const version = await runVerificationCommand({ command: [input.browser.executable, "--version"], cwd: repositoryRoot, label: "pinned Chromium version", timeoutMs: 5000 });
  assert.ok(version.trim().endsWith(input.browser.version), "browser version differs from explicit input");
  await verifySource(input.current); await verifySource(input.baseline);
  if (input.canary !== null) await verifySource(input.canary.source);
  assert.equal(await realpath(input.artifactParent), input.artifactParent);
  const directory = await mkdtemp(join(input.artifactParent, "todo-native-"));
  await chmod(directory, 0o700);
  await writeFile(join(directory, "input.json"), `${JSON.stringify(input)}\n`, { mode: 0o600, flag: "wx" });
  let accepted = false;
  const differences: TodoAppearanceDifference[] = [];
  let failure: string | null = null;
  try {
    const beforeSource = input.mode === "compare" ? input.baseline : input.current;
    const afterSource = input.canary?.source ?? input.current;
    const beforeDirectory = join(directory, "before"), afterDirectory = join(directory, "after");
    await mkdir(beforeDirectory, { mode: 0o700 }); await mkdir(afterDirectory, { mode: 0o700 });
    const before = await runSource(input, beforeSource, "before", beforeDirectory);
    const after = await runSource(input, afterSource, "after", afterDirectory);
    assert.deepEqual([...after.keys()], [...before.keys()], "appearance sample census changed");
    for (const [key, sample] of before) {
      const paired = after.get(key);
      assert.ok(paired, "paired appearance sample missing");
      differences.push(...compareTodoAppearance(key, sample, paired));
    }
    const canary = input.canary;
    if (canary === null) assert.deepEqual(differences, [], "native appearance differs from baseline");
    else assert.ok(differences.some((difference) => difference.sample === canary.sample && difference.box === canary.box && difference.property === canary.property), "rebuilt canary did not trip its declared appearance oracle");
    await verifySource(beforeSource); await verifySource(afterSource);
    accepted = true;
    return directory;
  } catch (error) {
    failure = (error instanceof Error ? `${error.name}: ${error.message}` : "Unknown native appearance failure").slice(0, 4096);
    throw error;
  } finally {
    await writeFile(join(directory, "receipt.json"), `${JSON.stringify({ schema: "direct.todo-native-receipt/v1", accepted, failure, mode: input.mode, browser: { version: input.browser.version, driverSha256: input.browser.driverSha256, executableSha256: input.browser.executableSha256 }, differences, limits: ["fixture browser proof does not establish storage quota, remote services or device behavior", "completed contexts are parked at about:blank and retained until whole-browser close, not individually disposed", "console/error observations sample the active case and parking transition, not continuous background-context monitoring", "runtime CSS observer starts at initial settled document; transient insertion before observer attachment is not claimed", "screenshots are retained evidence; comparison uses authored named geometry and computed presentation, not a screenshot similarity score", "appearance samples require quiescence; transient loading and busy-state paint is not observed"] })}\n`, { mode: 0o600, flag: "wx" });
  }
}
if (import.meta.main) {
  if (process.argv[2] === "--serve") {
    const [, , , directory, port, inventory] = process.argv;
    assert.equal(process.argv.length, 6); assert.ok(directory && port && inventory);
    await serveBuild(directory, Number(port), inventory);
  } else if (process.argv[2] === "--inventory") {
    const directory = process.argv[3];
    assert.equal(process.argv.length, 4); assert.ok(directory);
    console.log(JSON.stringify(await todoBuildInventory(await realpath(directory))));
  } else {
    assert.equal(process.argv.length, 3, "Pass one exact private JSON input path");
    const inputPath = process.argv[2]; assert.ok(inputPath);
    const input = parseTodoAppearanceInput(JSON.parse((await ordinaryFile(resolve(inputPath), 64 * 1024)).toString()));
    console.log(await runTodoAppearance(input));
  }
}
