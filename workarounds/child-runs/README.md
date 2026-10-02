# child-runs

**Gap:** extensions run their own agent sessions in the pi process (subagents, workflow agents, side threads). RPC events describe only the main session, so the chat looked idle while they worked, and a session switch stopped the process and the work.

**Workaround:** `pi.ts` wraps `AgentSession.prototype.prompt` and counts the prompts that run on other agent sessions. It reports the count and their session files in the hidden status `vscode:work`.

- `host.ts` makes such a process busy: on a session switch it goes to the background instead of being stopped, and no other process can open the session files it writes.

**Remove when:** pi's RPC mode reports agent sessions that extensions run.

**Uses pi internals:** `pi.ts` imports pi's own module (the file next to `cli.js`) and wraps a method that is not part of the extension API. A pi update can break it. Turn it off with `"pi.workarounds": { "child-runs": false }`.

