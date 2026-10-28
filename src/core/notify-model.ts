// What is worth a notification, in one pure place shared by the phone pipeline (runtime) and the browser
// notifications (GUI), so both agree. A notification carries a short title and ids only: never code, diffs,
// prompts, logs or secrets.
import { engineLabel } from "../tui/toasts.js";

export const NOTIFY_TYPES = ["decision", "prd", "task_done", "task_failed", "usage_limit"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export const NOTIFY_TYPE_LABEL: Record<NotifyType, string> = {
  decision: "Decisions that need you",
  prd: "PRD revisions waiting for approval",
  task_done: "Finished tasks",
  task_failed: "Blocked or failed tasks",
  usage_limit: "Usage limits and budget holds",
};

export const NOTIFY_MUTE_KEY = "notify.mute";
export const NOTIFY_TITLE_MAX = 90;

/** Where opening the notification goes: a GUI view and an optional item id (`go(view, id)`). */
export interface NotifyLink {
  view: "home" | "inbox" | "tasks";
  id?: string;
}

export interface Notification {
  type: NotifyType;
  /** The item the notification is about; one notification per type and item. */
  itemId: string;
  /** One line, ids included, already redacted and capped. */
  text: string;
  link: NotifyLink;
}

/** The slice of an event the mapping reads (a ForewrightEvent satisfies it). */
export interface NotifyEvent {
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
}

/** Task and agent names the caller can resolve; a miss falls back to the id. */
export interface NotifyLookup {
  task(id: string): { shortId: string; title: string } | null;
  agentName(id: string): string | null;
  /** Cleans untrusted text (the phone side passes the redacting `cleanTitle`; the browser shows the text on Billy's own screen). */
  clean?: (raw: unknown, fallback: string) => string;
}

/** Flattens to one line and caps the length (no redaction; see NotifyLookup.clean). */
export function plainTitle(raw: unknown, fallback: string, max = NOTIFY_TITLE_MAX): string {
  const flat = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (flat === "") return fallback;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The path form of a link, for text: "/inbox/dec_x". The GUI opens it from "#/inbox/dec_x". */
export const linkPath = (l: NotifyLink): string => `/${l.view}${l.id ? `/${l.id}` : ""}`;

/** The notification an event deserves, or null. Pure: the same event gives the same answer on every surface. */
export function notificationFor(ev: NotifyEvent, lk: NotifyLookup): Notification | null {
  const p = ev.payload;
  const cleanTitle = lk.clean ?? plainTitle;
  const about = (t: { shortId: string; title: string }, what: string): string => `${t.shortId} ${what}${t.title ? `: ${cleanTitle(t.title, "")}` : ""}`;
  const task = (id: string): { shortId: string; title: string } => lk.task(id) ?? { shortId: id, title: "" };
  const failed = (what: string): Notification => ({ type: "task_failed", itemId: ev.entityId, text: about(task(ev.entityId), what), link: { view: "tasks", id: ev.entityId } });
  switch (ev.type) {
    case "decision.requested": {
      const title = cleanTitle(p["title"], "a decision");
      const budget = p["kind"] === "spend" && title.startsWith("Budget reached");
      return {
        type: budget ? "usage_limit" : "decision",
        itemId: ev.entityId,
        text: budget ? `Budget hold: ${title} (${ev.entityId})` : `Decision needed: ${title} (${ev.entityId})`,
        link: { view: "inbox", id: ev.entityId },
      };
    }
    case "requirement_doc.proposed":
      return { type: "prd", itemId: ev.entityId, text: `A PRD revision waits for your approval (${ev.entityId})`, link: { view: "inbox", id: "prd" } };
    case "task.completed":
      return { type: "task_done", itemId: ev.entityId, text: about(task(ev.entityId), "is done"), link: { view: "tasks", id: ev.entityId } };
    case "task.blocked": {
      const reason = p["reason"];
      // Waiting on another task, on a decision (already announced) or on a usage limit (announced by the engine events) is not a failure.
      if (reason === "dependency" || reason === "human_input" || reason === "quota") return null;
      return failed(reason === "exhausted_recovery" ? "ran out of retries" : "is blocked");
    }
    case "task.run_failed":
      return p["exhausted"] === true ? failed("ran out of retries") : null;
    case "engine.waiting":
    case "engine.fallback": {
      const waiting = ev.type === "engine.waiting";
      const agent = typeof p["agentId"] === "string" ? p["agentId"] : ev.entityId;
      const who = p["role"] === "cto" ? "the CTO" : (lk.agentName(agent) ?? agent);
      const hit = waiting ? p["engine"] : p["from"];
      const taskId = typeof p["taskId"] === "string" ? p["taskId"] : null;
      return {
        type: "usage_limit",
        itemId: `${agent}:${waiting ? "wait" : "fallback"}`,
        text: `${engineLabel(typeof hit === "string" ? hit : "An engine")} usage limit reached; ${who} ${waiting ? "waits" : "moved to a backup engine"}`,
        link: taskId ? { view: "tasks", id: taskId } : { view: "home" },
      };
    }
    default:
      return null;
  }
}

/** Whether a project muted this type. */
export const isMuted = (mute: readonly string[], type: NotifyType): boolean => mute.includes(type);

/** The mute list as saved: only known types, each once. Null when it is not a list of known types. */
export function parseMute(value: unknown): NotifyType[] | null {
  if (!Array.isArray(value)) return null;
  const out: NotifyType[] = [];
  for (const v of value) {
    if (!(NOTIFY_TYPES as readonly unknown[]).includes(v)) return null;
    if (!out.includes(v as NotifyType)) out.push(v as NotifyType);
  }
  return out;
}
