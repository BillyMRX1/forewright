import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectContext, type ProjectContextValue } from "./live.js";
import { LmstudioSetupCard } from "./lmstudio-setup.js";

test("browser Settings exposes LM Studio setup and explicit private-harness installation", () => {
  const context = { rpc: {}, notify: () => {} } as unknown as ProjectContextValue;
  const closed = renderToStaticMarkup(<ProjectContext.Provider value={context}><LmstudioSetupCard /></ProjectContext.Provider>);
  assert.match(closed, /Set up LM Studio/);
  const form = renderToStaticMarkup(<ProjectContext.Provider value={context}><LmstudioSetupCard initiallyOpen /></ProjectContext.Provider>);
  for (const label of ["LM Studio endpoint", "LM Studio OpenCode binary", "LM Studio model", "LM Studio execution mode", "Concurrent local workers", "LM Studio worker timeout"]) assert.ok(form.includes(`aria-label="${label}"`), label);
  assert.match(form, /Install compatible OpenCode for Forewright only/);
  assert.match(form, /local-only/);
  assert.match(form, /worker permission remains a project choice/);
});
