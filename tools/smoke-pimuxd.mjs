import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "pi") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    assert.equal(m.type, "get_state");
    console.log(JSON.stringify({ type: "response", command: m.type, success: true, data: { pid: process.pid } }));
  });
} else if (process.argv[2] === "agent") {
  const emit = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const lines = createInterface({ input: process.stdin });
  let promptId;
  let permissionCancelled = false;
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    const reply = (result) => emit({ id: m.id, result });
    switch (m.method) {
      case "initialize": reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } }); break;
      case "session/new": reply({ sessionId: "test-agent-id" }); break;
      case "session/load":
        assert.equal(m.params.sessionId, "test-agent-id");
        reply({});
        break;
      case "session/prompt":
        assert.equal(m.params.prompt[0].text, "Hold for approval");
        promptId = m.id;
        permissionCancelled = false;
        emit({ method: "session/update", params: { sessionId: m.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial answer" } } } });
        emit({ id: "permission-1", method: "session/request_permission", params: {
          sessionId: m.params.sessionId, toolCall: { toolCallId: "tool", title: "Test approval" },
          options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
        } });
        break;
      case "session/cancel":
        assert(permissionCancelled);
        emit({ id: promptId, result: { stopReason: "cancelled" } });
        break;
      case undefined:
        assert.equal(m.id, "permission-1");
        assert.equal(m.result?.outcome?.outcome, "cancelled");
        permissionCancelled = true;
        break;
      default: throw new Error(`Unexpected call: ${m.method}`);
    }
  });
} else {
  const [binaryArg, scratchArg] = process.argv.slice(2);
  assert(binaryArg && scratchArg, "Usage: node tools/smoke-pimuxd.mjs BINARY SCRATCH_DIR");
  const binary = resolve(binaryArg);
  const cwd = resolve(scratchArg);
  await mkdir(cwd, { recursive: true });
  // macOS Unix sockets have a short path limit. Use the same relative path for both ends.
  process.chdir(cwd);
  const env = { ...process.env, PIMUXD_DIR: "state" };
  let daemon;
  const send = (sock, value) => sock.write(JSON.stringify(value) + "\n");
  async function dial(op) {
    const sock = connect("state/daemon.sock");
    await once(sock, "connect");
    const messages = [];
    const lines = createInterface({ input: sock });
    lines.on("line", (line) => messages.push(JSON.parse(line)));
    sock.on("error", () => {});
    send(sock, op);
    return {
      sock, messages, send: (m) => send(sock, m),
      async until(pred) {
        for (let i = 0; i < 250; i++) {
          const match = messages.find(pred);
          if (match) return match;
          await delay(20);
        }
        throw new Error(`Timed out: ${JSON.stringify(messages)}`);
      },
    };
  }
  const call = async (op) => {
    const peer = await dial(op);
    try { return await peer.until(() => true); } finally { peer.sock.destroy(); }
  };
  async function start() {
    daemon = spawn(binary, ["serve"], { cwd, env: { ...env, PATH: "/nonexistent" }, stdio: "inherit" });
    for (let i = 0; i < 100; i++) {
      try {
        const hello = await call({ op: "hello" });
        assert.equal(hello.protocol, 6);
        assert.equal(hello.canNavigate, true);
        return;
      }
      catch { if (daemon.exitCode !== null) break; await delay(25); }
    }
    throw new Error("Daemon did not start");
  }
  const list = (opts) => call({ op: "list", ...opts });
  const session = async (key) => (await list()).sessions.find((row) => row.key === key);
  const reveal = (key, reconnect = false) => call({ op: "reveal", key, reconnect });
  async function waitDetached(key) {
    for (let i = 0; i < 100; i++) {
      const row = await session(key);
      if (row?.attached === false) return row;
      await delay(20);
    }
    throw new Error(`Session did not detach: ${key}`);
  }
  async function checkPiAttach() {
    // Skip Pi's --mode rpc prefix before launching the mock agent.
    const command = resolve("pi-mock");
    await writeFile(command, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o700 });
    const owner = await dial({ op: "open", command, args: [process.execPath, script, "pi"], env, cwd, canReveal: true });
    owner.send({ type: "get_state" });
    const pid = (await owner.until((m) => m.type === "response")).data.pid;
    const [{ key }] = (await list()).sessions;
    const attach = { op: "pi_attach", key, policy: "deny" };
    assert.equal((await call({ ...attach, key: "missing-pi" })).type, "daemon_exit");
    assert.equal((await call({ ...attach, takeover: true })).type, "daemon_exit");
    assert.deepEqual(await reveal(key), { status: "revealed" });
    await owner.until((m) => m.type === "daemon_reveal");
    owner.sock.destroy();
    await waitDetached(key);
    assert.deepEqual(await reveal(key, true), { status: "queued" });
    const next = await dial(attach);
    await next.until((m) => m.type === "daemon_attached");
    assert.equal((await session(key)).canReveal, false);
    assert.deepEqual(await reveal(key, true), { status: "unavailable" });
    next.send({ type: "get_state" });
    assert.equal((await next.until((m) => m.type === "response")).data.pid, pid);
    next.sock.destroy();
    await waitDetached(key);
    assert.equal((await list({ reconnectCwds: [cwd] })).reconnect, undefined);
    assert.equal((await call({ op: "kill", key })).ok, true);
  }
  const key = "acp-smoke";
  const launch = { command: process.execPath, args: [script, "agent"], env, cwd, acpBackend: { name: "First profile" } };
  const second = { ...launch, args: [...launch.args, "second"], acpBackend: { name: "Second profile" } };
  const ready = (m) => m.type === "acpStatus" && m.ready === true;
  try {
    await start();
    await checkPiAttach();
    const controller = await dial({ op: "acp_open", key, ...launch, canReveal: true });
    await controller.until(ready);
    const other = await dial({ op: "acp_open", key: "second", ...second });
    await other.until(ready);
    const { sessions, canNavigate } = await list();
    assert.equal(canNavigate, true);
    const ownerRow = sessions.find((s) => s.key === key);
    assert.equal(ownerRow.canReveal, true);
    const backend = ownerRow.acpBackend;
    assert.equal(backend.name, "First profile");
    assert.equal(backend.fingerprint, createHash("sha256").update(JSON.stringify([launch.command, launch.args])).digest("hex"));
    assert.equal(sessions.find((s) => s.key === "second").acpBackend.name, "Second profile");
    assert.deepEqual(await reveal("second", true), { status: "unavailable" });
    assert.equal((await call({ op: "kill", key: "second" })).ok, true);
    other.sock.destroy();
    assert.match((await call({ op: "shutdown" })).error, /live sessions/);
    const observer = await dial({ op: "acp_observe", key, canReveal: true });
    await observer.until(ready);
    assert.deepEqual(await reveal(key, true), { status: "revealed" });
    assert.deepEqual(await controller.until((m) => m.type === "daemon_reveal"), { type: "daemon_reveal" });
    assert.equal((await call({ op: "acp_attach", key })).type, "acp_attachError");
    observer.send({ type: "prompt", text: "Must not run" });
    controller.send({ type: "prompt", text: "Hold for approval" });
    await controller.until((m) => m.type === "permission");
    controller.sock.destroy();
    const detached = await waitDetached(key);
    assert.equal(detached.canReveal, false);
    assert.equal(detached.observers, 1);
    assert.equal((await call({ op: "pi_attach", key })).type, "daemon_exit");
    assert.deepEqual(await reveal(key), { status: "unavailable" });
    assert.deepEqual(await reveal(key, true), { status: "queued" });
    assert.equal((await list()).reconnect, undefined);
    assert.equal((await call({ op: "hello", reconnectCwds: [cwd] })).reconnect, undefined);
    assert.equal((await list({ reconnectCwds: [".", `${cwd}-other`, `${cwd}/child`] })).reconnect, undefined);
    const matches = await Promise.all([list({ reconnectCwds: [`${cwd}/./`] }), list({ reconnectCwds: [`${cwd}/child/../`] })]);
    const reconnected = matches.flatMap((m) => m.reconnect ?? []);
    assert.equal(reconnected.length, 1);
    assert.equal(reconnected[0].key, key);
    assert.equal(reconnected[0].attached, false);
    assert.equal((await list({ reconnectCwds: [cwd] })).reconnect, undefined);
    const again = await dial({ op: "acp_attach", key, canReveal: true });
    await again.until((m) => m.type === "permission");
    assert.equal((await session(key)).canReveal, true);
    assert(!observer.messages.some((m) => m.type === "daemon_reveal"));
    assert(!observer.messages.some((m) => m.type === "permission"));
    await delay(1200);
    assert.match(await readFile(`state/journal/${key}.json`, "utf8"), /Partial answer/);
    daemon.kill("SIGKILL");
    await once(daemon, "exit");
    again.sock.destroy();
    observer.sock.destroy();
    await start();
    const recovered = await call({ op: "inspect", key });
    assert.equal(recovered.interrupted, true);
    assert.match(JSON.stringify(recovered.messages), /Partial answer/);
    const reopen = await dial({ op: "acp_attach", key });
    const archived = await reopen.until((m) => m.recoverable);
    assert.equal(archived.canRestoreContext, true);
    assert.equal((await reopen.until((m) => m.type === "acp_attached")).acpBackend.name, "First profile");
    reopen.send({ type: "acp_relaunch", ...second, restoreContext: true });
    await reopen.until((m) => m.type === "error" && /does not match/.test(m.message));
    reopen.send({ type: "acp_relaunch", ...launch, restoreContext: true });
    await reopen.until(ready);
    assert(!reopen.messages.some((m) => m.type === "permission"));
    reopen.send({ type: "prompt", text: "Hold for approval" });
    await reopen.until((m) => m.type === "permission");
    reopen.send({ type: "abort" });
    await reopen.until((m) => m.event?.type === "agent_settled");
    assert.equal((await call({ op: "stop", key })).ok, true);
    await reopen.until((m) => m.type === "acpStatus" && m.recoverable && m !== archived);
    assert.equal((await call({ op: "inspect", key })).interrupted, false);
    assert.equal(reopen.messages.filter((m) => m.type === "permission").length, 1);
    assert.equal((await call({ op: "kill", key })).ok, true);
    reopen.sock.destroy();
    const exited = once(daemon, "exit");
    assert.equal((await call({ op: "shutdown" })).ok, true);
    await exited;
    console.log("Native session navigation, ACP lease, permission replay, cancellation, crash recovery, context load, and shutdown passed");
  } finally {
    if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  }
}
