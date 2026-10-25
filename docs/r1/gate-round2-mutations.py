#!/usr/bin/env python3
"""Replay D2 gate mutations on a clean checkout; keep all output in .verify/.

Run: python3 docs/r1/gate-round2-mutations.py
The only temporary source edits are the runner and the two owned fixtures/scripts.
Each case restores original bytes in finally; z3 mutations explicitly synchronize
only the snapshot script hash to isolate the target clause from R1-7.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
OUT = ROOT / ".verify" / ("d2-mutations-" + time.strftime("%Y%m%d-%H%M%S"))
OUT.mkdir(parents=True)
RUNNER = Path("scripts/pi-host-runner.mjs")
GATE = Path("scripts/verify/z3-mcp-acceptance.sh")
LIVE = Path("tests/fixtures/mcp-extension-live.ts")
INDEX = Path("docs/r1/evidence/evidence.json")
OWNED = (RUNNER, GATE, LIVE, INDEX)
ORIGINAL = {p: p.read_bytes() for p in OWNED}
DEADLINE = time.monotonic() + 1800
RESULTS = []


def status():
    return subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()


def restore():
    for path, content in ORIGINAL.items():
        path.write_bytes(content)
    assert status() == "", "mutation did not restore a clean tree"


def synchronize_hash():
    snapshot = json.loads(ORIGINAL[INDEX])
    snapshot["scriptSha256"] = hashlib.sha256(GATE.read_bytes()).hexdigest()
    INDEX.write_text(json.dumps(snapshot, indent=2) + "\n")


def run(name, script, expected_exit, target=None):
    assert time.monotonic() < DEADLINE, "mutation workflow exceeded total timeout"
    start = time.monotonic()
    with (OUT / (name + ".log")).open("w") as log:
        process = subprocess.Popen(["bash", script], stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            code = process.wait(timeout=300)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    record = dict(name=name, command="bash " + script, exit=code,
                  seconds=round(time.monotonic() - start, 3))
    if target is not None:
        dirs = sorted((ROOT / ".verify").glob("z3-mcp-acceptance-*"),
                      key=lambda p: p.stat().st_mtime_ns)
        directory = dirs[-1]
        clauses = [json.loads((directory / f"clause-{i}.json").read_text()) for i in range(1, 8)]
        record["clauses"] = [{"clause": c["clause"], "status": c["status"],
                              **({"error": c["error"]} if "error" in c else {})} for c in clauses]
        record["directory"] = str(directory.relative_to(ROOT))
        record["probes"] = json.loads((directory / "evidence.json").read_text())["executions"]
        assert clauses[target - 1]["status"] == ("PASS" if expected_exit == 0 else "FAIL"), record
        if expected_exit != 0:
            assert clauses[6]["status"] == "PASS", "R1-7 must not account for target failure"
    RESULTS.append(record)
    (OUT / "results.json").write_text(json.dumps(RESULTS, indent=2) + "\n")
    print(json.dumps(record, ensure_ascii=False), flush=True)
    assert code == expected_exit, f"{name}: expected exit {expected_exit}, got {code}"
    if script.endswith("z3-mcp-acceptance.sh") and expected_exit == 0:
        assert all(c["status"] == "PASS" for c in clauses), record


def clause4(body):
    source = ORIGINAL[GATE].decode()
    start = source.index("  // R1-4：")
    end = source.index("  // R1-5：", start)
    GATE.write_text(source[:start] + "  // R1-4：mutation under test\n  " + body + ",\n" + source[end:])
    synchronize_hash()


X3 = "scripts/verify/x3-mcp-extension-surface.sh"
Z3 = "scripts/verify/z3-mcp-acceptance.sh"
X2 = "scripts/verify/x2-mcp-extension.sh"
assert status() == "", "start from a clean committed checkout"
try:
    run("d21-1-clean", X3, 0)
    decoys = [
        ("d21-2-no-star", ""),
        ("d21-3-line-decoy", '// tools: ["mcp__*"]\n'),
        ("d21-4-block-decoy", '/* tools: ["mcp__*"] */\n'),
        ("d21-5-m11-string-decoy", 'const acceptanceDecoy = \'createAgentSession({ tools: ["mcp__*"] })\';\n'),
        ("d21-6-template-decoy", 'const acceptanceDecoy = `createAgentSession({ tools: ["mcp__*"] })`;\n'),
    ]
    for name, decoy in decoys:
        try:
            source = ORIGINAL[RUNNER].decode()
            assert source.count('"write", "mcp__*",') == 1
            source = source.replace('"write", "mcp__*",', '"write",')
            source = source.replace("  ({ session } = await sdk.createAgentSession({",
                                    "  " + decoy + "  ({ session } = await sdk.createAgentSession({")
            RUNNER.write_text(source)
            run(name, X3, 1)
        finally:
            restore()
    run("d21-7-restored", X3, 0)
    run("d22-1-clean", Z3, 0, 4)
    fields = json.loads(Path("docs/r1/evidence/clause-4.json").read_text())["assertions"]
    cases = [
        ("d22-2-empty", "()=>({})"),
        ("d22-3-correct-literals", "()=> (" + json.dumps(fields) + ")"),
        ("d22-4-m04-m05-alias", "()=>{const at=evidenceAt;return Object.fromEntries(" +
         json.dumps(list(fields)) + ".map(field=>[field,at(field,'c.image.status')]));}"),
    ]
    for name, body in cases:
        try:
            clause4(body)
            run(name, Z3, 1, 4)
        finally:
            restore()
    run("d22-5-restored", Z3, 0, 4)
    try:
        source = ORIGINAL[LIVE].decode()
        before = "const rawToolNames = connection.tools.map((tool) => tool.name).sort();"
        after = "connection.tools.forEach((tool, i) => { tool.name = `acceptance_wrong_${i}`; });\n" + before
        assert source.count(before) == 1
        LIVE.write_text(source.replace(before, after))
        run("d23-m17-wrong-names-x2", X2, 1)
        x2_dir = max((ROOT / ".verify").glob("x2-mcp-extension-*"), key=lambda p: p.stat().st_mtime_ns)
        evidence = json.loads((x2_dir / "evidence.json").read_text())
        inspection = {key: evidence[key] for key in (
            "rawToolNames", "toolNames", "toolCount", "workerDispatcherClientFrames",
            "workerDispatcherServerFrames", "toolsListMatchesExpected", "endToEndToolsList")}
        assert len(inspection["rawToolNames"]) == inspection["toolCount"] == 20
        assert all(name.startswith("acceptance_wrong_") for name in inspection["rawToolNames"])
        assert all("acceptance_wrong_" in name for name in inspection["toolNames"])
        assert inspection["workerDispatcherClientFrames"] > 0 and inspection["workerDispatcherServerFrames"] > 0
        assert inspection["toolsListMatchesExpected"] is False and inspection["endToEndToolsList"] == "failed"
        (OUT / "m17-evidence-inspection.json").write_text(json.dumps(inspection, indent=2) + "\n")
        run("d23-m17-wrong-names-z3", Z3, 1, 1)
    finally:
        restore()
    run("d23-restored-x2", X2, 0)
    try:
        source = ORIGINAL[GATE].decode()
        assert source.count("version:sdkVersion,") == 1
        GATE.write_text(source.replace("version:sdkVersion,", "version:'not-the-loaded-sdk-version',"))
        synchronize_hash()
        run("d24-m18-wrong-version", Z3, 1, 1)
    finally:
        restore()
    run("d24-restored-z3", Z3, 0, 1)
finally:
    restore()
    (OUT / "final-status.txt").write_text(status() + "\n")
    (OUT / "done").write_text("done\n")
print("DONE " + str(OUT.relative_to(ROOT)), flush=True)
