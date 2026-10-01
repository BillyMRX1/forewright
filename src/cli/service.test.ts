import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { SERVICE_LABEL, bootoutArgs, bootstrapArgs, buildPlist, parsePrint, plistPath, printArgs } from "./service.js";

describe("buildPlist", () => {
  const xml = buildPlist({ label: SERVICE_LABEL, nodePath: "/opt/node/bin/node", mainPath: "/app/dist/cli/main.js", forewrightHome: "/Users/b/Library/Application Support/forewright", logPath: "/Users/b/Library/Application Support/forewright/daemon.log" });

  it("contains the label, program arguments and environment", () => {
    assert.match(xml, /<key>Label<\/key>\s*<string>local\.forewright\.daemon<\/string>/);
    assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/app\/dist\/cli\/main\.js<\/string>\s*<string>serve<\/string>/);
    assert.match(xml, /<key>FOREWRIGHT_HOME<\/key>\s*<string>\/Users\/b\/Library\/Application Support\/forewright<\/string>/);
  });

  it("starts at load and restarts only after a failed exit", () => {
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  });

  it("sends stdout and stderr to the daemon log", () => {
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>[^<]*daemon\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>[^<]*daemon\.log<\/string>/);
  });

  it("escapes XML special characters in paths", () => {
    const x = buildPlist({ label: "l", nodePath: "/a&b/<node>", mainPath: "m", forewrightHome: "h", logPath: "p" });
    assert.match(x, /\/a&amp;b\/&lt;node&gt;/);
  });
});

describe("launchctl arguments", () => {
  it("builds bootstrap, bootout and print arguments for the gui domain", () => {
    assert.deepEqual(bootstrapArgs(501, "/p.plist"), ["bootstrap", "gui/501", "/p.plist"]);
    assert.deepEqual(bootoutArgs(501, SERVICE_LABEL), ["bootout", "gui/501/local.forewright.daemon"]);
    assert.deepEqual(printArgs(501, SERVICE_LABEL), ["print", "gui/501/local.forewright.daemon"]);
  });

  it("places the plist in ~/Library/LaunchAgents", () => {
    assert.equal(plistPath(SERVICE_LABEL, "/Users/b"), path.join("/Users/b", "Library", "LaunchAgents", "local.forewright.daemon.plist"));
  });

  it("parses running state and pid from launchctl print", () => {
    assert.deepEqual(parsePrint("gui/501/local.forewright.daemon = {\n\tstate = running\n\tpid = 4242\n}"), { running: true, pid: 4242 });
    assert.deepEqual(parsePrint("\tstate = waiting\n"), { running: false, pid: null });
  });
});
