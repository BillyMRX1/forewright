import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanTitle } from "../runtime/notify.js";
import { type DesktopContext, desktopNotice, enableDesktop, parseHash, permissionProblem, permissionState, showDesktop, tauriNotification } from "./notify.js";

const g = globalThis as unknown as { Notification?: unknown };
afterEach(() => {
  delete g.Notification;
});

const lookup: DesktopContext["lookup"] = {
  task: (id) => (id === "task_1" ? { shortId: "T-3", title: "Fix the login form" } : null),
  agentName: () => null,
  clean: cleanTitle,
};
const ctx = (over: Partial<DesktopContext> = {}): DesktopContext => ({ projectName: "Shop", on: true, hidden: true, mute: [], seen: new Set(), lookup, ...over });
const decision = { type: "decision.requested", entityId: "dec_1", payload: { title: "Which database?", kind: "question", question: "const secret = 1;" } };

test("a hidden page gets one notification per item, with titles and ids only, and a click target", () => {
  const c = ctx();
  const n = desktopNotice(decision, c);
  assert.ok(n);
  assert.equal(n.title, "Forewright: Shop");
  assert.equal(n.body, "Decision needed: Which database? (dec_1)");
  assert.deepEqual(n.link, { view: "inbox", id: "dec_1" });
  assert.ok(!JSON.stringify(n).includes("const secret"));
  assert.equal(desktopNotice(decision, c), null, "the same item is announced once");
  const done = desktopNotice({ type: "task.completed", entityId: "task_1", payload: {} }, c);
  assert.deepEqual(done?.link, { view: "tasks", id: "task_1" });
  assert.equal(done?.body, "T-3 is done: Fix the login form");
});

test("nothing is shown while the page is visible, when it is switched off, or before the mute list has loaded", () => {
  assert.equal(desktopNotice(decision, ctx({ hidden: false })), null);
  assert.equal(desktopNotice(decision, ctx({ on: false })), null);
  assert.equal(desktopNotice(decision, ctx({ mute: null })), null);
});

test("a muted type is filtered, other types still show", () => {
  const c = ctx({ mute: ["decision"] });
  assert.equal(desktopNotice(decision, c), null);
  assert.equal(desktopNotice({ type: "task.completed", entityId: "task_1", payload: {} }, c)?.type, "task_done");
});

test("events that need no notification give none", () => {
  assert.equal(desktopNotice({ type: "task.blocked", entityId: "task_1", payload: { reason: "dependency" } }, ctx()), null);
  assert.equal(desktopNotice({ type: "message.posted", entityId: "m", payload: {} }, ctx()), null);
});

test("permission is asked only by enableDesktop, and a denial or missing support is never re-asked", async () => {
  assert.equal(permissionState(), "unsupported");
  assert.equal(await enableDesktop(), "unsupported");
  assert.match(permissionProblem("unsupported") ?? "", /secure page/);
  let asked = 0;
  g.Notification = { permission: "default", requestPermission: () => (asked++, Promise.resolve("granted")) };
  assert.equal(asked, 0, "nothing asks on load");
  assert.equal(await enableDesktop(), "granted");
  assert.equal(asked, 1);
  g.Notification = { permission: "denied", requestPermission: () => (asked++, Promise.resolve("granted")) };
  assert.equal(await enableDesktop(), "denied");
  assert.equal(asked, 1);
  assert.match(permissionProblem("denied") ?? "", /blocked/);
  assert.equal(permissionProblem("granted"), null);
});

test("inside the desktop app the injected Tauri API is used instead of the browser Notification", async () => {
  assert.equal(tauriNotification({}), null);
  assert.equal(tauriNotification({ __TAURI__: { notification: { sendNotification: () => undefined } } }), null, "a partial API is not used");
  const sent: Array<{ title: string; body?: string }> = [];
  let granted = false;
  const api = {
    isPermissionGranted: () => Promise.resolve(granted),
    requestPermission: () => Promise.resolve("granted"),
    sendNotification: (o: { title: string; body?: string }) => void sent.push(o),
  };
  const t = globalThis as unknown as { __TAURI__?: unknown };
  t.__TAURI__ = { notification: api };
  try {
    assert.ok(tauriNotification());
    g.Notification = { permission: "denied", requestPermission: () => assert.fail("the browser API must not be asked") };
    assert.equal(permissionState(), "default");
    assert.equal(await enableDesktop(), "granted");
    assert.equal(permissionState(), "granted");
    showDesktop({ title: "Forewright: Shop", body: "Decision needed", tag: "decision:dec_1" }, () => assert.fail("no click callback in the app"));
    assert.deepEqual(sent, [{ title: "Forewright: Shop", body: "Decision needed" }]);
  } finally {
    delete t.__TAURI__;
  }
  assert.equal(tauriNotification(), null);
});

test("deep links in the address bar", () => {
  assert.deepEqual(parseHash("#/inbox/dec_1"), { view: "inbox", id: "dec_1" });
  assert.deepEqual(parseHash("#/home"), { view: "home" });
  assert.equal(parseHash("#/settings/x"), null);
  assert.equal(parseHash("#/inbox/<script>"), null);
  assert.equal(parseHash(""), null);
});
