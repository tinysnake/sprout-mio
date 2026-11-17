import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { sdkRoot } from "../../pi-host-skills.mjs";

const rootDefault = fileURLToPath(new URL("../../../", import.meta.url));
const sectionNames = [
  "情境",
  "职责",
  "成员选择",
  "边界与权限",
  "结果事件与等待",
  "Sprout 能力入口",
  "身份",
  "职责与边界",
  "完成上报",
  "阻塞上报",
  "结果回流",
  "能力概览",
  "工作描述",
  "项目背景",
  "HTML 交付",
  "说话风格",
];
const crewNames = new Set([...sectionNames.slice(0, 12), "事件与等待"]);
export const defaultFacts = {
  cwd: "/sprout/prompt-inventory",
  profile: { persona: "Prompt inventory agent.", description: "Prompt inventory agent." },
  projectContext: { kind: "coding" },
  situations: {
    lead: { kind: "crew_lead", crewName: "Crew prompt AB" },
    worker: { kind: "delegation_worker", delegationId: "inventory-delegation", leadName: "Lead" },
  },
};

export function sectionInventory(text, { htmlGuide } = {}) {
  const sections = sectionNames.map((name) => ({ name, chars: 0 }));
  const starts = [...text.matchAll(/^## (.+)$/gm)];
  const add = (name, chars) => {
    const found = sections.find((s) => s.name === name);
    if (found) found.chars += chars;
    else sections.push({ name, chars });
  };
  if (!starts.length) {
    if (htmlGuide && text.endsWith(htmlGuide)) {
      add("说话风格", text.length - htmlGuide.length);
      add("HTML 交付", htmlGuide.length);
    } else add("legacy", text.length);
  } else {
    if (starts[0].index) add("preamble", starts[0].index);
    starts.forEach((m, i) => add(m[1], (starts[i + 1]?.index ?? text.length) - m.index));
  }
  return {
    totalChars: text.length,
    crewChars: sections.filter((s) => crewNames.has(s.name)).reduce((n, s) => n + s.chars, 0),
    sections,
  };
}

function parameterDescriptionChars(schema) {
  if (!schema || typeof schema !== "object") return 0;
  let total = typeof schema.description === "string" ? schema.description.length : 0;
  for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"])
    for (const value of Object.values(schema[key] ?? {})) total += parameterDescriptionChars(value);
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "unevaluatedProperties",
  ])
    total += Array.isArray(schema[key])
      ? schema[key].reduce((n, s) => n + parameterDescriptionChars(s), 0)
      : parameterDescriptionChars(schema[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    for (const value of schema[key] ?? []) total += parameterDescriptionChars(value);
  return total;
}
export function toolInventory(definitions) {
  const tools = definitions
    .map((tool) => {
      const descriptionChars = (tool.description ?? "").length;
      const params = parameterDescriptionChars(tool.parameters);
      return {
        name: tool.name,
        descriptionChars,
        parameterDescriptionChars: params,
        totalChars: descriptionChars + params,
      };
    })
    .sort((a, b) => b.totalChars - a.totalChars || a.name.localeCompare(b.name));
  return { totalChars: tools.reduce((n, t) => n + t.totalChars, 0), tools };
}

async function inventoryCheckout(
  checkout,
  { root, facts = defaultFacts, agentDir = join(homedir(), ".pi", "agent") },
) {
  const require = createRequire(join(root, "package.json"));
  const ts = require("typescript");
  const sdkPath = sdkRoot(agentDir);
  const sdkRequire = createRequire(join(sdkPath, "package.json"));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
  const jiti = createJiti(pathToFileURL(join(checkout, "scripts/pi-host-runner.mjs")).href, {
    moduleCache: false,
  });
  const sdk = await import(pathToFileURL(join(sdkPath, "dist/index.js")).href);
  const { buildSystemPrompt } = await import(
    pathToFileURL(join(sdkPath, "dist/core/system-prompt.js")).href
  );
  const source = readFileSync(join(checkout, "scripts/pi-host-runner.mjs"), "utf8");
  const ast = ts.createSourceFile(
    "runner.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const loader = nodes.find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === "loaderOptions",
  )?.initializer;
  assert(loader && ts.isObjectLiteralExpression(loader), "runner loaderOptions shape changed");
  const property = (object, name) =>
    object?.properties?.find((p) => p.name?.getText(ast) === name)?.initializer;
  const prompt = property(loader, "systemPrompt");
  const factories = property(loader, "extensionFactories");
  const session = nodes.find(
    (n) => ts.isCallExpression(n) && n.expression.getText(ast) === "sdk.createAgentSession",
  );
  const allowlist = property(session?.arguments[0] ?? {}, "tools");
  assert(prompt && factories && allowlist, "runner prompt/factory/allowlist shape changed");
  const snippets = [prompt, factories, allowlist].map((n) => n.getText(ast)).join("\n");
  const context = {
    sdk,
    assistant: false,
    memoryFactory: undefined,
    webAccessEntry: null,
    line() {},
    remoteClient: {
      projectId: "inventory-project",
      request() {
        throw new Error("inventory must not request remote services");
      },
    },
  };
  for (const n of nodes) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text.endsWith("_GUIDE"))
      context[n.name.text] = runInNewContext(n.initializer.getText(ast));
    if (
      !ts.isVariableDeclaration(n) ||
      !ts.isObjectBindingPattern(n.name) ||
      !n.initializer ||
      !ts.isAwaitExpression(n.initializer)
    )
      continue;
    const call = n.initializer.expression;
    if (!ts.isCallExpression(call) || call.expression.getText(ast) !== "jiti.import") continue;
    const names = n.name.elements.map((e) => e.name.getText(ast));
    if (!names.some((name) => new RegExp(`\\b${name}\\b`).test(snippets))) continue;
    const relative = call.arguments[0].getText(ast).match(/["']([^"']+\.ts)["']/)?.[1];
    assert(relative, "cannot resolve runner TS import");
    const loaded = await jiti.import(resolve(checkout, "scripts", relative));
    for (const name of names) context[name] = loaded[name];
  }
  context.sproutExtension = (await jiti.import(join(checkout, "src/extension/main.ts"))).default;
  // No lease is part of this fixed fixture, so MCP registration must remain idle.
  const registerMcp = context.registerSproutMcp;
  context.registerSproutMcp = (pi, options) => registerMcp(pi, { ...options, piMcp: {} });
  const roles = {};
  for (const [role, situation] of Object.entries(facts.situations)) {
    Object.assign(context, {
      situation,
      projectContext: facts.projectContext,
      config: { profile: facts.profile },
    });
    const text = runInNewContext(prompt.getText(ast), context);
    const allowed = runInNewContext(allowlist.getText(ast), context);
    const registered = new Map();
    const pi = {
      registerTool(tool) {
        registered.set(tool.name, tool);
      },
      on() {},
      registerCommand() {},
      registerShortcut() {},
      registerFlag() {},
      getActiveTools() {
        return [...registered.keys()];
      },
    };
    for (const [name, factory] of [
      ["read", sdk.createReadTool],
      ["grep", sdk.createGrepTool],
      ["find", sdk.createFindTool],
      ["ls", sdk.createLsTool],
    ]) {
      assert(factory, `SDK lacks ${name} factory`);
      pi.registerTool(factory(facts.cwd));
    }
    for (const extension of runInNewContext(factories.getText(ast), context))
      await extension.factory(pi);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: facts.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: text,
    });
    await resourceLoader.reload();
    const { session: measuredSession } = await sdk.createAgentSession({
      cwd: facts.cwd,
      agentDir,
      tools: allowed,
      customTools: [...registered.values()],
      resourceLoader,
      settingsManager: sdk.SettingsManager.inMemory(),
      sessionManager: sdk.SessionManager.inMemory(facts.cwd),
    });
    let active;
    let registeredTools;
    try {
      measuredSession.setActiveToolsByName(
        measuredSession
          .getActiveToolNames()
          .filter((name) => !context.isCrewDeferredTool?.(situation, name)),
      );
      active = measuredSession.getActiveToolNames().map((name) => registered.get(name));
      registeredTools = measuredSession.getAllTools().map((tool) => registered.get(tool.name));
      assert(active.every(Boolean) && registeredTools.every(Boolean), "uncaptured SDK tool");
    } finally {
      measuredSession.dispose();
    }
    const missing = allowed.filter((name) => !name.includes("*") && !registered.has(name));
    assert.equal(missing.length, 0, `unregistered tools: ${missing.join(", ")}`);
    const systemPrompt = sectionInventory(text, { htmlGuide: context.HTML_ARTIFACT_GUIDE });
    const rendered = buildSystemPrompt({
      customPrompt: text,
      selectedTools: active.map((t) => t.name),
      cwd: facts.cwd,
      contextFiles: [],
      skills: [],
    });
    assert(rendered.startsWith(text), "SDK prompt preamble rendering changed");
    systemPrompt.applicationChars = text.length;
    systemPrompt.hostChars = rendered.length - text.length;
    systemPrompt.totalChars = rendered.length;
    systemPrompt.sections.push({ name: "Pi 宿主附加", chars: systemPrompt.hostChars });
    roles[role] = {
      systemPrompt,
      tools: toolInventory(active),
      registered: toolInventory(registeredTools),
      deferred: toolInventory(registeredTools.filter((tool) => tool.exposure === "deferred")),
    };
  }
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
    fixture: {
      facts,
      memory: "disabled",
      webAccess: "disabled",
      machineLease: null,
      sdkVersion: JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version,
    },
    measurement:
      "JS string.length (UTF-16); tools = initial SDK active set; registered and deferred reported separately; tool description plus schema description values, excluding JSON syntax; section separators belong to preceding section; host skills and prompt templates disabled",
    roles,
  };
}

export async function inventory(target = "origin/main", options = {}) {
  const root = resolve(options.root ?? rootDefault);
  if (existsSync(target) && existsSync(join(target, "scripts/pi-host-runner.mjs")))
    return {
      target: resolve(target),
      ...(await inventoryCheckout(resolve(target), { ...options, root })),
    };
  const temp = mkdtempSync(join(tmpdir(), "sprout-prompt-inventory-"));
  const checkout = join(temp, "checkout");
  let added = false;
  try {
    const git = (args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const head = git(["rev-parse", "--verify", `${target}^{commit}`]).trim();
    git(["worktree", "add", "--detach", checkout, head]);
    added = true;
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"), "dir");
    return { target, ...(await inventoryCheckout(checkout, { ...options, root })) };
  } finally {
    try {
      if (added)
        execFileSync("git", ["worktree", "remove", "--force", checkout], {
          cwd: root,
          stdio: "pipe",
        });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

export function compareInventories(arms) {
  const baseline = arms[0];
  const compression = (value, base) =>
    base === 0 ? null : Number(((1 - value / base) * 100).toFixed(6));
  return {
    baseline: baseline.arm,
    rows: ["lead", "worker"].flatMap((role) =>
      arms.map((arm) => {
        const current = arm.roles[role],
          base = baseline.roles[role];
        return {
          arm: arm.arm,
          head: arm.head,
          role,
          systemPromptChars: current.systemPrompt.totalChars,
          toolDescriptionChars: current.tools.totalChars,
          systemPromptCompressionPercent: compression(
            current.systemPrompt.totalChars,
            base.systemPrompt.totalChars,
          ),
          toolDescriptionCompressionPercent: compression(
            current.tools.totalChars,
            base.tools.totalChars,
          ),
        };
      }),
    ),
  };
}
export function renderComparison(comparison) {
  const percent = (value) => (value === null ? "n/a" : `${value.toFixed(2)}%`);
  return [
    "体量对比（字符；压缩率相对 " + comparison.baseline + "）",
    "| arm | role | system | system compression | tools incl. parameters | tools compression |",
    "|---|---|---:|---:|---:|---:|",
    ...comparison.rows.map(
      (r) =>
        `| ${r.arm} | ${r.role} | ${r.systemPromptChars} | ${percent(r.systemPromptCompressionPercent)} | ${r.toolDescriptionChars} | ${percent(r.toolDescriptionCompressionPercent)} |`,
    ),
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "origin/main";
    const result = await inventory(target);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
