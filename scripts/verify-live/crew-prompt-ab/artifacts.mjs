import { spawnSync } from "node:child_process";
import { fixtureDefinition } from "./fixtures.mjs";
import { inspectTaskset2Artifacts } from "./taskset2-fixtures.mjs";

export function retryCountReported(text, file, value, corrected = true) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!corrected) return new RegExp(escaped + "[^\\n0-9]*" + value + "(?![0-9])").test(text);
  const line =
    "(?::\\d+(?![0-9])|#L\\d+(?![0-9])|\\s+line\\s+\\d+(?![0-9])|(?!(?::\\d|#L\\d|\\s+line\\s+\\d)))";
  return new RegExp(
    "(?:^|[^\\w/.-])" + escaped + line + "[^\\n0-9;]*" + value + "(?![0-9])",
    "i",
  ).test(text);
}

export function parallelReportSignals(text) {
  const { expected } = fixtureDefinition("sandbox-parallel");
  return {
    leadNamesNodeLine: text.includes(expected.nodeLine),
    retryFiles: expected.retryFiles.map((file) => ({
      file,
      leadNamesFile: text.includes(file),
      leadNamesRetryCount: retryCountReported(text, file, expected.retryCounts[file]),
    })),
  };
}

// Run assertions in a separate process so a failing assertion has a recorded exit code.
const assertion =
  retryCountReported.toString() +
  "\n" +
  String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {kind, expected: e, facts: f, initialFiles, parallelRoots} = JSON.parse(process.argv[1]);
const read = path => fs.readFileSync(path, 'utf8');
switch (kind) {
  case 'rounding': {
    const {round} = require(process.cwd() + '/utils/format.js');
    for (const [input, output] of e.roundingCases) assert.equal(round(input), output);
    break;
  }
  case 'parallel': {
    assert.equal(parallelRoots.length, 2, 'two independent clone roots');
    assert.equal(new Set(parallelRoots.map(root => fs.realpathSync(root))).size, 2,
      'two independent clone roots');
    const path = require('node:path');
    const clones = parallelRoots.map(root => {
      const contents = Object.fromEntries(Object.keys(initialFiles).map(file =>
        [file, read(path.join(root, file))]));
      const lines = contents['README.md'].split(/\r?\n/);
      return {
        contents,
        node: lines.includes(e.nodeLine) && !lines.includes(e.oldNodeLine),
        retry: {
          'src/retry.js': require(path.join(root, 'src/retry.js')).retryCount,
          'config/retry.json': JSON.parse(contents['config/retry.json']).retryCount,
        },
      };
    });
    assert(clones.some(clone => clone.node), 'README Node version line; old line removed');
    for (const file of e.retryFiles) {
      assert(clones.some(clone => clone.retry[file] === e.retryCounts[file]),
        'retry count ' + file + ' = ' + e.retryCounts[file]);
    }
    for (const clone of clones) {
      assert(Object.keys(initialFiles).some(file =>
        clone.contents[file] !== initialFiles[file] &&
        (file === 'README.md' ? clone.node : clone.retry[file] === e.retryCounts[file])),
        'each clone has a changed expected artifact');
    }
    break;
  }
  case 'review': {
    const source = read(e.file).split(/\r?\n/);
    assert.equal(source[e.defectLine - 1], e.defectSourceLine, 'planted defect location');
    assert(f.workerFindings.some(text => {
      const suffix = '(?::|#L|\\s+line\\s+)(?:' + e.defectLines.join('|') + ')(?![0-9])';
      const path = e.file.replaceAll('.', '\\.');
      const lineRef = new RegExp('(?:^|[^\\w/.-])' + path + suffix, 'i');
      const scopedFile = new RegExp('(?:^|[^\\w/.-])' + path + '(?![\\w/-]|\\.[\\w])', 'i');
      const basenameRef = new RegExp('(?:^|[^\\w/.-])' + e.file.split('/').at(-1).replaceAll('.', '\\.') + suffix, 'i');
      const detachedLine = new RegExp('(?:^|[^\\w/.:#-])(?:L|lines?\\s+)(?:' + e.defectLines.join('|') + ')(?![0-9])', 'i');
      const identifiesLine = lineRef.test(text) ||
        (scopedFile.test(text) && (basenameRef.test(text) || detachedLine.test(text)));
      return identifiesLine && new RegExp(e.defectPattern, 'i').test(text) &&
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

export function artifactAssertions(task, root, facts, { corrected = true } = {}) {
  const taskset2 = inspectTaskset2Artifacts(
    task,
    facts.machineScopes?.length ? facts.machineScopes : [{ worktree: root }],
  );
  if (taskset2) return taskset2;
  const { files: initialFiles, expected } = fixtureDefinition(task.fixture);
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
  if (task.fixture === "sandbox-routing") return commands;
  run(kind, process.execPath, [
    "-e",
    assertion,
    JSON.stringify({
      kind,
      corrected,
      expected,
      initialFiles,
      parallelRoots: (facts.machineScopes ?? []).map((scope) => scope.worktree),
      facts: {
        leadFinalReplyText: facts.leadFinalReplyText ?? "",
        workerFindings: facts.workerFindings ?? [],
      },
    }),
  ]);
  return commands;
}
