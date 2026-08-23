/**
 * Writes the session index in a tight loop until killed. Used by
 * verify-workflow to prove that a process dying mid-write cannot leave the
 * file unreadable. Not part of the extension.
 */
import { createRequire } from "node:module";
const store = createRequire(import.meta.url)(process.argv[2]).store;
const [, , , root, id] = process.argv;
const big = Array.from({ length: 400 }, (_, i) => ({
  sessionId: `s${i}`, when: i, title: "x".repeat(4000),
}));
for (;;) for (const s of big) store.recordSession(root, id, s);
