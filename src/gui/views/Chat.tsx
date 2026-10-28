// The Chat view: channels and direct conversations on the left, the timeline in the middle and a thread on the right.

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Message } from "../../core/store-types.js";
import type { ChatStatus } from "../../runtime/protocol.js";
import { Markdown, renderInline } from "../markdown.js";
import { plainError } from "../Picker.js";
import { isMessageEvent, isTaskEvent, useLive, useProject } from "../live.js";
import { relTime, useInterval } from "../ui.js";
import {
  GENERAL,
  applyMention,
  budgetLine,
  channelSections,
  loopFor,
  loopText,
  mentionQuery,
  mentionSegments,
  openChat,
  parseChatFocus,
  placeKey,
  placeOf,
  presenceWord,
  repliesLabel,
  readOnlyPlace,
  sendParams,
  suggestMentions,
  wakeLine,
  wokeToast,
} from "../chat-model.js";
import type { ChannelEntry, Person, Place } from "../chat-model.js";

export { openChat };

const isChatEvent = (type: string): boolean => type.startsWith("chat.") || isMessageEvent(type);

// ---------------------------------------------------------------- presentational pieces

export function senderName(m: Pick<Message, "senderKind" | "senderId">, people: readonly Person[]): string {
  if (m.senderKind === "human") return "Billy";
  if (m.senderKind === "system") return "Forewright";
  return people.find((p) => p.agentId === m.senderId)?.name ?? "An agent";
}

/** A message body with the mentions of known people highlighted. Text and spans only, never HTML. */
export function ChatBody({ text, people }: { text: string; people: readonly Person[] }) {
  const segs = mentionSegments(text, people);
  if (!segs.some((s) => s.mention) || text.includes("```")) return <Markdown text={text} />;
  return (
    <div className="md">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {mentionSegments(para, people).map((s, j) => (s.mention ? <span key={j} className="chat-mention">{s.text}</span> : <span key={j}>{renderInline(s.text, `c${i}.${j}.`)}</span>))}
        </p>
      ))}
    </div>
  );
}

export function ChatMessage({ m, people, now, onOpenThread }: { m: Message; people: readonly Person[]; now: number; onOpenThread?: ((id: string) => void) | undefined }) {
  const mine = m.senderKind === "human";
  const replies = m.replyCount ?? 0;
  return (
    <li className={mine ? "chat-msg chat-msg-mine" : m.senderKind === "system" ? "chat-msg chat-msg-system" : "chat-msg"}>
      <div className="msg-meta">
        <span className="msg-author">{senderName(m, people)}</span>
        <time dateTime={m.createdAt} title={m.createdAt}>
          {relTime(m.createdAt, now)}
        </time>
      </div>
      <div className="msg-bubble">
        <ChatBody text={m.body} people={people} />
      </div>
      {replies > 0 && onOpenThread ? (
        <button type="button" className="btn btn-quiet chat-replies" onClick={() => onOpenThread(m.id)}>
          {repliesLabel(replies)}
        </button>
      ) : null}
    </li>
  );
}

export function ChatNav({
  channels,
  people,
  active,
  onPick,
  onPerson,
}: {
  channels: readonly ChannelEntry[];
  people: readonly Person[];
  active: Place;
  onPick: (p: Place) => void;
  onPerson: (p: Person) => void;
}) {
  const { tasks, directs } = channelSections(channels);
  const activeKey = placeKey(active);
  const item = (label: string, place: Place, key: string) => (
    <li key={key}>
      <button type="button" className={placeKey(place) === activeKey ? "chat-nav-item chat-nav-active" : "chat-nav-item"} aria-current={placeKey(place) === activeKey ? "true" : undefined} onClick={() => onPick(place)}>
        {label}
      </button>
    </li>
  );
  return (
    <nav className="chat-nav" aria-label="Channels and people">
      <h3>Channels</h3>
      <ul>
        {item("#general", GENERAL, "general")}
        {tasks.map((c) => item(c.label, placeOf(c)!, `t:${c.taskId}`))}
      </ul>
      <h3>Direct messages</h3>
      {directs.length === 0 ? (
        <p className="muted chat-nav-empty">None yet.</p>
      ) : (
        <ul>{directs.map((c) => item(c.label, placeOf(c)!, `d:${c.agentId}:${c.peerAgentId ?? ""}`))}</ul>
      )}
      <h3>People</h3>
      <ul>
        {people.map((p) => (
          <li key={p.agentId}>
            <button type="button" className="chat-nav-item chat-person" onClick={() => onPerson(p)} title={`Open a direct message with ${p.name}`}>
              <span className={`chat-presence chat-presence-${p.state}`} aria-hidden="true" />
              <span className="chat-person-name">{p.name}</span>
              <span className="muted chat-person-state">
                {presenceWord(p.state)}
                {p.detail ? `, ${p.detail}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The loop banner for a place, or nothing. */
export function LoopBanner({ status, place, people, onInbox }: { status: ChatStatus | null; place: Place; people: readonly Person[]; onInbox: () => void }) {
  const loop = status ? loopFor(status.loops, place) : null;
  if (!loop) return null;
  return (
    <div className="chat-loop" role="alert">
      <span>{loopText(loop, people)}</span>
      <button type="button" className="btn" onClick={onInbox}>
        Open the Inbox
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- composer

/** The message box: Enter sends, Shift+Enter adds a line, @ suggests agents. `info` shows under the box. */
export function Composer({
  label,
  people,
  wake,
  onSend,
  onEscape,
  footer,
  autoFocus = false,
}: {
  label: string;
  people: readonly Person[];
  /** Given the text typed so far, the line saying who it will wake. */
  wake: (text: string) => string;
  /** Resolves when the message was sent (the box is cleared); rejects with the failure. */
  onSend: (body: string) => Promise<void>;
  onEscape?: (() => void) | undefined;
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const { connected } = useProject();
  const id = useId();
  const listId = `${id}-mentions`;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const q = dismissed ? null : mentionQuery(text, caret);
  const options = q ? suggestMentions(people, q.query) : [];
  const open = options.length > 0;
  const current = open ? Math.min(active, options.length - 1) : 0;

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const pick = (p: Person) => {
    if (!q) return;
    const next = applyMention(text, q.start, caret, p.name);
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = async () => {
    const body = text.trim();
    if (body === "" || !connected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(body);
      setText("");
      setCaret(0);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(options[current]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer chat-composer">
      <p className="chat-wake" aria-live="polite">
        {wake(text)}
      </p>
      {open ? (
        <ul className="chat-mentions" role="listbox" id={listId} aria-label="People to mention">
          {options.map((p, i) => (
            <li key={p.agentId} id={`${id}-opt-${i}`} role="option" aria-selected={i === current} className={i === current ? "chat-mention-opt chat-mention-active" : "chat-mention-opt"} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <span className="chat-mention-name">{p.name}</span> <span className="muted">{p.role}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-row">
        <label htmlFor={`${id}-box`} className="sr-only">
          {label}
        </label>
        <textarea
          id={`${id}-box`}
          ref={box}
          rows={2}
          value={text}
          disabled={!connected || busy}
          placeholder={connected ? "Enter sends, Shift+Enter adds a line, @ mentions someone." : "Offline. Waiting for the service."}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${id}-opt-${current}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(false);
            setActive(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-primary" disabled={!connected || busy || text.trim() === ""} onClick={() => void send()}>
          Send
        </button>
      </div>
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------- timelines

function useStickyScroll(dep: unknown, resetKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    stuck.current = true;
  }, [resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep, resetKey]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

function Timeline({ messages, people, now, label, onOpenThread, empty }: { messages: Message[] | null; people: readonly Person[]; now: number; label: string; onOpenThread?: (id: string) => void; empty: string }) {
  const { ref, onScroll } = useStickyScroll(messages, label);
  return (
    <div className="messages chat-timeline" ref={ref} onScroll={onScroll} tabIndex={0} aria-label={label}>
      {messages === null ? (
        <p className="muted pad">Loading the conversation.</p>
      ) : messages.length === 0 ? (
        <p className="muted pad">{empty}</p>
      ) : (
        <ul className="msg-list chat-list">
          {messages.map((m) => (
            <ChatMessage key={m.id} m={m} people={people} now={now} onOpenThread={onOpenThread} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the view

type Pane = "nav" | "timeline" | "thread";

export function Chat() {
  const { rpc, projectId, notify, focus, go } = useProject();
  const [place, setPlace] = useState<Place>(GENERAL);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("timeline");
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 30_000);

  // A deep link (openChat) sets the place and thread.
  useEffect(() => {
    if (focus && focus.view === "chat") {
      const t = parseChatFocus(focus.id);
      if (t) {
        setPlace({ channel: t.channel, taskId: t.taskId ?? null, agentId: t.agentId ?? null, peerAgentId: t.peerAgentId ?? null });
        setThreadId(t.threadId ?? null);
        setPane(t.threadId ? "thread" : "timeline");
      }
    }
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = placeKey(place);
  const channels = useLive(() => rpc.call("state.channels", { projectId }), { events: isChatEvent });
  const status = useLive(() => rpc.call("state.chat", { projectId }), { events: isChatEvent });
  const tasks = useLive(() => rpc.call("state.tasks", { projectId }), { events: isTaskEvent });
  const timeline = useLive(
    async () => {
      const base = place.channel === "project" ? { channel: "project" as const } : place.channel === "task" ? { channel: "task" as const, taskId: place.taskId! } : { channel: "direct" as const, agentId: place.agentId!, ...(place.peerAgentId ? { peerAgentId: place.peerAgentId } : {}) };
      return { key, messages: (await rpc.call("state.messages", { projectId, ...base, limit: 200 })).messages };
    },
    { events: isChatEvent, deps: [key] },
  );
  const thread = useLive(
    async () => {
      if (!threadId) return { id: null as string | null, messages: [] as Message[] };
      return { id: threadId, messages: (await rpc.call("state.messages", { projectId, threadId, limit: 200 })).messages };
    },
    { events: isChatEvent, deps: [threadId] },
  );

  const people = status.data?.presence ?? [];
  const entries = channels.data?.channels ?? [];
  const assigneeId = place.channel === "task" && tasks.data ? (Object.values(tasks.data.board).flat().find((t) => t.id === place.taskId)?.assigneeAgentId ?? null) : null;
  const directLabel = place.channel === "direct" ? entries.find((c) => c.channel === "direct" && placeKey(placeOf(c) ?? GENERAL) === placeKey(place))?.label : undefined;
  const title = place.channel === "project" ? "#general" : (entries.find((c) => placeKey(placeOf(c) ?? GENERAL) === key && c.channel === place.channel)?.label ?? "Conversation");
  const messages = timeline.data && timeline.data.key === key ? timeline.data.messages : null;
  const threadMessages = thread.data && thread.data.id === threadId ? thread.data.messages : null;

  const send = (tid: string | null) => async (body: string) => {
    const r = await rpc.call("chat.send", { projectId, ...sendParams(place, body, tid) });
    const toast = wokeToast(r.woke, people);
    if (toast) notify(toast);
    timeline.reload();
    thread.reload();
    status.reload();
  };

  const wake = (inThread: boolean) => (text: string) => wakeLine({ place, text, people, assigneeId, ...(directLabel ? { directLabel } : {}), ...(inThread && threadMessages ? { thread: threadMessages } : {}) });
  const footer = (
    <>
      <LoopBanner status={status.data} place={place} people={people} onInbox={() => go("inbox")} />
      {status.data ? <p className="muted chat-budget">{budgetLine(status.data.budget)}</p> : null}
    </>
  );

  const choose = (p: Place) => {
    setPlace(p);
    setThreadId(null);
    setPane("timeline");
  };
  const closeThread = () => {
    setThreadId(null);
    setPane("timeline");
  };

  const root = threadMessages?.find((m) => m.id === threadId) ?? null;

  return (
    <div className={`chat chat-pane-${pane}${threadId ? " chat-has-thread" : ""}`}>
      <ChatNav
        channels={entries}
        people={people}
        active={place}
        onPick={choose}
        onPerson={(p) => {
          if (p.role === "cto") go("cto");
          else openChat(go, { channel: "direct", agentId: p.agentId });
        }}
      />
      <section className="chat-main" aria-label={title}>
        <header className="chat-head">
          <button type="button" className="btn btn-quiet chat-back" onClick={() => setPane("nav")}>
            Channels
          </button>
          <h2>{title}</h2>
        </header>
        {channels.error || status.error || timeline.error ? (
          <p className="form-error pad" role="alert">
            {channels.error ?? status.error ?? timeline.error}
          </p>
        ) : null}
        <Timeline
          messages={messages}
          people={people}
          now={now}
          label={`Messages in ${title}`}
          empty="No messages here yet."
          onOpenThread={(id) => {
            setThreadId(id);
            setPane("thread");
          }}
        />
        {readOnlyPlace(place) ? (
          <p className="muted pad">Agents talk to each other here. Mention them with @Name in #general or a task thread to join in.</p>
        ) : (
          <Composer label={`Message in ${title}`} people={people} wake={wake(false)} onSend={send(null)} footer={threadId ? null : footer} />
        )}
      </section>
      {threadId ? (
        <aside className="chat-thread" aria-label="Thread">
          <header className="chat-head">
            <button type="button" className="btn btn-quiet chat-back" onClick={closeThread}>
              Back
            </button>
            <h2>Thread</h2>
            <button type="button" className="btn btn-quiet chat-close" onClick={closeThread} aria-label="Close the thread">
              Close
            </button>
          </header>
          {thread.error ? (
            <p className="form-error pad" role="alert">
              {thread.error}
            </p>
          ) : null}
          <Timeline messages={threadMessages} people={people} now={now} label={root ? `Thread: ${senderName(root, people)}` : "Thread"} empty="This thread has no messages." />
          {readOnlyPlace(place) ? null : <Composer label="Reply in the thread" people={people} wake={wake(true)} onSend={send(threadId)} onEscape={closeThread} footer={footer} autoFocus />}
        </aside>
      ) : null}
    </div>
  );
}
