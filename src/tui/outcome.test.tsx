import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { VIEW, closeAll, enter, esc, hints, mount } from "./test-support.js";

afterEach(closeAll);

const asked = /T-4 .*: how did it merge\?/;

describe("the how-it-merged question", () => {
  it("is only a notice when a task is done: keys keep their normal meaning", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    assert.match(h.frame(), /T-4 finished: Write tests · press w to/);
    assert.doesNotMatch(h.frame(), asked);
    await h.send("3"); // still jumps to the Tasks view
    await h.settle(150);
    assert.match(h.frame(), /Tasks/);
    assert.doesNotMatch(h.frame(), asked);
    await esc(h); // still goes back to the sidebar, not into a prompt
    assert.equal(api.callsTo("tasks.outcome").length, 0);
  });

  it("w opens the modal; y answers 'merged as is'", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    await h.send("w");
    await h.settle(100);
    assert.match(h.frame(), asked);
    assert.match(hints(h), /y as is/);
    await h.send("y");
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    assert.deepEqual(api.callsTo("tasks.outcome").map((c) => c.params), [{ projectId: "p1", taskId: "t4" }]);
  });

  it("digits and enter record the minutes spent fixing", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    await h.send("w");
    await h.send("2");
    await h.send("5");
    assert.match(h.frame(), /fixing: 25/);
    await enter(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    assert.deepEqual(api.callsTo("tasks.outcome").map((c) => c.params), [{ projectId: "p1", taskId: "t4", fixMinutes: 25 }]);
  });

  it("Esc closes without recording, and w asks again; finished tasks queue oldest first", async () => {
    const { h, api } = await mount({ view: VIEW.home });
    api.emitEvent("task.completed", "task", "t4");
    api.emitEvent("task.completed", "task", "t2");
    await h.settle(100);
    await h.send("w");
    await h.settle(100);
    assert.match(h.frame(), asked);
    assert.match(h.frame(), /1 more waiting/);
    await esc(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), asked);
    assert.equal(api.callsTo("tasks.outcome").length, 0);
    await h.send("w");
    await h.settle(100);
    assert.match(h.frame(), asked, "still the oldest");
    await h.send("y");
    await h.settle(100);
    await h.send("w");
    await h.settle(100);
    assert.match(h.frame(), /T-2 .*: how did it merge\?/);
    await h.send("s"); // skip stores nothing
    await h.settle(100);
    assert.doesNotMatch(h.frame(), /how did it merge/);
    assert.equal(api.callsTo("tasks.outcome").length, 1);
  });

  it("w with nothing waiting says so, and does not open anything", async () => {
    const { h } = await mount({ view: VIEW.home });
    await h.send("w");
    await h.settle(100);
    assert.match(h.frame(), /No finished task is waiting/);
    assert.doesNotMatch(h.frame(), /how did it merge/);
  });

  it("w typed in a message box is just text", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    await h.send("w");
    await h.settle(50);
    assert.doesNotMatch(h.frame(), asked);
  });
});
