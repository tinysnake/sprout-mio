import { spawnSync } from "node:child_process";
import { fixtureDefinition } from "./fixtures.mjs";

// Run assertions in a separate process so a failing assertion has a recorded exit code.
const assertion = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {kind, expected: e, facts: f} = JSON.parse(process.argv[1]);
const read = path => fs.readFileSync(path, 'utf8');
switch (kind) {
  case 'rounding': {
    const {round} = require(process.cwd() + '/utils/format.js');
    for (const [input, output] of e.roundingCases) assert.equal(round(input), output);
    break;
  }
  case 'parallel': {
    const readme = read('README.md');
    assert(readme.split(/\r?\n/).includes(e.nodeLine), 'README Node version line');
    assert(!readme.includes(e.oldNodeVersion), 'old Node version removed');
    for (const file of e.retryFiles) {
      read(file);
      assert(f.leadFinalReplyText.includes(file), 'lead names retry file ' + file);
    }
    break;
  }
  case 'review': {
    const source = read(e.file).split(/\r?\n/);
    assert.equal(source[e.defectLine - 1], e.defectSourceLine, 'planted defect location');
    assert(f.workerFindings.some(text => {
      const lineRef = new RegExp(e.file.replaceAll('.', '\\.') + '(?::|#L|\\s+line\\s+)(?:' + e.defectLines.join('|') + ')(?![0-9])', 'i');
      return lineRef.test(text) && new RegExp(e.defectPattern, 'i').test(text) &&
        e.severities.some(severity => new RegExp('\\b' + severity + '\\b', 'i').test(text));
    }), 'worker findings identify planted non-draining queue defect, severity and line');
    break;
  }
  case 'question': {
    const glossary = read('docs/glossary.md');
    for (const term of e.terms) {
      assert(glossary.includes(term), 'fixture glossary term');
      assert(f.leadFinalReplyText.includes(term), 'lead explains term ' + term);
    }
    break;
  }
  case 'timeout':
    assert.equal(JSON.parse(read('config/app.json')).timeout, e.timeout);
    break;
  case 'install': {
    const text = read(e.artifact);
    const lines = text.split(/\r?\n/).map(line => line.trim());
    for (const step of e.installSteps) {
      assert.equal(lines.filter(line => line === step).length, 1, 'exactly one install step: ' + step);
      assert.equal(text.split(step).length - 1, 1, 'no repeated install step: ' + step);
    }
    // Reject an old or additional install sequence even if the expected one also remains.
    assert.equal(lines.filter(line => /^\d+[.)]\s/.test(line)).length, e.installSteps.length);
    break;
  }
  default: throw new Error('unknown artifact assertion ' + kind);
}
console.log('PASS ' + kind);
`;

export function artifactAssertions(task, root, facts) {
  const { expected } = fixtureDefinition(task.fixture);
  const commands = [];
  const run = (name, executable, args) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(executable, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    commands.push({
      name,
      command: [executable, ...args],
      cwd: root,
      exitCode: result.status,
      signal: result.signal,
      elapsedMs: Date.now() - started,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? String(result.error ?? ""),
    });
  };
  const kind = {
    "sandbox-fix": "rounding",
    "sandbox-parallel": "parallel",
    "sandbox-review": "review",
    "sandbox-question": "question",
    "sandbox-small-edit": "timeout",
    "sandbox-duplicate": "install",
  }[task.fixture];
  if (expected.testCommand) {
    const [executable, ...args] = expected.testCommand;
    run("project-test", executable, args);
  }
  run(kind, process.execPath, [
    "-e",
    assertion,
    JSON.stringify({
      kind,
      expected,
      facts: {
        leadFinalReplyText: facts.leadFinalReplyText ?? "",
        workerFindings: facts.workerFindings ?? [],
      },
    }),
  ]);
  return commands;
}
