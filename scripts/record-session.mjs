/**
 * Records one conversation in a workflow's index, as a second editor window
 * would. Used by verify-workflow to prove two windows writing at once do not
 * lose each other's work. Not part of the extension.
 */
import { createRequire } from "node:module";
const store = createRequire(import.meta.url)(process.argv[2]).store;
const [, , , root, id, sid] = process.argv;
store.recordSession(root, id, { sessionId: sid, title: sid, when: Number(sid.split("-")[1]) || 1 });
