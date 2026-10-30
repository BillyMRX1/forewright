import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolError } from "./errors.js";
import {
  ANTHROPIC_RAW_BASE, ANTHROPIC_TREE_URL, MCP_REGISTRY, type SourceGet, type SourceResponse, allowedSourceUrl, fetchSkillFromUrl, fetchSource, normalizeSkillUrl,
  registryServer, searchSkillSources, toolFromRegistry,
} from "./skill-sources.js";

/** A fake GET: exact URL to response; anything else is a 404. Records every URL asked for. */
function fakeGet(routes: Record<string, Partial<SourceResponse>>): SourceGet & { calls: string[] } {
  const calls: string[] = [];
  const get: SourceGet = async (url) => {
    calls.push(url.toString());
    const r = routes[url.toString()];
    if (!r) return { status: 404, location: null, contentType: "text/plain", body: "not found" };
    return { status: 200, location: null, contentType: "text/plain; charset=utf-8", body: "", ...r };
  };
  return Object.assign(get, { calls });
}

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nDo it well.\n`;

test("the allow list: only https, only the listed hosts, only the anthropics/skills repository, no logins or ports", () => {
  for (const ok of [
    `${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`,
    ANTHROPIC_TREE_URL,
    `${MCP_REGISTRY}/v0/servers?search=x`,
    `${MCP_REGISTRY}/v0/servers/io.github.x%2Fy/versions/1.0.0`,
  ]) assert.equal(allowedSourceUrl(ok).protocol, "https:", ok);
  for (const bad of [
    "http://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md",
    "https://raw.githubusercontent.com/evil/skills/main/SKILL.md",
    "https://raw.githubusercontent.com/anthropics/skills-fork/main/SKILL.md",
    "https://raw.githubusercontent.com/anthropics/skills/../../evil/x/main/SKILL.md",
    "https://api.github.com/repos/evil/skills/contents",
    "https://api.github.com/user",
    "https://registry.modelcontextprotocol.io/v1/other",
    "https://registry.modelcontextprotocol.io/v0/serversX",
    "https://example.com/SKILL.md",
    "https://token:x@api.github.com/repos/anthropics/skills/contents",
    "https://raw.githubusercontent.com:8443/anthropics/skills/main/SKILL.md",
    "file:///etc/passwd",
    "not a url",
  ]) assert.throws(() => allowedSourceUrl(bad), ToolError, bad);
});

test("skill_url must be a SKILL.md in the repository; a github.com page of one becomes its raw address", () => {
  assert.equal(normalizeSkillUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md").toString(), `${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`);
  assert.throws(() => normalizeSkillUrl("https://github.com/evil/skills/blob/main/skills/pdf/SKILL.md"), ToolError);
  assert.throws(() => normalizeSkillUrl(`${ANTHROPIC_RAW_BASE}README.md`), /SKILL\.md/);
});

test("redirects are followed only to allowed addresses, at most 3 times; other content types and big bodies are refused", async () => {
  const target = `${ANTHROPIC_RAW_BASE}skills/a/SKILL.md`;
  const get = fakeGet({
    [`${ANTHROPIC_RAW_BASE}r1`]: { status: 302, location: target },
    [`${ANTHROPIC_RAW_BASE}evil`]: { status: 301, location: "https://evil.example/SKILL.md" },
    [`${ANTHROPIC_RAW_BASE}loop`]: { status: 302, location: `${ANTHROPIC_RAW_BASE}loop` },
    [target]: { body: "hello" },
    [`${ANTHROPIC_RAW_BASE}bin`]: { contentType: "application/octet-stream", body: "x" },
    [`${ANTHROPIC_RAW_BASE}big`]: { body: "x".repeat(256 * 1024 + 1) },
  });
  assert.equal((await fetchSource(get, `${ANTHROPIC_RAW_BASE}r1`)).text, "hello");
  await assert.rejects(() => fetchSource(get, `${ANTHROPIC_RAW_BASE}evil`), /evil\.example.*not a vetted skill source/);
  assert.ok(!get.calls.some((c) => c.includes("evil.example")), "the unlisted host is never contacted");
  await assert.rejects(() => fetchSource(get, `${ANTHROPIC_RAW_BASE}loop`), /redirected more than 3 times/);
  await assert.rejects(() => fetchSource(get, `${ANTHROPIC_RAW_BASE}bin`), /not text or JSON/);
  await assert.rejects(() => fetchSource(get, `${ANTHROPIC_RAW_BASE}big`), /larger than 256 KB/);
  await assert.rejects(() => fetchSource(get, `${ANTHROPIC_RAW_BASE}missing`), /does not exist/);
});

test("Anthropic search: one tree listing per hour, names and descriptions matched, at most 10 SKILL.md reads per search", async () => {
  const tree = { tree: [...Array.from({ length: 14 }, (_, i) => ({ path: `skills/s${i}/SKILL.md`, type: "blob" })), { path: "skills/pdf/SKILL.md", type: "blob" }, { path: "README.md", type: "blob" }] };
  const routes: Record<string, Partial<SourceResponse>> = { [ANTHROPIC_TREE_URL]: { contentType: "application/json", body: JSON.stringify(tree) } };
  routes[`${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`] = { body: skillMd("pdf", "Work with PDF files") };
  for (let i = 0; i < 14; i++) routes[`${ANTHROPIC_RAW_BASE}skills/s${i}/SKILL.md`] = { body: skillMd(`s${i}`, i === 9 ? "Also merges PDF documents" : "Something else") };
  const get = fakeGet(routes);
  const first = await searchSkillSources(get, { query: "pdf", source: "anthropic", nowMs: 0 });
  assert.equal(first[0]!.name, "pdf", "a folder name match comes first");
  assert.equal(first[0]!.url, `${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`);
  assert.equal(get.calls.filter((c) => c.endsWith("SKILL.md")).length, 10, "at most 10 SKILL.md files per search");
  const second = await searchSkillSources(get, { query: "pdf", source: "anthropic", nowMs: 1000 });
  assert.ok(!first.some((h) => h.name === "s9") && second.some((h) => h.name === "s9"), "the next search reads the rest and finds a description match");
  assert.equal(get.calls.filter((c) => c === ANTHROPIC_TREE_URL).length, 1, "the tree is cached");
  await searchSkillSources(get, { query: "pdf", source: "anthropic", nowMs: 2 * 60 * 60 * 1000 });
  assert.equal(get.calls.filter((c) => c === ANTHROPIC_TREE_URL).length, 2, "and listed again after an hour");
});

const registryEntry = (name: string, version: string, packages: unknown[], isLatest = true) => ({
  server: { name, description: `${name} server`, version, packages },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest, updatedAt: "2026-09-01T00:00:00Z" } },
});

test("registry: search keeps the latest entry per server; a version becomes a pinned npx or uvx tool; other packages are refused", async () => {
  const get = fakeGet({
    [`${MCP_REGISTRY}/v0/servers?search=git&limit=20`]: {
      contentType: "application/json",
      body: JSON.stringify({ servers: [registryEntry("io.github.x/git", "1.0.0", [], false), registryEntry("io.github.x/git", "1.1.0", [{ registryType: "npm", identifier: "@x/git-mcp", version: "1.1.0", transport: { type: "stdio" } }]), { junk: true }] }),
    },
    [`${MCP_REGISTRY}/v0/servers/io.github.x%2Fgit/versions/1.1.0`]: { contentType: "application/json", body: JSON.stringify(registryEntry("io.github.x/git", "1.1.0", [{ registryType: "npm", identifier: "@x/git-mcp", version: "1.1.0", transport: { type: "stdio" }, environmentVariables: [{ name: "GIT_TOKEN", isRequired: true }] }])) },
    [`${MCP_REGISTRY}/v0/servers/io.github.x%2Ffetch/versions/2025.4.7`]: { contentType: "application/json", body: JSON.stringify(registryEntry("io.github.x/fetch", "2025.4.7", [{ registryType: "pypi", identifier: "mcp-server-fetch", version: "2025.4.7" }])) },
    [`${MCP_REGISTRY}/v0/servers/io.github.x%2Fbox/versions/1.0.0`]: { contentType: "application/json", body: JSON.stringify(registryEntry("io.github.x/box", "1.0.0", [{ registryType: "oci", identifier: "x/box:latest" }])) },
  });
  const hits = await searchSkillSources(get, { query: "git", source: "mcp_registry", nowMs: 0 });
  assert.deepEqual(hits.map((h) => [h.server, h.version]), [["io.github.x/git", "1.1.0"]]);
  assert.deepEqual(hits[0]!.packages, [{ registry: "npm", identifier: "@x/git-mcp", version: "1.1.0" }]);

  const git = toolFromRegistry((await registryServer(get, "io.github.x/git", "1.1.0")).server);
  assert.deepEqual(git.tool, { name: "skill-git", registry: "npm", package: "@x/git-mcp", version: "1.1.0", command: "npx", args: ["-y", "@x/git-mcp@1.1.0"] });
  assert.deepEqual(git.requiredEnv, ["GIT_TOKEN"]);
  const fetchTool = toolFromRegistry((await registryServer(get, "io.github.x/fetch", "2025.4.7")).server).tool;
  assert.deepEqual([fetchTool.command, ...fetchTool.args], ["uvx", "mcp-server-fetch==2025.4.7"]);
  await assert.rejects(() => registryServer(get, "io.github.x/box", "1.0.0").then((r) => toolFromRegistry(r.server)), /npm or PyPI/);
  await assert.rejects(() => registryServer(get, "io.github.x/git", "9.9.9"), ToolError);
});

test("a skill from a URL is fetched and parsed by Forewright; a file that is not a SKILL.md is refused", async () => {
  const url = `${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md`;
  const get = fakeGet({ [url]: { body: skillMd("pdf", "PDF files") }, [`${ANTHROPIC_RAW_BASE}skills/bad/SKILL.md`]: { body: "just text" } });
  const s = await fetchSkillFromUrl(get, url);
  assert.equal(s.name, "pdf");
  assert.match(s.body, /Do it well/);
  await assert.rejects(() => fetchSkillFromUrl(get, `${ANTHROPIC_RAW_BASE}skills/bad/SKILL.md`), /not a usable SKILL\.md/);
});
