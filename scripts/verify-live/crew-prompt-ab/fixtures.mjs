import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// This builder owns both the planted inputs and their expected outcomes.
export function fixtureDefinition(name) {
  const roundingCases = [
    [1.236, 1.24],
    [2.341, 2.34],
  ];
  const retryCounts = { "src/retry.js": 3, "config/retry.json": 5 };
  const terms = ["auto_continuation", "cerebellum_continuation"];
  const installSteps = ["1. Install Node 22.", "2. Run npm install.", "3. Run npm test."];
  const queue =
    "const queue = [];\nexports.enqueue = item => queue.push(item);\nexports.drain = handler => {\n  while (queue.length) {\n    handler(queue[0]);\n  }\n};\n";
  const definitions = {
    "sandbox-fix": {
      files: {
        "package.json": JSON.stringify({
          private: true,
          scripts: { test: "node --test test/*.test.js" },
        }),
        "utils/format.js": "exports.round = value => Math.floor(value * 100) / 100;\n",
        "test/format.test.js": `const {test}=require('node:test'); const assert=require('node:assert/strict'); const {round}=require('../utils/format'); test('rounds to nearest hundredth',()=>{${roundingCases.map(([input, expected]) => `assert.equal(round(${input}),${expected});`).join("")}});\n`,
      },
      expected: {
        roundingCases,
        testCommand: ["npm", "test"],
        delegationArtifacts: ["utils/format.js"],
      },
    },
    "sandbox-parallel": {
      files: {
        "README.md": "# Sandbox\nRequires Node 18.\n",
        "src/retry.js": `exports.retryCount = ${retryCounts["src/retry.js"]};\n`,
        "config/retry.json":
          JSON.stringify({ retryCount: retryCounts["config/retry.json"] }) + "\n",
      },
      expected: {
        nodeLine: "Requires Node 22.",
        oldNodeLine: "Requires Node 18.",
        retryFiles: Object.keys(retryCounts),
        retryCounts,
        delegationArtifacts: ["README.md", ...Object.keys(retryCounts)],
      },
    },
    "sandbox-review": {
      files: { "src/queue.js": queue },
      expected: {
        file: "src/queue.js",
        delegationArtifacts: ["src/queue.js"],
        defectLine: queue.split("\n").findIndex((line) => line.includes("handler(queue[0])")) + 1,
        defectSourceLine: queue.split("\n").find((line) => line.includes("handler(queue[0])")),
        defectLines: queue
          .split("\n")
          .flatMap((line, index) =>
            /while \(queue.length\)|handler\(queue\[0\]\)/.test(line) ? [index + 1] : [],
          ),
        severities: ["P0", "P1", "P2", "P3", "critical", "high", "medium", "low", "blocker"],
        defectPattern:
          "infinite|never.*(?:remov|shift|advanc)|(?:no|not|without|missing|doesn.t).*?(?:remov|shift|advanc)|无限|死循环|未.*(?:移除|出队|删除)|没有.*(?:移除|出队|删除)",
      },
    },
    "sandbox-question": {
      files: {
        "docs/glossary.md": `# Continuation terms\n自动接续: automatic continuation (\`${terms[0]}\`).\n小脑接续: cerebellum continuation (\`${terms[1]}\`).\n`,
      },
      expected: { terms },
    },
    "sandbox-small-edit": {
      files: { "config/app.json": '{"timeout":3000}\n' },
      expected: { timeout: 5000 },
    },
    "sandbox-duplicate": {
      files: {
        "docs/usage.md": "# Installation\n" + installSteps.join("\n") + "\n",
        "package.json": '{"private":true,"scripts":{"test":"node --test"}}\n',
        "HISTORY.md":
          "A worker already updated docs/usage.md installation instructions to Node 22, npm install, npm test. Verify before making changes.\n",
      },
      expected: { installSteps, artifact: "docs/usage.md" },
    },
  };
  assert(definitions[name], `unknown fixture ${name}`);
  return definitions[name];
}

export function machineFixtureCount(oracle) {
  return oracle === "delegate_parallel" ? 2 : 1;
}

export function scopeForWorker(scopes, workerProfileId) {
  const scope =
    scopes.length === 1 ? scopes[0] : scopes.find((s) => s.workerProfileId === workerProfileId);
  assert(scope, `no fixture machine assigned to worker profile ${workerProfileId}`);
  return scope;
}

export function seedFixture(name, root) {
  const { files } = fixtureDefinition(name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return files;
}
