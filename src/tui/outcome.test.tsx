import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { VIEW, closeAll, enter, esc, mount } from "./test-support.js";

afterEach(closeAll);

const asked = /T-4 done\. Merged as is\?/;

describe("the merged-as-is prompt", () => {
  it("appears when a task is done, and y answers 'merged as is'", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    assert.match(h.frame(), asked);
    await h.send("y");
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    const calls = api.callsTo("tasks.outcome");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.params, { projectId: "p1", taskId: "t4" });
  });

  it("a number and enter record the minutes spent fixing", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    await h.send("2");
    await h.send("5");
    assert.match(h.frame(), /fixing: 25 \(enter\)/);
    await enter(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    assert.deepEqual(api.callsTo("tasks.outcome").map((c) => c.params), [{ projectId: "p1", taskId: "t4", fixMinutes: 25 }]);
  });

  it("Esc skips it and stores nothing; the next finished task is asked after", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    api.emitEvent("task.completed", "task", "t2");
    await h.settle(100);
    assert.match(h.frame(), asked);
    await esc(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    assert.match(h.frame(), /T-2 done\. Merged as is\?/);
    await esc(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), /Merged as is\?/);
    assert.equal(api.callsTo("tasks.outcome").length, 0);
  });

  it("does not take keys while a text box has focus", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    assert.match(h.frame(), asked);
    await h.send("y");
    await h.settle(50);
    assert.match(h.frame(), asked, "typing a y in the message box is not an answer");
    assert.equal(api.callsTo("tasks.outcome").length, 0);
  });
});
