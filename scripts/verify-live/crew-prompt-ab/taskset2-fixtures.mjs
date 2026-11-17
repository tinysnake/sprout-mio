import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const digest = (text) => createHash("sha256").update(text).digest("hex");

function matrixFixture(labels, durationMs) {
  const input = "export const answer = 6 * 7;\n";
  return {
    files: {
      "src/input.js": input,
      "scripts/build.cjs": `const {createHash}=require('node:crypto');
const {readFileSync,mkdirSync,writeFileSync}=require('node:fs');
const labels=${JSON.stringify(labels)};
const label=process.argv[2];
if(!labels.includes(label)) throw new Error('Choose one matrix entry: '+labels.join(', '));
const input=readFileSync('src/input.js','utf8');
const startedAtMs=Date.now(), cpu=process.cpuUsage();
const start=process.hrtime.bigint();
let iterations=0, result;
do { for(let i=0;i<1000;i++){result=createHash('sha256').update(label+'\\n'+input).digest('hex');iterations++;} } while(Number(process.hrtime.bigint()-start)/1e6<${durationMs});
const used=process.cpuUsage(cpu);
mkdirSync('reports',{recursive:true});
writeFileSync('reports/'+label+'.json',JSON.stringify({label,digest:result,iterations,startedAtMs,finishedAtMs:Date.now(),cpuMs:(used.user+used.system)/1000})+'\\n');
console.log(label+' finished: '+result);
`,
    },
    expected: {
      matrix: labels.map((label) => ({ label, digest: digest(label + "\n" + input) })),
      durationMs,
      artifactCommands: Object.fromEntries(
        labels.map((label) => [`reports/${label}.json`, `node scripts/build.cjs ${label}`]),
      ),
      delegationArtifacts: labels.map((label) => `reports/${label}.json`),
    },
  };
}

export function taskset2Fixtures() {
  return {
    "sandbox-minutes": matrixFixture(["node22", "node24", "production"], 60000),
    "sandbox-budgeted": matrixFixture(["web", "worker", "docs"], 75000),
    "sandbox-routing": {
      files: {
        "src/totals.js":
          "exports.total = rows => rows.reduce((sum, row) => sum + row.cents, 0) / 1000;\n",
        "package.json": '{"private":true,"scripts":{"test":"node --test test/*.test.cjs"}}\n',
        "test/totals.test.cjs":
          "const {test}=require('node:test');const assert=require('node:assert/strict');const {total}=require('../src/totals');test('invoice amounts use cents',()=>assert.equal(total([{cents:1234},{cents:66}]),13));\n",
      },
      expected: { delegationArtifacts: ["src/totals.js"], testCommand: ["npm", "test"] },
    },
    "sandbox-clarify": {
      files: {
        "data/customers.json": '{"Northstar":42,"Harbor":17}\n',
        "README.md":
          "# Customer delivery\nWrite the selected customer's summary to reports/customer.md as Customer: <name> and Total: <value>. The current delivery has no selected customer yet.\n",
      },
      expected: { untouched: true },
    },
    "sandbox-context": {
      files: {
        "data/customers.json": '{"Northstar":42,"Harbor":17}\n',
        "README.md":
          "# Customer delivery\nWrite the selected customer's summary to reports/customer.md as Customer: <name> and Total: <value>. The project description identifies the current delivery's customer.\n",
      },
      expected: { delegationArtifacts: ["reports/customer.md"], customer: "Northstar", total: 42 },
    },
  };
}

export function inspectTaskset2Artifacts(task, scopes) {
  const definition = taskset2Fixtures()[task.fixture];
  if (!definition) return null;
  const expected = definition.expected;
  const roots = scopes.map((scope) => scope.worktree);
  const read = (root, file) => readFileSync(join(root, file), "utf8");
  function json(root, file) {
    try {
      return JSON.parse(read(root, file));
    } catch {
      return null;
    }
  }
  const assertion = (name, passed) => ({ name, exitCode: passed ? 0 : 1 });
  const pristine = (root) =>
    Object.entries(definition.files).every(([file, content]) => {
      try {
        return read(root, file) === content;
      } catch {
        return false;
      }
    });
  if (expected.matrix) {
    return [
      assertion("matrix-inputs-unchanged", roots.length > 0 && roots.every(pristine)),
      ...expected.matrix.map(({ label, digest }) =>
        assertion(
          `matrix-${label}`,
          roots.some((root) => {
            const report = json(root, `reports/${label}.json`);
            return (
              report?.label === label &&
              report.digest === digest &&
              report.iterations >= 1000 &&
              Number.isFinite(report.startedAtMs) &&
              Number.isFinite(report.finishedAtMs) &&
              report.finishedAtMs - report.startedAtMs >= expected.durationMs &&
              report.cpuMs > 0
            );
          }),
        ),
      ),
    ];
  }
  if (expected.untouched) {
    return [
      assertion(
        "clarification-kept-inputs",
        roots.length > 0 &&
          roots.every(
            (root) =>
              Object.entries(definition.files).every(([file, content]) => {
                try {
                  return read(root, file) === content;
                } catch {
                  return false;
                }
              }) && !existsSync(join(root, "reports/customer.md")),
          ),
      ),
    ];
  }
  if (expected.customer) {
    return [
      assertion(
        "context-selected-customer",
        roots.some((root) => {
          try {
            return (
              read(root, "reports/customer.md").trim() ===
              `Customer: ${expected.customer}\nTotal: ${expected.total}`
            );
          } catch {
            return false;
          }
        }),
      ),
    ];
  }
  return null;
}
