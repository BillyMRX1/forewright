// The CTO conversation: messages, the message box with slash commands, the PRD card and the PRD reader.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Message, RequirementDoc } from "../../core/store-types.js";
import type { RuntimeStatus } from "../../runtime/protocol.js";
import { Markdown } from "../markdown.js";
import { plainError } from "../Picker.js";
import type { RpcClient } from "../rpc.js";
import { ConfirmDialog, Modal, relTime, useInterval } from "../ui.js";

export const COMMANDS: ReadonlyArray<{ name: string; help: string }> = [
  { name: "approve", help: "approve the PRD the CTO proposed" },
  { name: "prd", help: "read the PRD" },
  { name: "pause", help: "pause all work" },
  { name: "resume", help: "let work continue" },
  { name: "help", help: "list the commands" },
];

export function authorOf(m: Pick<Message, "senderKind">): string {
  return m.senderKind === "human" ? "Billy" : m.senderKind === "agent" ? "CTO" : "Forewright";
}

/** Commands that match what Billy has typed so far, or none when the text is not a bare command word. */
export function suggestCommands(text: string): Array<{ name: string; help: string }> {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const typed = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed));
}

export function MessageItem({ m, now }: { m: Message; now: number }) {
  const mine = m.senderKind === "human";
  return (
    <li className={mine ? "msg msg-mine" : m.senderKind === "system" ? "msg msg-system" : "msg msg-cto"}>
      <div className="msg-meta">
        <span className="msg-author">{authorOf(m)}</span>
        <time dateTime={m.createdAt} title={m.createdAt}>
          {relTime(m.createdAt, now)}
        </time>
      </div>
      <div className="msg-bubble">
        <Markdown text={m.body} />
      </div>
    </li>
  );
}

export function EmptyState() {
  return (
    <div className="empty">
      <h2>Tell the CTO what you want to build</h2>
      <p>Describe it in your own words. The CTO asks questions, then writes a PRD for you to read and approve. After that it creates the tasks and the team starts working.</p>
    </div>
  );
}

export function PrdCard({ doc, approved, onRead, onApprove }: { doc: RequirementDoc; approved: boolean; onRead: () => void; onApprove: () => void }) {
  return (
    <div className="prd-card" role="region" aria-label="PRD waiting for approval">
      <div className="prd-card-text">
        <strong>
          PRD r{doc.revision} {approved ? "approved" : "ready for you"}
        </strong>
        <span>: {doc.title}</span>
      </div>
      <div className="prd-card-actions">
        <button type="button" className="btn" onClick={onRead}>
          Read
        </button>
        {approved ? (
          <span className="chip chip-done">Approved</span>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onApprove}>
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

export function PrdReader({ doc, onClose, onApprove }: { doc: RequirementDoc; onClose: () => void; onApprove: (() => void) | null }) {
  return (
    <Modal title={`PRD r${doc.revision}: ${doc.title}`} onClose={onClose} wide>
      <p className="muted">Status: {doc.status}</p>
      <h3>Requirements</h3>
      {doc.requirements.length === 0 ? (
        <p className="muted">No requirements listed.</p>
      ) : (
        <ul className="reqs">
          {doc.requirements.map((r) => (
            <li key={r.key}>
              <code className="req-key">{r.key}</code> {r.text}
            </li>
          ))}
        </ul>
      )}
      <h3>Document</h3>
      <Markdown text={doc.body} />
      {onApprove ? (
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onApprove}>
            Approve r{doc.revision}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

type Dialog = { kind: "approve" } | { kind: "pause" } | { kind: "resume" } | { kind: "prd" } | { kind: "help" } | null;

export function Cto({
  rpc,
  projectId,
  connected,
  runtime,
  notify,
  reloadKey,
}: {
  rpc: RpcClient;
  projectId: string;
  connected: boolean;
  runtime: RuntimeStatus | null;
  notify: (text: string) => void;
  /** Changes when the connection was restored, so the view reloads. */
  reloadKey: number;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [prd, setPrd] = useState<RequirementDoc | null>(null);
  const [approvedRev, setApprovedRev] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stuck = useRef(true);
  const draftLoaded = useRef(false);
  const lastSaved = useRef("");
  const lastCount = useRef(0);

  useInterval(() => setNow(Date.now()), 30_000);

  const load = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([rpc.call("state.messages", { projectId, channel: "cto", limit: 200 }), rpc.call("state.prd", { projectId })]);
      setMessages(m.messages);
      setPrd(p.doc);
    } catch (err) {
      setHint(plainError(err));
    }
  }, [rpc, projectId]);

  // First load, and a reload after the connection came back.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Reload when a message or PRD event arrives (a short delay merges bursts).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = rpc.onNotification((n) => {
      if (n.method !== "event" || n.params.projectId !== projectId) return;
      const t = n.params.event.type;
      if (!t.startsWith("message.posted") && !t.startsWith("requirement_doc.")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [rpc, projectId, load]);

  // Restore the unsent draft once.
  useEffect(() => {
    draftLoaded.current = false;
    let live = true;
    rpc.call("drafts.get", { projectId, view: "gui.cto", key: projectId }).then(
      (r) => {
        if (!live) return;
        if (r.body) {
          setText(r.body);
          lastSaved.current = r.body;
        }
        draftLoaded.current = true;
      },
      () => {
        draftLoaded.current = true;
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);

  // Save the draft 500 ms after typing stops.
  useEffect(() => {
    if (!draftLoaded.current || text === lastSaved.current) return;
    const h = setTimeout(() => {
      lastSaved.current = text;
      rpc.call("drafts.save", { projectId, view: "gui.cto", key: projectId, body: text }).catch((err: unknown) => setHint(`Your draft was not saved: ${plainError(err)}`));
    }, 500);
    return () => clearTimeout(h);
  }, [text, rpc, projectId]);

  // Keep the newest message in view unless Billy scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!el || messages === null) return;
    if (stuck.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(false);
    } else if (messages.length > lastCount.current) setUnseen(true);
    lastCount.current = messages.length;
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (stuck.current) setUnseen(false);
  };

  const jumpToEnd = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = true;
    el.scrollTop = el.scrollHeight;
    setUnseen(false);
  };

  const proposed = prd && (prd.status === "proposed" || approvedRev === prd.revision) ? prd : null;
  const awaitingApproval = prd !== null && prd.status === "proposed" && approvedRev !== prd.revision;

  const runCommand = (name: string) => {
    setText("");
    setHint(null);
    if (name === "help") setDialog({ kind: "help" });
    else if (name === "prd") {
      if (prd) setDialog({ kind: "prd" });
      else setHint("There is no PRD yet. The CTO writes one after it has asked its questions.");
    } else if (name === "approve") {
      if (awaitingApproval) {
        setDialogError(null);
        setDialog({ kind: "approve" });
      } else setHint("No PRD is waiting for your approval.");
    } else if (name === "pause") {
      if (runtime?.paused) setHint("Work is already paused.");
      else {
        setDialogError(null);
        setDialog({ kind: "pause" });
      }
    } else if (name === "resume") {
      if (runtime && !runtime.paused) setHint("Work is not paused.");
      else {
        setDialogError(null);
        setDialog({ kind: "resume" });
      }
    }
  };

  const send = async () => {
    const body = text.trim();
    if (body === "" || !connected || busy) return;
    if (body.startsWith("/")) {
      const word = /^\/(\S*)/.exec(body)?.[1]?.toLowerCase() ?? "";
      const known = COMMANDS.find((c) => c.name === word);
      if (!known) {
        setHint(`Unknown command "/${word}". Type /help to see the commands.`);
        return;
      }
      runCommand(known.name);
      return;
    }
    setBusy(true);
    setSendError(null);
    setHint(null);
    try {
      await rpc.call("cto.send", { projectId, body });
      setText("");
      lastSaved.current = "";
      rpc.call("drafts.save", { projectId, view: "gui.cto", key: projectId, body: "" }).catch((err: unknown) => setHint(`Your draft was not cleared: ${plainError(err)}`));
      stuck.current = true;
      await load();
    } catch (err) {
      setSendError(plainError(err));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const sugg = suggestCommands(text);
    if (e.key === "Tab" && sugg.length > 0 && !e.shiftKey) {
      e.preventDefault();
      setText(`/${sugg[0]!.name}`);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const confirm = async (what: "approve" | "pause" | "resume") => {
    setBusy(true);
    setDialogError(null);
    try {
      if (what === "approve" && prd) {
        await rpc.call("prd.approve", { projectId, revision: prd.revision });
        setApprovedRev(prd.revision);
        notify(`Billy approved PRD r${prd.revision}. The CTO can create tasks now.`);
        await load();
      } else if (what === "pause") {
        await rpc.call("control.pauseAll", { projectId });
        notify("Work is paused.");
      } else if (what === "resume") {
        await rpc.call("control.resume", { projectId });
        notify("Work continues.");
      }
      setDialog(null);
    } catch (err) {
      setDialogError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  const sugg = suggestCommands(text);
  const empty = messages !== null && messages.length === 0;

  return (
    <div className="cto">
      <div className="messages-wrap">
        <div className="messages" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversation with the CTO">
          {messages === null ? (
            <p className="muted pad">Loading the conversation.</p>
          ) : empty ? (
            <EmptyState />
          ) : (
            <ul className="msg-list">
              {messages.map((m) => (
                <MessageItem key={m.id} m={m} now={now} />
              ))}
            </ul>
          )}
        </div>
        {unseen ? (
          <button type="button" className="btn btn-primary new-messages" onClick={jumpToEnd}>
            New messages
          </button>
        ) : null}
      </div>

      {proposed ? <PrdCard doc={proposed} approved={!awaitingApproval} onRead={() => setDialog({ kind: "prd" })} onApprove={() => runCommand("approve")} /> : null}

      <div className="composer">
        {sugg.length > 0 ? (
          <ul className="suggest" aria-label="Commands">
            {sugg.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  className="suggest-item"
                  onClick={() => {
                    setText(`/${c.name}`);
                    box.current?.focus();
                  }}
                >
                  <span className="mono">/{c.name}</span> <span className="muted">{c.help}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {hint ? (
          <p className="hint" role="status">
            {hint}
          </p>
        ) : null}
        {sendError ? (
          <p className="form-error" role="alert">
            {sendError}
          </p>
        ) : null}
        <div className="composer-row">
          <label htmlFor="cto-box" className="sr-only">
            Message to the CTO
          </label>
          <textarea
            id="cto-box"
            ref={box}
            rows={2}
            value={text}
            disabled={!connected}
            placeholder={connected ? "Message the CTO. Enter sends, Shift+Enter adds a line." : "Offline. Waiting for the service."}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn btn-primary" disabled={!connected || busy || text.trim() === ""} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>

      {dialog?.kind === "approve" && prd ? (
        <ConfirmDialog
          title={`Approve PRD r${prd.revision}?`}
          body={
            <p>
              You approve revision {prd.revision}: {prd.title}. After this the CTO can create tasks for its requirements.
            </p>
          }
          confirmLabel={`Approve r${prd.revision}`}
          error={dialogError}
          busy={busy}
          onConfirm={() => void confirm("approve")}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "pause" ? (
        <ConfirmDialog
          title="Pause all work?"
          body={<p>Running work stops starting new steps. Nothing is lost, and you can resume at any time.</p>}
          confirmLabel="Pause"
          error={dialogError}
          busy={busy}
          onConfirm={() => void confirm("pause")}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "resume" ? (
        <ConfirmDialog title="Resume work?" body={<p>The team continues with its tasks.</p>} confirmLabel="Resume" error={dialogError} busy={busy} onConfirm={() => void confirm("resume")} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "prd" && prd ? (
        <PrdReader
          doc={prd}
          onClose={() => setDialog(null)}
          onApprove={
            awaitingApproval
              ? () => {
                  setDialogError(null);
                  setDialog({ kind: "approve" });
                }
              : null
          }
        />
      ) : null}
      {dialog?.kind === "help" ? (
        <Modal title="Commands" onClose={() => setDialog(null)}>
          <ul className="help-list">
            {COMMANDS.map((c) => (
              <li key={c.name}>
                <code>/{c.name}</code> {c.help}
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}
