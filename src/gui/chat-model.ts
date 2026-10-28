// The pure parts of the Chat view: places, the "who will this wake" line, @mention parsing and suggestions,
// the budget and loop lines. Kept free of React so tests can run them without a browser.

import type { Message, MessageChannel } from "../core/store-types.js";
import type { ChatStatus } from "../runtime/protocol.js";

export type Person = ChatStatus["presence"][number];

/** Where the timeline is: #general, a task thread or a direct conversation. */
export interface Place {
  channel: Exclude<MessageChannel, "cto">;
  taskId?: string | null;
  agentId?: string | null;
  /** Set for a conversation between two agents, which Billy reads but does not write in. */
  peerAgentId?: string | null;
}

export interface ChatTarget extends Place {
  threadId?: string | null;
}

export interface ChannelEntry {
  channel: MessageChannel;
  taskId: string | null;
  agentId: string | null;
  peerAgentId?: string | null;
  label: string;
  lastAt: string | null;
}

export const GENERAL: Place = { channel: "project" };

export function placeKey(p: Place): string {
  return p.channel === "project" ? "project" : p.channel === "task" ? `task:${p.taskId ?? ""}` : `direct:${p.agentId ?? ""}${p.peerAgentId ? `:${p.peerAgentId}` : ""}`;
}

export function placeOf(c: ChannelEntry): Place | null {
  if (c.channel === "cto") return null;
  return { channel: c.channel, taskId: c.taskId, agentId: c.agentId, peerAgentId: c.peerAgentId ?? null };
}

/** The left column: the task threads and the direct conversations, in the order the service listed them. */
export function channelSections(channels: readonly ChannelEntry[]): { tasks: ChannelEntry[]; directs: ChannelEntry[] } {
  return { tasks: channels.filter((c) => c.channel === "task"), directs: channels.filter((c) => c.channel === "direct") };
}

// ---------------------------------------------------------------- deep link through the shared focus mechanism

/** The focus id that opens the Chat view on a place (and a thread). The focus mechanism carries one string. */
export function chatFocusId(t: ChatTarget): string {
  return JSON.stringify({ channel: t.channel, taskId: t.taskId ?? null, agentId: t.agentId ?? null, peerAgentId: t.peerAgentId ?? null, threadId: t.threadId ?? null });
}

export function parseChatFocus(id: string): ChatTarget | null {
  try {
    const v = JSON.parse(id) as Partial<Record<keyof ChatTarget, unknown>>;
    if (v.channel !== "project" && v.channel !== "task" && v.channel !== "direct") return null;
    const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
    return { channel: v.channel, taskId: str(v.taskId), agentId: str(v.agentId), peerAgentId: str(v.peerAgentId), threadId: str(v.threadId) };
  } catch {
    return null;
  }
}

/** Focus the Chat view on a place, for "open DM" in the People list or a link from another view. */
export function openChat(go: (view: "chat", focusId?: string) => void, target: ChatTarget): void {
  go("chat", chatFocusId(target));
}

// ---------------------------------------------------------------- presence

export function presenceWord(state: Person["state"]): string {
  return state === "chatting" ? "typing" : state;
}

// ---------------------------------------------------------------- mentions

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** People mentioned in the text as @Name (case-insensitive, whole word), in the order of the people list. */
export function mentionedPeople(text: string, people: readonly Person[]): Person[] {
  return people.filter((p) => new RegExp(`(^|[^\\w@])@${escapeRe(p.name)}(?![\\w-])`, "i").test(text));
}

export interface BodySegment {
  text: string;
  mention: boolean;
}

/** Splits a message body so the mentions of known people can be shown highlighted. Plain text pieces and spans only. */
export function mentionSegments(body: string, people: readonly Person[]): BodySegment[] {
  const names = people.map((p) => p.name).sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text: body, mention: false }];
  const re = new RegExp(`(^|[^\\w@])(@(?:${names.map(escapeRe).join("|")}))(?![\\w-])`, "gi");
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const start = m.index + m[1]!.length;
    if (start > last) out.push({ text: body.slice(last, start), mention: false });
    out.push({ text: m[2]!, mention: true });
    last = start + m[2]!.length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out.length > 0 ? out : [{ text: body, mention: false }];
}

/** The `@word` being typed at the caret, or null. The word must start the text or follow white space. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]! };
}

/** People whose name starts with what was typed after the @ (case-insensitive). */
export function suggestMentions(people: readonly Person[], query: string): Person[] {
  const q = query.toLowerCase();
  return people.filter((p) => p.name.toLowerCase().startsWith(q));
}

/** Replaces the `@query` at `start` with `@Name ` and returns the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

// ---------------------------------------------------------------- the lines around the composer

function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Who a message will wake, by the same rules as the service: mentions, else the CTO, the assignee or the other person. */
export function wakeLine(input: { place: Place; text: string; people: readonly Person[]; assigneeId: string | null; directLabel?: string; thread?: ReadonlyArray<Pick<Message, "senderKind" | "senderId" | "mentions">> }): string {
  const { place, text, people } = input;
  const mentioned = mentionedPeople(text, people);
  if (mentioned.length > 0) return `This wakes ${nameList(mentioned.map((p) => p.name))}.`;
  if (place.channel === "project") {
    // A reply in a #general thread goes to the agents already in it (who wrote there or were mentioned), as the service does.
    const ids = new Set((input.thread ?? []).flatMap((m) => [...(m.senderKind === "agent" && m.senderId ? [m.senderId] : []), ...m.mentions]));
    const inThread = people.filter((p) => ids.has(p.agentId));
    return inThread.length > 0 ? `This wakes ${nameList(inThread.map((p) => p.name))}.` : "This wakes the CTO.";
  }
  if (place.channel === "task") {
    const a = input.assigneeId ? people.find((p) => p.agentId === input.assigneeId) : undefined;
    return a ? `This wakes ${a.name}, who has this task.` : "Nobody has this task yet, so nobody is woken. Use @ to ask someone.";
  }
  const other = people.find((p) => p.agentId === place.agentId)?.name ?? input.directLabel ?? "the other person";
  return `This wakes ${other}.`;
}

/** The toast after a send, or null when nobody was woken. */
export function wokeToast(woke: readonly string[], people: readonly Person[]): string | null {
  const names = woke.map((id) => people.find((p) => p.agentId === id)?.name).filter((n): n is string => n !== undefined);
  if (names.length === 0) return null;
  return `Sent. ${nameList(names)} will answer.`;
}

export function budgetLine(b: ChatStatus["budget"]): string {
  if (b.limitTokens === 0) return "No daily chat limit";
  return `Chat today: ${b.usedTokens.toLocaleString("en-US")} of ${b.limitTokens.toLocaleString("en-US")} tokens`;
}

/** The open loop flag for a place, if any. A direct place matches a flag that names its agent. */
export function loopFor(loops: ChatStatus["loops"], place: Place): ChatStatus["loops"][number] | null {
  return (
    loops.find((l) => {
      if (l.channel !== place.channel) return false;
      if (place.channel === "task") return l.taskId === (place.taskId ?? null);
      if (place.channel === "direct") return place.agentId != null && l.agentIds.includes(place.agentId) && (!place.peerAgentId || l.agentIds.includes(place.peerAgentId));
      return true;
    }) ?? null
  );
}

export function loopText(loop: ChatStatus["loops"][number], people: readonly Person[]): string {
  const names = loop.agentIds.map((id) => people.find((p) => p.agentId === id)?.name ?? "An agent");
  return `${nameList(names)} ${names.length > 1 ? "were" : "was"} stopped for going back and forth. Answer in the Inbox to let them continue.`;
}

/** True for a conversation between two agents: Billy reads it, and joins in by mentioning them elsewhere. */
export function readOnlyPlace(place: Place): boolean {
  return place.channel === "direct" && !!place.peerAgentId;
}

/** Params for a send from the composer. */
export function sendParams(place: Place, body: string, threadId: string | null): { channel: Place["channel"]; taskId?: string; toAgentIds?: string[]; threadId?: string; body: string } {
  return {
    channel: place.channel,
    ...(place.channel === "task" && place.taskId ? { taskId: place.taskId } : {}),
    ...(place.channel === "direct" && place.agentId ? { toAgentIds: [place.agentId] } : {}),
    ...(threadId ? { threadId } : {}),
    body,
  };
}

export function repliesLabel(n: number): string {
  return n === 1 ? "1 reply" : `${n} replies`;
}
