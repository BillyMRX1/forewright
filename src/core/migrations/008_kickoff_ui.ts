import type { Migration } from "./index.js";

// Whether the kickoff pack has UI documents: "yes" or "no" once the CTO decided, null before. `ui_reason` is
// the CTO's one-line reason, shown in the manifest, the digest and the viewers ("No UI documents: <reason>").
// Wireframes are rows of kickoff_doc with the key `wireframe:<name>`, so they share versions, hashes, the pack
// revision, the approval snapshot and edit detection with the other documents.
export const migration008: Migration = {
  version: 8,
  name: "kickoff_ui",
  sql: `
ALTER TABLE kickoff_pack ADD COLUMN ui TEXT;
ALTER TABLE kickoff_pack ADD COLUMN ui_reason TEXT;
`,
};
