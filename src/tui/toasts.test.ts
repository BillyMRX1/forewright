import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TOAST_MS, MAX_TOASTS, currentToast, enqueueToast, removeToast, type Toast, type ToastKind } from "./toasts.js";

const t = (id: number, kind: ToastKind): Toast => ({ id, kind, text: `t${id}`, target: null });

describe("toast policy", () => {
  it("lifetimes: needs-you 8 s, finished 5 s, others 4 s", () => {
    assert.equal(DEFAULT_TOAST_MS.needs_you, 8000);
    assert.equal(DEFAULT_TOAST_MS.finished, 5000);
    assert.equal(DEFAULT_TOAST_MS.error, 4000);
    assert.equal(DEFAULT_TOAST_MS.info, 4000);
  });

  it("shows needs-you over error over finished over info, oldest first within a kind", () => {
    let q: Toast[] = [];
    for (const x of [t(1, "info"), t(2, "finished"), t(3, "error"), t(4, "needs_you"), t(5, "needs_you")]) q = enqueueToast(q, x);
    assert.equal(currentToast(q)?.id, 4);
    q = removeToast(q, 4);
    assert.equal(currentToast(q)?.id, 5);
    q = removeToast(q, 5);
    assert.equal(currentToast(q)?.id, 3);
    q = removeToast(q, 3);
    assert.equal(currentToast(q)?.id, 2);
    assert.equal(currentToast([]), null);
  });

  it("keeps at most 8, dropping the oldest lowest-priority toast", () => {
    let q: Toast[] = [];
    q = enqueueToast(q, t(0, "needs_you"));
    for (let i = 1; i <= 12; i++) q = enqueueToast(q, t(i, "info"));
    assert.equal(q.length, MAX_TOASTS);
    assert.ok(q.some((x) => x.id === 0), "the needs-you toast must survive");
    assert.deepEqual(q.map((x) => x.id), [0, 6, 7, 8, 9, 10, 11, 12]);
  });
});
