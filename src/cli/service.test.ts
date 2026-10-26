import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { SERVICE_LABEL, bootoutArgs, bootstrapArgs, buildPlist, buildUnit, disableArgs, enableArgs, isActiveArgs, parseActive, parsePrint, plistPath, printArgs, serviceInstall, serviceStatus, serviceUninstall, unitPath } from "./service.js";

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

describe("systemd user unit", () => {
  const unit = buildUnit({ nodePath: "/usr/bin/node", mainPath: "/opt/fw/dist/cli/main.js", forewrightHome: "/home/b/.local/share/forewright", logPath: "/home/b/.local/share/forewright/daemon.log" });

  it("runs node with the absolute main.js and restarts on failure", () => {
    assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/fw\/dist\/cli\/main\.js" serve$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^Environment="FOREWRIGHT_HOME=\/home\/b\/\.local\/share\/forewright"$/m);
    assert.match(unit, /^StandardOutput=append:\/home\/b\/\.local\/share\/forewright\/daemon\.log$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
  });

  it("escapes quotes, backslashes and % in paths", () => {
    const u = buildUnit({ nodePath: "/a b/n\"ode", mainPath: "/100%/m.js", forewrightHome: "h", logPath: "/l%g" });
    assert.match(u, /ExecStart="\/a b\/n\\"ode" "\/100%%\/m\.js" serve/);
    assert.match(u, /append:\/l%%g/);
  });

  it("lives in ~/.config/systemd/user, or under XDG_CONFIG_HOME", () => {
    assert.equal(unitPath("/home/b", {}), path.join("/home/b", ".config", "systemd", "user", "forewright.service"));
    assert.equal(unitPath("/home/b", { XDG_CONFIG_HOME: "/cfg" }), path.join("/cfg", "systemd", "user", "forewright.service"));
  });

  it("builds the systemctl --user arguments", () => {
    assert.deepEqual(enableArgs(), ["--user", "enable", "--now", "forewright.service"]);
    assert.deepEqual(disableArgs(), ["--user", "disable", "--now", "forewright.service"]);
    assert.deepEqual(isActiveArgs(), ["--user", "is-active", "forewright.service"]);
  });

  it("reads is-active output", () => {
    assert.deepEqual(parseActive("active\n"), { running: true, state: "active" });
    assert.deepEqual(parseActive("failed\n"), { running: false, state: "failed" });
    assert.deepEqual(parseActive(""), { running: false, state: "" });
  });
});

describe("Linux service commands (injected runner, no real systemctl)", () => {
  function setup(activeAnswer = "inactive") {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "fw-svc-"));
    const prevHome = process.env["FOREWRIGHT_HOME"];
    process.env["FOREWRIGHT_HOME"] = path.join(tmp, "data");
    const calls: string[] = [];
    let active = activeAnswer;
    const run = (bin: string, args: string[]) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (args.includes("is-active")) return { status: active === "active" ? 0 : 3, stdout: `${active}\n`, stderr: "" };
      if (args.includes("show")) return { status: 0, stdout: "4321\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const deps = { platform: "linux" as const, run, homedir: path.join(tmp, "home"), env: {}, nodePath: "/usr/bin/node", mainPath: "/opt/fw/main.js" };
    const done = () => {
      if (prevHome === undefined) delete process.env["FOREWRIGHT_HOME"];
      else process.env["FOREWRIGHT_HOME"] = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    };
    return { deps, calls, done, setActive: (s: string) => (active = s) };
  }

  it("install writes the unit, reloads, enables --now and mentions linger without running it", () => {
    const t = setup();
    try {
      const msg = serviceInstall(t.deps);
      const file = unitPath(t.deps.homedir, t.deps.env);
      assert.match(readFileSync(file, "utf8"), /ExecStart="\/usr\/bin\/node" "\/opt\/fw\/main\.js" serve/);
      assert.deepEqual(t.calls.filter((c) => !c.includes("is-active")), ["systemctl --user daemon-reload", "systemctl --user enable --now forewright.service"]);
      assert.match(msg, /loginctl enable-linger \$USER/);
      assert.ok(!t.calls.some((c) => c.startsWith("loginctl")));
    } finally {
      t.done();
    }
  });

  it("reinstalling over a running service restarts it", () => {
    const t = setup("active");
    try {
      serviceInstall(t.deps);
      assert.equal(t.calls.at(-1), "systemctl --user restart forewright.service");
    } finally {
      t.done();
    }
  });

  it("refuses to overwrite a unit it did not write", () => {
    const t = setup();
    try {
      const file = unitPath(t.deps.homedir, t.deps.env);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "[Service]\nExecStart=/bin/true\n");
      assert.throws(() => serviceInstall(t.deps), /not written by Forewright/);
      assert.throws(() => serviceUninstall(t.deps), /not written by Forewright/);
      assert.equal(t.calls.length, 0);
    } finally {
      t.done();
    }
  });

  it("status reports not installed, then running with its pid", () => {
    const t = setup();
    try {
      assert.equal(serviceStatus(t.deps).installed, false);
      serviceInstall(t.deps);
      t.setActive("active");
      const s = serviceStatus(t.deps);
      assert.equal(s.running, true);
      assert.equal(s.pid, 4321);
      t.setActive("failed");
      assert.match(serviceStatus(t.deps).message, /not running \(systemd says: failed\)/);
    } finally {
      t.done();
    }
  });

  it("uninstall disables the unit and removes the file", () => {
    const t = setup();
    try {
      serviceInstall(t.deps);
      t.calls.length = 0;
      t.setActive("active");
      assert.match(serviceUninstall(t.deps), /Stopped and removed/);
      assert.deepEqual(t.calls.filter((c) => !c.includes("is-active")), ["systemctl --user disable --now forewright.service", "systemctl --user daemon-reload"]);
      assert.equal(existsSync(unitPath(t.deps.homedir, t.deps.env)), false);
      assert.match(serviceUninstall(t.deps), /not installed/);
    } finally {
      t.done();
    }
  });

  it("a failing systemctl surfaces as systemctl_failed", () => {
    const t = setup();
    try {
      const deps = { ...t.deps, run: () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus" }) };
      assert.throws(() => serviceInstall(deps), (e: Error & { code?: string }) => e.code === "systemctl_failed");
    } finally {
      t.done();
    }
  });

  it("other platforms still report service_unsupported", () => {
    assert.throws(() => serviceInstall({ platform: "win32" }), (e: Error & { code?: string }) => e.code === "service_unsupported");
  });
});
