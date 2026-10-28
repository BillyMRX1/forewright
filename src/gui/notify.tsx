// Desktop (browser) notifications, built on the same pure event mapping as the phone ones (core/notify-model).
// Off until Billy turns them on in Settings (that click is what asks the browser for permission), and only shown
// while this page is hidden. Clicking one focuses the window and opens the item. Titles and ids only.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { NOTIFY_MUTE_KEY, type Notification as Note, type NotifyEvent, type NotifyLink, type NotifyType, isMuted, notificationFor, parseMute } from "../core/notify-model.js";
import { useNeeds, useProject } from "./live.js";
import type { ViewId } from "./Shell.js";
import { readStore, writeStore } from "./ui.js";

export const DESKTOP_KEY = "forewright.desktopNotify";
export type Permission = NotificationPermission | "unsupported";

export const permissionState = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/** On means: Billy turned it on in this browser and the browser still allows it. */
export const desktopOn = (): boolean => readStore(DESKTOP_KEY) === "on" && permissionState() === "granted";

/** Asks the browser for permission (call it from a click only) and remembers the choice. */
export async function enableDesktop(): Promise<Permission> {
  const p = permissionState();
  if (p === "unsupported" || p === "denied") return p;
  const next = p === "granted" ? p : await Notification.requestPermission();
  if (next === "granted") writeStore(DESKTOP_KEY, "on");
  return next;
}

/** What to say when permission did not end up granted. */
export function permissionProblem(p: Permission): string | null {
  if (p === "granted") return null;
  if (p === "unsupported") return "Notifications need a secure page: localhost through the SSH tunnel works, plain http on another host does not.";
  return "The browser blocked notifications. Allow them in the site settings first.";
}

export interface DesktopContext {
  projectName: string;
  on: boolean;
  hidden: boolean;
  /** The project's muted types, or null while they are not loaded yet (nothing is shown until they are). */
  mute: readonly string[] | null;
  /** Items already announced in this page. */
  seen: Set<string>;
  lookup: Parameters<typeof notificationFor>[1];
}

/** The browser notification an event deserves right now, or null. Marks the item as announced. */
export function desktopNotice(ev: NotifyEvent, c: DesktopContext): { title: string; body: string; tag: string; link: NotifyLink; type: NotifyType } | null {
  if (!c.on || !c.hidden || c.mute === null) return null;
  const n: Note | null = notificationFor(ev, c.lookup);
  if (n === null || isMuted(c.mute, n.type)) return null;
  const tag = `${n.type}:${n.itemId}`;
  if (c.seen.has(tag)) return null;
  c.seen.add(tag);
  return { title: `Forewright: ${c.projectName}`, body: n.text, tag, link: n.link, type: n.type };
}

/** "#/inbox/dec_1" to a view and an item id. Anything else is null. */
export function parseHash(hash: string): { view: ViewId; id?: string } | null {
  const m = /^#\/(home|inbox|tasks)(?:\/([\w-]+))?$/.exec(hash);
  return m ? { view: m[1] as ViewId, ...(m[2] ? { id: m[2] } : {}) } : null;
}

/** Renders nothing: shows browser notifications for the open project and opens "#/view/id" links. */
export function DesktopNotifier(): ReactNode {
  const { rpc, projectId, name, go } = useProject();
  const needs = useNeeds();
  const snap = useRef(needs.snapshot);
  snap.current = needs.snapshot;
  const goRef = useRef(go);
  goRef.current = go;
  const mute = useRef<readonly string[] | null>(null);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    mute.current = null;
    let live = true;
    rpc.call("state.settings", { projectId }).then((d) => {
      if (live) mute.current = d.notify?.mute ?? [];
    }, () => undefined); // until it loads, nothing is shown (fail closed)
    const off = rpc.onNotification((n) => {
      if (n.method !== "event" || n.params.projectId !== projectId) return;
      const ev = n.params.event;
      if (ev.type === "setting.changed" && ev.entityId === NOTIFY_MUTE_KEY) mute.current = parseMute(ev.payload["value"]) ?? mute.current;
      const note = desktopNotice(ev, {
        projectName: name,
        on: desktopOn(),
        hidden: document.visibilityState === "hidden",
        mute: mute.current,
        seen: seen.current,
        lookup: { task: (id) => snap.current?.tasks.find((t) => t.id === id) ?? null, agentName: (id) => snap.current?.agents.find((a) => a.id === id)?.name ?? null },
      });
      if (note === null) return;
      const popup = new Notification(note.title, { body: note.body, tag: note.tag });
      popup.onclick = () => {
        window.focus();
        goRef.current(note.link.view, note.link.id);
        popup.close();
      };
    });
    return () => {
      live = false;
      off();
    };
  }, [rpc, projectId, name]);

  useEffect(() => {
    const open = () => {
      const t = parseHash(window.location.hash);
      if (t) goRef.current(t.view, t.id);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [projectId]);
  return null;
}
