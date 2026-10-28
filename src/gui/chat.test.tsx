import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyMention,
  budgetLine,
  chatFocusId,
  loopFor,
  loopText,
  mentionQuery,
  mentionSegments,
  mentionedPeople,
  openChat,
  parseChatFocus,
  placeKey,
  readOnlyPlace,
  sendParams,
  suggestMentions,
  wakeLine,
  wokeToast,
} from "./chat-model.js";
import type { Place } from "./chat-model.js";
import { chatFixture } from "./fixtures.js";
import { ProjectContext } from "./live.js";
import type { ProjectContextValue } from "./live.js";
import { ChatBody, ChatMessage, ChatNav, Composer, LoopBanner } from "./views/Chat.js";
import { FakeClient } from "../tui/fake-client.js";

const { people, channels, status, message } = chatFixture();
const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const general: Place = { channel: "project" };
const task: Place = { channel: "task", taskId: "t2" };
const dm: Place = { channel: "direct", agentId: "a2" };

test("the channel list shows #general, the task thread and the direct messages, and the people with their presence words", () => {
  const html = renderToStaticMarkup(<ChatNav channels={channels} people={people} active={general} onPick={() => undefined} onPerson={() => undefined} />);
  assert.match(html, />#general</);
  assert.match(html, />T-2 Add the list view</);
  assert.match(html, />Ada and Bo</);
  assert.match(html, /aria-current="true"[^>]*>#general/);
  for (const word of ["working", "typing", "blocked", "waiting", "idle"]) assert.ok(html.includes(`>${word}`), word);
  assert.match(html, /working, T-2/);
  assert.match(html, /waiting, asked Bo/);
  assert.ok(!html.includes(">chatting"), "chatting is shown as typing");
});

test("a message with replies shows a replies button, one without does not", () => {
  const withReplies = renderToStaticMarkup(<ul><ChatMessage m={message("m1", "hello", { replyCount: 2 })} people={people} now={NOW} onOpenThread={() => undefined} /></ul>);
  assert.match(withReplies, /2 replies/);
  assert.match(renderToStaticMarkup(<ul><ChatMessage m={message("m1", "hello", { replyCount: 1 })} people={people} now={NOW} onOpenThread={() => undefined} /></ul>), />1 reply</);
  const none = renderToStaticMarkup(<ul><ChatMessage m={message("m2", "hello", { replyCount: 0 })} people={people} now={NOW} onOpenThread={() => undefined} /></ul>);
  assert.ok(!none.includes("repl"));
  assert.match(none, /Ada/);
});

test("mentions of known people are highlighted as text in a span, and other text stays escaped", () => {
  const html = renderToStaticMarkup(<ChatBody text={"Hi @ada and @nobody <b>x</b>"} people={people} />);
  assert.match(html, /<span class="chat-mention">@ada<\/span>/);
  assert.ok(!html.includes("chat-mention\">@nobody"));
  assert.ok(!html.includes("<b>"));
  assert.deepEqual(
    mentionSegments("ask @Bo, then @Ada", people).map((s) => [s.text, s.mention]),
    [["ask ", false], ["@Bo", true], [", then ", false], ["@Ada", true]],
  );
  assert.deepEqual(mentionedPeople("mail a@Ada.com", people), [], "an @ inside a word is not a mention");
});

test("the wake line follows the service rules", () => {
  const base = { people, assigneeId: "a1" };
  assert.equal(wakeLine({ ...base, place: general, text: "hello" }), "This wakes the CTO.");
  assert.equal(wakeLine({ ...base, place: general, text: "@Ada can you look?" }), "This wakes Ada.");
  assert.equal(wakeLine({ ...base, place: general, text: "@ada and @bo" }), "This wakes Ada and Bo.");
  assert.equal(wakeLine({ ...base, place: task, text: "status?" }), "This wakes Ada, who has this task.");
  assert.match(wakeLine({ people, assigneeId: null, place: task, text: "status?" }), /Nobody has this task yet/);
  assert.equal(wakeLine({ ...base, place: task, text: "@Cy please test" }), "This wakes Cy.");
  assert.equal(wakeLine({ ...base, place: dm, text: "hi" }), "This wakes Bo.");
});

test("the woke toast names who will answer, and is null when nobody was woken", () => {
  assert.equal(wokeToast(["a1"], people), "Sent. Ada will answer.");
  assert.equal(wokeToast(["a1", "a2", "a3"], people), "Sent. Ada, Bo and Cy will answer.");
  assert.equal(wokeToast([], people), null);
});

test("the budget line shows tokens used and left, or that there is no limit", () => {
  assert.equal(budgetLine({ usedTokens: 12400, limitTokens: 200000 }), "Chat today: 12,400 of 200,000 tokens");
  assert.equal(budgetLine({ usedTokens: 5, limitTokens: 0 }), "No daily chat limit");
});

test("the loop banner shows only for the flagged place", () => {
  const show = (place: Place) => renderToStaticMarkup(<LoopBanner status={status} place={place} people={people} onInbox={() => undefined} />);
  const html = show({ channel: "direct", agentId: "a1" });
  assert.match(html, /Ada and Bo were stopped for going back and forth\. Answer in the Inbox to let them continue\./);
  assert.match(html, /Open the Inbox/);
  assert.equal(show(general), "");
  assert.equal(show(task), "");
  assert.equal(show({ channel: "direct", agentId: "a3" }), "");
  assert.equal(loopFor(status.loops, { channel: "direct", agentId: "a2" })?.decisionId, "d1");
  assert.match(loopText(status.loops[0]!, people), /^Ada and Bo were stopped/);
});

test("the mention list filters by prefix, case-insensitively", () => {
  assert.deepEqual(suggestMentions(people, "").map((p) => p.name), ["CTO", "Ada", "Bo", "Cy", "Di"]);
  assert.deepEqual(suggestMentions(people, "a").map((p) => p.name), ["Ada"]);
  assert.deepEqual(suggestMentions(people, "C").map((p) => p.name), ["CTO", "Cy"]);
  assert.deepEqual(suggestMentions(people, "zz"), []);
});

test("the @ query is found at the caret only when the @ starts a word", () => {
  assert.deepEqual(mentionQuery("hi @A", 5), { start: 3, query: "A" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.equal(mentionQuery("mail me@A", 9), null);
  assert.equal(mentionQuery("hi @Ada and", 11), null);
  assert.deepEqual(applyMention("hi @A there", 3, 5, "Ada"), { text: "hi @Ada  there", caret: 8 });
});

test("send params carry the thread, the task or the recipient of the place", () => {
  assert.deepEqual(sendParams(general, "x", null), { channel: "project", body: "x" });
  assert.deepEqual(sendParams(task, "x", "m1"), { channel: "task", taskId: "t2", threadId: "m1", body: "x" });
  assert.deepEqual(sendParams(dm, "x", null), { channel: "direct", toAgentIds: ["a2"], body: "x" });
});

test("the deep link helper round trips a place and a thread through the focus id", () => {
  const id = chatFocusId({ channel: "task", taskId: "t2", threadId: "m9" });
  assert.deepEqual(parseChatFocus(id), { channel: "task", taskId: "t2", agentId: null, peerAgentId: null, threadId: "m9" });
  assert.equal(parseChatFocus("not json"), null);
  assert.equal(parseChatFocus('{"channel":"cto"}'), null);
  const calls: Array<[string, string | undefined]> = [];
  openChat((v, f) => calls.push([v, f]), { channel: "direct", agentId: "a1" });
  assert.equal(calls[0]![0], "chat");
  assert.equal(parseChatFocus(calls[0]![1]!)?.agentId, "a1");
});

test("the composer renders a labelled box with the wake line, and the mention list stays closed until an @ is typed", () => {
  const value = { connected: true, rpc: new FakeClient() } as unknown as ProjectContextValue;
  const html = renderToStaticMarkup(
    createElement(ProjectContext.Provider, { value }, <Composer label="Message in #general" people={people} wake={(t) => wakeLine({ place: general, text: t, people, assigneeId: null })} onSend={async () => undefined} />),
  );
  assert.match(html, /Message in #general/);
  assert.match(html, /This wakes the CTO\./);
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!html.includes('role="listbox"'));
});

test("a conversation between two agents is its own place, read only for Billy, and its loop flag needs both agents", () => {
  const pair = { channel: "direct" as const, agentId: "a1", peerAgentId: "a2" };
  const billy = { channel: "direct" as const, agentId: "a1" };
  assert.notEqual(placeKey(pair), placeKey(billy));
  assert.ok(readOnlyPlace(pair));
  assert.ok(!readOnlyPlace(billy));
  assert.deepEqual(parseChatFocus(chatFocusId(pair)), { ...pair, taskId: null, threadId: null });
  const loop = { channel: "direct" as const, taskId: null, agentIds: ["a1", "a3"], decisionId: "d1", since: "2026-01-01T00:00:00.000Z" };
  assert.equal(loopFor([loop], pair), null);
  assert.ok(loopFor([{ ...loop, agentIds: ["a2", "a1"] }], pair));
});

test("a reply in a #general thread wakes the agents already in the thread, else the CTO", () => {
  const people = chatFixture().status.presence;
  const ada = people.find((p) => p.name === "Ada")!;
  const thread = [{ senderKind: "human" as const, senderId: null, mentions: [ada.agentId] }];
  assert.equal(wakeLine({ place: { channel: "project" }, text: "thanks", people, assigneeId: null, thread }), "This wakes Ada.");
  assert.equal(wakeLine({ place: { channel: "project" }, text: "thanks", people, assigneeId: null, thread: [] }), "This wakes the CTO.");
});
