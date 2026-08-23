/**
 * Runs the real transcript->events conversion against a real stored session,
 * so resume is verified against the CLI's actual on-disk format and not only
 * against the fake SDK's idea of it.
 */
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { transcriptToEvents, REPLAY_LIMIT } from "./.replay.mjs";

// Run with: npm run probe:replay -- /path/to/a/project
const dir = process.argv[2] ?? process.cwd();
const sessions = (await listSessions({ dir })).sort((a, b) => b.fileSize - a.fileSize);
if (!sessions.length) { console.log(`no stored sessions in ${dir}`); process.exit(0); }
const s = sessions[0];
const msgs = await getSessionMessages(s.sessionId, { dir, limit: REPLAY_LIMIT });
const events = transcriptToEvents(msgs, s.summary);
console.log(`"${s.summary}" — ${msgs.length} messages -> ${events.length} events\n`);
for (const e of events) {
  const gist =
    e.kind === "userSaid" ? e.text :
    e.kind === "say" || e.kind === "think" ? e.delta :
    e.kind === "act" ? `${e.tool} ${e.summary}` :
    e.kind === "actEnd" ? `${e.ok ? "ok" : "FAILED"} ${e.summary}` :
    e.kind === "assign" ? `-> ${e.assignment.to}: ${e.assignment.brief}` :
    e.kind === "deliver" ? `${e.outcome}: ${e.summary}` :
    e.kind === "notice" ? e.text : "";
  console.log(`  ${e.kind.padEnd(9)} ${gist.replace(/\s+/g, " ").slice(0, 92)}`);
}
