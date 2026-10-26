import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequirementDoc } from "../core/store-types.js";
import { PickerView } from "./Picker.js";
import type { PickerViewProps } from "./Picker.js";
import { HINTS, HintBar, UnauthorizedScreen, ComingSoon, TopBar, VIEWS, connectionLabel } from "./Shell.js";
import { relTime } from "./ui.js";
import { COMMANDS, EmptyState, MessageItem, PrdCard, PrdReader, suggestCommands } from "./views/Cto.js";

const doc: RequirementDoc = {
  id: "d1",
  revision: 2,
  status: "proposed",
  title: "Todo app",
  body: "## Goal\n\nTrack **todos**.",
  summaryOfChange: "",
  author: "cto",
  createdAt: "2026-01-01T00:00:00.000Z",
  approvedAt: null,
  approvedBy: null,
  requirements: [{ key: "R1", text: "Add a todo" }],
};

const noop = () => undefined;

test("the PRD card names the revision and offers Read and Approve", () => {
  const out = renderToStaticMarkup(<PrdCard doc={doc} approved={false} onRead={noop} onApprove={noop} />);
  assert.match(out, /PRD r2 ready for you/);
  assert.match(out, /Todo app/);
  assert.match(out, />Read</);
  assert.match(out, />Approve</);
});

test("an approved PRD card shows Approved instead of the button", () => {
  const out = renderToStaticMarkup(<PrdCard doc={doc} approved onRead={noop} onApprove={noop} />);
  assert.match(out, /PRD r2 approved/);
  assert.doesNotMatch(out, /btn-primary/);
  assert.match(out, />Approved</);
});

test("the PRD reader is a labelled modal with requirements and a Markdown body", () => {
  const out = renderToStaticMarkup(<PrdReader doc={doc} onClose={noop} onApprove={noop} />);
  assert.match(out, /role="dialog"/);
  assert.match(out, /aria-modal="true"/);
  assert.match(out, /aria-labelledby=/);
  assert.match(out, /PRD r2: Todo app/);
  assert.match(out, /R1<\/code> Add a todo/);
  assert.match(out, /<strong>todos<\/strong>/);
});

test("messages are attributed to Billy, the CTO or Forewright and render as Markdown text", () => {
  const base = { id: "m", channel: "cto", taskId: null, senderId: null, dedupeKey: null, createdAt: "2026-01-01T00:00:00.000Z", supersedesMessageId: null } as const;
  const out = renderToStaticMarkup(
    <ul>
      <MessageItem m={{ ...base, senderKind: "human", body: "hello" }} now={Date.parse("2026-01-01T00:10:00.000Z")} />
      <MessageItem m={{ ...base, senderKind: "agent", body: "<script>x</script>" }} now={Date.now()} />
      <MessageItem m={{ ...base, senderKind: "system", body: "note" }} now={Date.now()} />
    </ul>,
  );
  assert.match(out, /msg-mine[\s\S]*Billy/);
  assert.match(out, /10 min ago/);
  assert.match(out, />CTO</);
  assert.match(out, />Forewright</);
  assert.doesNotMatch(out, /<script/);
});

test("slash command suggestions match the typed prefix and only a bare command word", () => {
  assert.deepEqual(suggestCommands("/").map((c) => c.name), COMMANDS.map((c) => c.name));
  assert.deepEqual(suggestCommands("/p").map((c) => c.name), ["prd", "pause"]);
  assert.deepEqual(suggestCommands("/zzz"), []);
  assert.deepEqual(suggestCommands("hello"), []);
  assert.deepEqual(suggestCommands("/approve now"), []);
});

test("the empty state explains what to do", () => {
  assert.match(renderToStaticMarkup(<EmptyState />), /Tell the CTO what you want to build/);
});

const picker = (over: Partial<PickerViewProps> = {}): PickerViewProps => ({
  recent: [],
  cwd: "",
  busy: false,
  error: null,
  offerCreate: null,
  onCwd: noop,
  onOpenRecent: noop,
  onOpenFolder: noop,
  onCreate: noop,
  ...over,
});

test("project picker: loading, empty, recent list, error and the offer to create", () => {
  assert.match(renderToStaticMarkup(<PickerView {...picker({ recent: null })} />), /Loading/);
  assert.match(renderToStaticMarkup(<PickerView {...picker()} />), /No projects yet/);
  const list = renderToStaticMarkup(<PickerView {...picker({ recent: [{ projectId: "p1", root: "/a/demo", name: "demo" }] })} />);
  assert.match(list, /recent-name">demo</);
  assert.match(list, /\/a\/demo/);
  const err = renderToStaticMarkup(<PickerView {...picker({ error: "That folder does not exist." })} />);
  assert.match(err, /role="alert"[^>]*>That folder does not exist\./);
  const offer = renderToStaticMarkup(<PickerView {...picker({ offerCreate: "/a/new" })} />);
  assert.match(offer, /Create a Forewright project here/);
});

test("the unauthorized screen tells Billy to run forewright gui again", () => {
  const out = renderToStaticMarkup(<UnauthorizedScreen />);
  assert.match(out, /forewright gui/);
  assert.match(out, /role="alert"/);
});

test("the shell: sidebar views, coming-soon panel, status badges, hint bar limits", () => {
  assert.deepEqual(VIEWS.map((v) => v.label), ["Home", "CTO", "Tasks", "Team", "Inbox", "Settings"]);
  assert.match(renderToStaticMarkup(<ComingSoon title="Tasks" text="The board." />), /Coming soon\. Use the terminal UI for this for now\./);
  for (const hints of Object.values(HINTS)) assert.ok(hints.length <= 6);
  assert.equal((renderToStaticMarkup(<HintBar hints={["a", "b", "c", "d", "e", "f", "g"]} />).match(/<span/g) ?? []).length, 6);
  const runtime = { paused: true, planOnly: true, activeRuns: [], maxConcurrentWorkers: 2, ctoBusy: true, connectedClients: 1 };
  const bar = renderToStaticMarkup(<TopBar project={{ projectId: "p", root: "/r", name: "demo" }} conn="reconnecting" runtime={runtime} theme="dark" onMenu={noop} onProject={noop} onTheme={noop} />);
  assert.match(bar, /PAUSED/);
  assert.match(bar, /PLAN ONLY/);
  assert.match(bar, /CTO is thinking/);
  assert.match(bar, /Reconnecting/);
  assert.match(bar, /demo/);
  assert.equal(connectionLabel("open"), "Connected");
});

test("relative time", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  assert.equal(relTime("2026-01-02T00:00:00.000Z", now), "just now");
  assert.equal(relTime("2026-01-01T23:30:00.000Z", now), "30 min ago");
  assert.equal(relTime("2026-01-01T20:00:00.000Z", now), "4 h ago");
  assert.equal(relTime("2025-12-30T00:00:00.000Z", now), "3 d ago");
  assert.equal(relTime("2025-01-01T00:00:00.000Z", now), "2025-01-01");
  assert.equal(relTime("nonsense", now), "");
});
