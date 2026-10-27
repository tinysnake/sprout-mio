#!/usr/bin/env python3
"""Mutation driver for the R1-4 evidence-production repair.

Every case runs the real gate inside an isolated copy of the repository, so a mutated probe,
fixture or harness never touches the working tree. Each mutation makes the probe exit **0**
while the observation it captured is not the one its own (weakened) check would have rejected:
that is the attack — "the comparison is gone but the probe still reports success" — and the
gate must answer FAIL, not PASS and not INCONCLUSIVE.

The driver also proves the gate never publishes what it compared: for each case, the raw
observations that run captured must not appear in the gate's stdout, run log, clause records
or published evidence.

Usage:
  python3 scripts/verify/z3-mcp-acceptance-mutations.py            # all cases
  python3 scripts/verify/z3-mcp-acceptance-mutations.py --list
  python3 scripts/verify/z3-mcp-acceptance-mutations.py --only clean --only x3-evidence-removed-after-success
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = Path("scripts/verify/z3-mcp-acceptance.sh")
X3_SCRIPT = Path("scripts/verify/x3-mcp-extension-surface.sh")
Y2_SCRIPT = Path("scripts/verify/y2-mcp-http-worker.sh")
FIXTURE = Path("tests/fixtures/mcp-extension-surface.ts")
X2_FIXTURE = Path("tests/fixtures/mcp-extension-live.ts")
Y2_FIXTURE = Path("tests/fixtures/mcp-http-worker-live.ts")
INSTALL_TIMEOUT_SECONDS = 300
CLONE_TIMEOUT_SECONDS = 120
# The gate's own probe cap is 300 s; give the whole gate room and fail loudly if it hangs.
CASE_TIMEOUT_SECONDS = 420

STATUS_RE = re.compile(r"^(PASS|FAIL|INCONCLUSIVE) R1-(\d) ", re.M)
# The artifact the probe writes for the gate only. It is the one file allowed to hold raw values.
PRIVATE_ARTIFACT = "x3-observations.json"
LONG_BASE64_RE = re.compile(r"[A-Za-z0-9+/]{400,}={0,2}")


class DriverError(RuntimeError):
    pass


class Mutation:
    """One attack: a probe edit plus the reason it should now be rejected."""

    def __init__(self, name: str, target: Path, why: str, apply, expected_clause: int = 4) -> None:
        self.name = name
        self.target = target
        self.why = why
        self.apply = apply
        self.expected_clause = expected_clause


def run(args: list[str], cwd: Path, *, timeout: int):
    return subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def mutate(path: Path, old: str, new: str) -> None:
    content = path.read_text()
    occurrences = content.count(old)
    if occurrences != 1:
        raise DriverError(f"mutation anchor matched {occurrences} times in {path}: {old[:70]!r}")
    path.write_text(content.replace(old, new))


# ---------------------------------------------------------------- the mutations

def weaken_image_comparison(fixture: Path) -> None:
    """The probe stops comparing bytes. The witness it captures is still published verbatim."""
    mutate(
        fixture,
        "const imageBase64MatchesServer = imageBlock.data === directImage.data;",
        "const imageBase64MatchesServer = imageBlock.data.length === directImage.data.length;",
    )


def weaken_structured_comparison(fixture: Path) -> None:
    """The probe stops deep-comparing structuredContent."""
    mutate(
        fixture,
        "const structuredContentMatchesServer = isDeepStrictEqual(\n"
        "  structuredResult.details.structuredContent,\n"
        "  directStructured.structuredContent,\n"
        ");",
        "const structuredContentMatchesServer =\n"
        "  typeof structuredResult.details.structuredContent === \"object\" &&\n"
        "  typeof directStructured.structuredContent === \"object\";",
    )


def corrupt_server_image(fixture: Path) -> None:
    """The server-side observation loses its last bytes: a re-encode/truncation, same length class."""
    mutate(
        fixture,
        "  serverImageBase64: directImage.data,",
        '  serverImageBase64: directImage.data.slice(0, directImage.data.length - 4),',
    )


def corrupt_server_structured(fixture: Path) -> None:
    """The server-side report differs in a value, not a key: a shallow check would miss it."""
    mutate(
        fixture,
        "  serverStructuredContent: directStructured.structuredContent,",
        "  serverStructuredContent: { ...(directStructured.structuredContent as Record<string, unknown>), humidity: 7 },",
    )


def replace_image_with_non_png(fixture: Path) -> None:
    """The Pi-side observation is no longer a PNG at all — a JSON text block dressed as an image."""
    mutate(
        fixture,
        "  piImageBase64: imageBlock.data,",
        '  piImageBase64: Buffer.from("this is not a png, only its base64 shape survives", "utf8").toString("base64").repeat(8),',
    )


def drop_observation_write(fixture: Path) -> None:
    """The probe claims observations in its evidence but never writes them."""
    remove_observation_write(fixture)


def remove_observation_write(fixture: Path) -> None:
    mutate(fixture, "writeFileSync(observationPath, serialized, { mode: 0o600 });", "")


def redirect_observation_path(x3: Path) -> None:
    """The probe writes its witness somewhere the gate does not read."""
    mutate(x3, 'export X3_RAW="${X3_RAW:-$X3_DIR/observations.json}"', 'export X3_RAW="$X3_DIR/elsewhere.json"')


def drop_observation_write_and_self_check(fixture: Path, x3: Path) -> None:
    """The strongest form of class 3: the probe is compromised end to end.

    It stops writing the witness *and* stops checking for it, so it finishes with exit 0 and a
    perfectly well-formed evidence file that claims raw observations were captured. Nothing but
    the gate's own re-read stands between that claim and a PASS.
    """
    remove_observation_write(fixture)
    mutate(
        x3,
        '// 单独跑 x3 时也要在原始观察值缺失时立刻失败，但只报事实、不打印内容。\n'
        'assert(existsSync(observationsPath), "原始观察值产物必须存在");\n'
        'const observations = JSON.parse(readFileSync(observationsPath, "utf8"));\n'
        'assert.equal(\n'
        '  Buffer.byteLength(observations.piImageBase64, "utf8"),\n'
        '  evidence.image.base64Length,\n'
        '  "原始观察值的长度与已发布长度一致",\n'
        ');\n'
        'assert.equal(\n'
        '  observations.piImageMimeType,\n'
        '  evidence.image.mimeType,\n'
        '  "原始观察值的 mimeType 与已发布值一致",\n'
        ');\n',
        '// This probe no longer checks the artifact it claims to have written.\n',
    )


def delete_evidence_after_success(x3: Path) -> None:
    mutate(
        x3,
        "printf 'PASS MCP extension surface verification\\n'",
        'rm -f "$X3_EVIDENCE"\nprintf \'PASS MCP extension surface verification\\n\'',
    )


def delete_observations_after_success(x3: Path) -> None:
    mutate(
        x3,
        "printf 'PASS MCP extension surface verification\\n'",
        'rm -f "$X3_RAW"\nprintf \'PASS MCP extension surface verification\\n\'',
    )


def weaken_tools_list_comparison(fixture: Path) -> None:
    """M1: the deep comparison becomes a comparison of `rawToolNames` with itself."""
    mutate(
        fixture,
        "const toolsListMatchesExpected = isDeepStrictEqual(rawToolNames, expectedToolNames);",
        "const toolsListMatchesExpected = isDeepStrictEqual(rawToolNames, rawToolNames);",
    )


def truncate_received_tool_names(fixture: Path) -> None:
    """M1 witness: what Pi received is no longer the server's list, and nothing else complains.

    The probe's own length assertion counts `toolNames`, which is derived separately, so the
    weakened check above still passes and the probe exits 0.
    """
    mutate(
        fixture,
        "const rawToolNames = connection.tools.map((tool) => tool.name).sort();",
        "const rawToolNames = connection.tools.map((tool) => tool.name).sort().slice(1);",
    )


def drop_cross_root_read_assertion(gate: Path) -> None:
    """M3: the cross-root read is no longer attempted, so no rejection can be observed."""
    mutate(
        gate,
        "    await assert.rejects(a.client.callTool('read',{path:join(roots[1]!,'value.txt')}));\n",
        "    // 跨 root read 断言已删除\n",
    )


def hardcode_timeout_result(gate: Path) -> None:
    """M5: the timeout probe returns a literal instead of calling the server."""
    mutate(
        gate,
        "  await checked('timeout',async()=>{\n"
        "    const result=await execute('mcp__root-1__never_reply',{});\n"
        "    assert(existsSync(join(roots[1]!,'request-observed')));\n"
        "    assert.equal(result.details.outcome,'unknown');\n"
        "    const calls=readFileSync(join(dir,'calls-root-b.log'),'utf8').trim().split('\\n').map(line=>JSON.parse(line));\n"
        "    const requestObserved=calls.some((call:any)=>call.tool==='never_reply'&&call.outcome==='no_reply');\n"
        "    return {requestReachedServer:requestObserved,outcome:result.details.outcome};\n"
        "  });\n",
        "  await checked('timeout',async()=>{ return {requestReachedServer:true,outcome:'unknown'}; });\n",
    )


def hardcode_stale_generation(gate: Path) -> None:
    """M6: the old-generation exchange is replaced by a local constant."""
    mutate(
        gate,
        "    try {ctx.now=new Date(); await mcpSessionExchange({projectId,machineId,authorizationGeneration:1,"
        "sessionId:connections.at(-1).transport.sessionId,frames:[],ackServerSeq:0,cancelClientSeqs:[],"
        "protocolVersion:null,confirmInitialized:false,holdMs:0},ctx);} catch(e) {code=(e as any).code; "
        "writeFileSync(join(dir,'release-observation.json'),JSON.stringify({code:code??null,"
        "framesBefore:framesBefore.n,framesAfter:(sqlite.prepare('SELECT count(*) AS n FROM mcp_frame').get() "
        "as any).n}));}\n",
        "    code='lease_stale_generation';\n",
    )


def remove_official_sdk_connections(gate: Path) -> None:
    """R1-1: the SDK probe stops connecting and only publishes the booleans it used to derive.

    Both `connect()`/`listTools()` calls are deleted; the probe still exits 0 and still claims
    `stdioConnected`/`httpToolCount` as literals. Nothing the gate used to check the version
    string notices, because the version lookup stays (so the failure is the connection, not a
    malformed version).
    """
    content = gate.read_text()
    start = content.index("  await checked('officialSdk',async()=>{")
    end = content.index("  const catalog = () =>", start)
    body = content[start:end]
    for marker in ("await stdio.connect(", "await stdio.listTools()", "await http.connect(", "await http.listTools()"):
        if marker not in body:
            raise DriverError(f"officialSdk mutation anchor not found: {marker}")
    replacement = (
        "  await checked('officialSdk',async()=>{\n"
        "    const entries=readdirSync('node_modules/.pnpm').filter(name=>name.startsWith('@modelcontextprotocol+sdk@'));\n"
        "    assert.equal(entries.length,1,'one unambiguous installed official SDK');\n"
        "    const sdkRoot=join(process.cwd(),'node_modules/.pnpm',entries[0]!,'node_modules/@modelcontextprotocol/sdk');\n"
        "    const sdkVersion=JSON.parse(readFileSync(join(sdkRoot,'package.json'),'utf8')).version;\n"
        "    return {version:sdkVersion,stdioConnected:true,stdioToolCount:4,streamableHttpConnected:true,httpToolCount:1,referenceOnly:true};\n"
        "  });\n"
    )
    gate.write_text(content[:start] + replacement + content[end:])


def y2_exit_after_success(copy: Path) -> None:
    """R1-1: y2 finishes its evidence and then exits 1, while every `passed('y2')` is deleted.

    This is the strongest form of the weak-binding attack: no clause body asks about the probe
    exit code any more, so only a check the gate performs outside the clause bodies can keep the
    failing probe from being published as PASS.
    """
    mutate(
        copy / Y2_SCRIPT,
        "printf 'PASS MCP HTTP Worker evidence %s/evidence.json\\n' \"$verification_dir\"\n",
        "printf 'PASS MCP HTTP Worker evidence %s/evidence.json\\n' \"$verification_dir\"\nexit 1\n",
    )
    gate = copy / GATE
    content = gate.read_text()
    occurrences = content.count("passed('y2');")
    if occurrences != 3:
        raise DriverError(f"expected three passed('y2') calls in {gate}, found {occurrences}")
    gate.write_text(content.replace("passed('y2');", ""))


def prefix_only_mcp_tools(gate: Path) -> None:
    """R1-2: the surface probe returns the bare prefix instead of the tools Pi actually has."""
    mutate(
        gate,
        "    return {activeMcpTools:active,allowlistExcludedNotify:true",
        "    return {activeMcpTools:['mcp__'],allowlistExcludedNotify:true",
    )


def assert_configured_service_terminated(y2: Path) -> None:
    """M4: stop waiting, hardcode the claim, and keep the child alive to make the claim false.

    `waitFor(() => !live(...))` becomes `waitFor(() => true)`, the evidence field becomes a
    literal `false`, the Worker is SIGKILLed so its own shutdown never terminates the managed
    service, and the fixture no longer clears the survivor. The probe still exits 0 while the
    configured service is alive after the Worker is gone.
    """
    mutate(
        y2,
        '  worker.kill("SIGTERM");\n'
        "  await waitFor(() => worker!.exitCode !== null || worker!.signalCode !== null, 8000);\n"
        "  const exit = await exited;\n"
        "  assert.deepEqual(exit, { code: 0, signal: null });\n"
        "  await waitFor(() => !live(managedPid!));\n",
        '  worker.kill("SIGKILL");\n'
        "  await waitFor(() => worker!.exitCode !== null || worker!.signalCode !== null, 8000);\n"
        "  const exit = await exited;\n"
        "  await waitFor(() => true);\n",
    )
    mutate(y2, "      aliveAfterWorkerExit: live(managedPid),", "      aliveAfterWorkerExit: false,")
    mutate(
        y2,
        "  if (managedPid && live(managedPid)) {\n"
        "    try {\n"
        '      process.kill(-managedPid, "SIGKILL");\n'
        "    } catch {}\n"
        "  }\n",
        "",
    )


def build_mutations() -> list[Mutation]:
    return [
        # Required class 1: real byte comparison gone, probe still exits 0, witness disagrees.
        Mutation(
            "image-comparison-removed",
            FIXTURE,
            "探针只比长度，Pi 与 server 的图片字节实际不同",
            lambda copy: (weaken_image_comparison(copy / FIXTURE), corrupt_server_image(copy / FIXTURE)),
        ),
        # Required class 2: real structuredContent comparison gone, probe still exits 0.
        Mutation(
            "structured-comparison-removed",
            FIXTURE,
            "探针只比类型，structuredContent 的 humidity 不同",
            lambda copy: (weaken_structured_comparison(copy / FIXTURE), corrupt_server_structured(copy / FIXTURE)),
        ),
        # Required class 3: the bounded raw observation path is deleted or replaced.
        Mutation(
            "raw-observation-path-removed",
            FIXTURE,
            "探针不再写原始观察值，但 evidence 仍声明已经捕获",
            lambda copy: drop_observation_write(copy / FIXTURE),
        ),
        Mutation(
            "raw-observation-path-swapped",
            X3_SCRIPT,
            "原始观察值被写到门禁不读取的路径",
            lambda copy: redirect_observation_path(copy / X3_SCRIPT),
        ),
        Mutation(
            "raw-observation-path-removed-probe-succeeds",
            FIXTURE,
            "探针不写原始观察值且不自查，仍以 0 退出并声明已捕获",
            lambda copy: drop_observation_write_and_self_check(copy / FIXTURE, copy / X3_SCRIPT),
        ),
        # Required class 4: x3 exits 0 and deletes what it produced.
        Mutation(
            "x3-evidence-removed-after-success",
            X3_SCRIPT,
            "x3 成功退出后删掉 evidence 文件",
            lambda copy: delete_evidence_after_success(copy / X3_SCRIPT),
        ),
        Mutation(
            "x3-observations-removed-after-success",
            X3_SCRIPT,
            "x3 成功退出后删掉原始观察值文件",
            lambda copy: delete_observations_after_success(copy / X3_SCRIPT),
        ),
        # Extra: the bounded-shape contract, which a truncated or non-PNG witness must not slip past.
        Mutation(
            "observation-not-a-png",
            FIXTURE,
            "Pi 侧原始观察值不是 PNG",
            lambda copy: replace_image_with_non_png(copy / FIXTURE),
        ),
        # Round 4: M1/M3/M4/M5/M6. Each probe still exits 0 and still reports success; the gate
        # rejects it because the value it needs comes from an observation the mutation destroyed.
        Mutation(
            "tools-list-comparison-removed",
            X2_FIXTURE,
            "M1：tools/list 改成与自身深度比较，Pi 收到的名字还少了一个",
            lambda copy: (weaken_tools_list_comparison(copy / X2_FIXTURE), truncate_received_tool_names(copy / X2_FIXTURE)),
            expected_clause=1,
        ),
        Mutation(
            "cross-root-read-assertion-removed",
            GATE,
            "M3：删掉跨 root read 拒绝断言，探针仍以 0 退出并声称拒绝",
            lambda copy: drop_cross_root_read_assertion(copy / GATE),
            expected_clause=3,
        ),
        Mutation(
            "configured-service-liveness-hardcoded",
            Y2_FIXTURE,
            "M4：不再等 configured_service 终止，证据写死 false，子进程实际存活",
            lambda copy: assert_configured_service_terminated(copy / Y2_FIXTURE),
            expected_clause=6,
        ),
        Mutation(
            "timeout-probe-hardcoded",
            GATE,
            "M5：timeout 探针直接返回字面量，从未调用永不响应工具",
            lambda copy: hardcode_timeout_result(copy / GATE),
            expected_clause=5,
        ),
        Mutation(
            "stale-generation-constant",
            GATE,
            "M6：旧代次 exchange 换成常量 lease_stale_generation，不再走服务端路径",
            lambda copy: hardcode_stale_generation(copy / GATE),
            expected_clause=5,
        ),
        # Round 7: the three remaining evidence-production paths. Each probe still exits 0 (or
        # in the y2 case exiting 1 must itself be enough), and the target clause must be FAIL.
        Mutation(
            "official-sdk-connections-removed",
            GATE,
            "R1-1：SDK 探针删掉两种传输的 connect/listTools，只返回连接布尔与工具数",
            lambda copy: remove_official_sdk_connections(copy / GATE),
            expected_clause=1,
        ),
        Mutation(
            "y2-exits-after-success-without-passed",
            Y2_SCRIPT,
            "R1-1：y2 写完证据后 exit 1，且三条 passed('y2') 全被删除",
            lambda copy: y2_exit_after_success(copy),
            expected_clause=1,
        ),
        Mutation(
            "mcp-tools-bare-prefix",
            GATE,
            "R1-2：Pi 工具面只返回 ['mcp__']，不是真实 5 个工具名",
            lambda copy: prefix_only_mcp_tools(copy / GATE),
            expected_clause=2,
        ),
    ]


# ---------------------------------------------------------------- the harness

def clause_statuses(stdout: str) -> dict[int, str]:
    found = {int(number): state for state, number in STATUS_RE.findall(stdout)}
    if sorted(found) != list(range(1, 8)):
        raise DriverError(f"gate printed {sorted(found)} instead of seven clause statuses")
    return found


def run_dir(copy: Path) -> Path:
    directories = sorted((copy / ".verify").glob("z3-mcp-acceptance-*"), key=lambda path: path.stat().st_mtime_ns)
    if not directories:
        raise DriverError("gate produced no run directory")
    return directories[-1]


def captured_observations(copy: Path) -> list[str]:
    """The values this run captured, used as needles for the leak scan."""
    artifact = run_dir(copy) / PRIVATE_ARTIFACT
    if not artifact.exists():
        return []
    observation = json.loads(artifact.read_text())
    values = [observation["piImageBase64"], observation["serverImageBase64"]]
    values += [
        json.dumps(observation[key], separators=(",", ":"), ensure_ascii=False)
        for key in ("piStructuredContent", "serverStructuredContent")
    ]
    return [value for value in values if value]


def visible_artifacts(copy: Path) -> str:
    """The result artifacts a reviewer reads, as opposed to the generated probe sources."""
    directory = run_dir(copy)
    names = ["run.log", "evidence.json", "x3-evidence.json", *(f"clause-{n}.json" for n in range(1, 8))]
    parts = []
    for name in names:
        path = directory / name
        if path.exists():
            parts.append(f"=== {name} ===\n{path.read_text(errors='replace')}")
    return "\n".join(parts)


def assert_no_raw_values(name: str, copy: Path, output: str) -> None:
    haystack = output + "\n" + visible_artifacts(copy)
    for needle in captured_observations(copy):
        if needle in haystack:
            raise DriverError(f"{name}: a captured raw observation is visible in gate output or evidence")
    # Catch a witness the gate itself never captured, e.g. a substituted image.
    if LONG_BASE64_RE.search(haystack):
        raise DriverError(f"{name}: gate output or evidence contains a long base64 run")
    # The publishable probe evidence carries a commitment to the private artifact, never content.
    published_path = run_dir(copy) / "x3-evidence.json"
    if published_path.exists():  # a mutation may delete it; then there is nothing to publish
        published = json.loads(published_path.read_text())
        for forbidden in ("piImageBase64", "serverImageBase64", "piStructuredContent", "serverStructuredContent"):
            if forbidden in json.dumps(published):
                raise DriverError(f"{name}: published evidence names the private field {forbidden}")
        commitment = published.get("image", {}).get("rawObservations", {})
        if set(commitment) - {"blobBytes", "sha256"}:
            raise DriverError(f"{name}: published evidence commitment carries more than a hash and a size")


def prepare(copy: Path, source: Path, baseline: str) -> None:
    """Clone the worktree at `baseline`, then layer this worktree's uncommitted changes on top."""
    result = run(["git", "clone", "--quiet", "--local", "--no-hardlinks", "--no-checkout", str(source), str(copy)], source, timeout=CLONE_TIMEOUT_SECONDS)
    if result.returncode:
        raise DriverError(f"clone failed: {result.stderr.strip()}")
    result = run(["git", "checkout", "--quiet", "--detach", baseline], copy, timeout=CLONE_TIMEOUT_SECONDS)
    if result.returncode:
        raise DriverError(f"checkout failed: {result.stderr.strip()}")
    patch = run(["git", "diff", "--binary", "HEAD"], source, timeout=CLONE_TIMEOUT_SECONDS)
    if patch.returncode:
        raise DriverError(f"could not read source diff: {patch.stderr.strip()}")
    if patch.stdout.strip():
        applied = subprocess.run(
            ["git", "apply", "--binary", "-"],
            cwd=copy,
            input=patch.stdout,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=CLONE_TIMEOUT_SECONDS,
            check=False,
        )
        if applied.returncode:
            raise DriverError(f"could not apply source changes: {applied.stderr.strip()}")
    # Each copy owns its dependencies: no shared directory, so nothing one case writes can be
    # mistaken for another case's evidence.
    install = run(["pnpm", "install", "--frozen-lockfile", "--offline"], copy, timeout=INSTALL_TIMEOUT_SECONDS)
    if install.returncode:
        raise DriverError(f"dependency install failed: {install.stderr.strip()[-400:]}")


def reap_orphans(copy: Path) -> None:
    """A mutation may deliberately leave a survivor; the driver must not leak it to the next case."""
    directories = sorted((copy / ".verify").glob("z3-mcp-acceptance-*"), key=lambda path: path.stat().st_mtime_ns)
    if not directories:
        return
    artifact = directories[-1] / "y2-child.json"
    if not artifact.exists():
        return
    try:
        pid = json.loads(artifact.read_text()).get("managedPid")
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(pid, int):
        return
    for target in (-pid, pid):
        try:
            os.kill(target, signal.SIGKILL)
        except OSError:
            pass


def run_case(name: str, mutation: Mutation | None, *, source: Path, baseline: str, temp_root: Path) -> dict[str, object]:
    copy = temp_root / name
    started = time.monotonic()
    prepare(copy, source, baseline)
    if mutation is not None:
        mutation.apply(copy)
    try:
        result = run(["bash", str(GATE)], copy, timeout=CASE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise DriverError(f"{name}: gate exceeded {CASE_TIMEOUT_SECONDS}s") from None
    finally:
        reap_orphans(copy)
    elapsed = round(time.monotonic() - started, 1)
    output = result.stdout + result.stderr
    statuses = clause_statuses(result.stdout)
    record: dict[str, object] = {
        "case": name,
        "attack": mutation.why if mutation else "clean baseline",
        "exitCode": result.returncode,
        "clauseStatuses": [f"R1-{number} {statuses[number]}" for number in sorted(statuses)],
        "seconds": elapsed,
        "rawValuesVisible": False,
    }
    assert_no_raw_values(name, copy, output)
    target = mutation.expected_clause if mutation else 4
    target_record = json.loads((run_dir(copy) / f"clause-{target}.json").read_text())
    if mutation is None:
        if result.returncode != 0 or any(state != "PASS" for state in statuses.values()):
            failing = {number: state for number, state in statuses.items() if state != "PASS"}
            raise DriverError(f"clean baseline did not pass: exit {result.returncode}, {failing}, {target_record.get('error')}")
        record["gateComputed"] = json.loads((run_dir(copy) / "clause-4.json").read_text())["gateComputed"]
        return record
    if statuses[target] == "INCONCLUSIVE":
        raise DriverError(f"{name}: gate answered R1-{target} INCONCLUSIVE, a probe that reported success must be rejected as FAIL")
    if statuses[target] == "PASS":
        raise DriverError(f"{name}: gate answered R1-{target} PASS, the mutation is not detected")
    if result.returncode == 0:
        raise DriverError(f"{name}: gate exited 0 with R1-{target} FAIL")
    record["clause"] = target
    record["clauseError"] = target_record.get("error")
    record["clauseGateComputed"] = target_record.get("gateComputed")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the R1-4 evidence-production mutations in isolation.")
    parser.add_argument("--only", action="append", default=None, help="run only the named case(s)")
    parser.add_argument("--list", action="store_true", help="list case names and exit")
    parser.add_argument("--source", default=str(ROOT), help="worktree whose changes are under test")
    parser.add_argument("--keep", default=None, help="keep the isolated copies under this directory")
    args = parser.parse_args()

    mutations = build_mutations()
    names = ["clean", *(mutation.name for mutation in mutations)]
    if args.list:
        print("\n".join(names))
        return 0
    if args.only:
        unknown = [name for name in args.only if name not in names]
        if unknown:
            raise DriverError(f"unknown case(s): {', '.join(unknown)}")
        selected = [mutation for mutation in mutations if mutation.name in args.only]
        names = [name for name in names if name in args.only]
    else:
        selected = mutations
    by_name = {mutation.name: mutation for mutation in selected}

    source = Path(args.source).resolve()
    head = run(["git", "rev-parse", "HEAD"], source, timeout=60)
    if head.returncode:
        raise DriverError(f"could not read HEAD of {source}")
    baseline = head.stdout.strip()

    temp_root = Path(tempfile.mkdtemp(prefix="z3-mcp-mutations-", dir=args.keep))
    results: list[dict[str, object]] = []
    try:
        for name in names:
            results.append(run_case(name, by_name.get(name), source=source, baseline=baseline, temp_root=temp_root))
            print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            if not args.keep:
                # Each case is several hundred MB of installed dependencies; keep the disk bounded.
                shutil.rmtree(temp_root / name, ignore_errors=True)
    finally:
        if args.keep:
            print(json.dumps({"tempRoot": str(temp_root)}), flush=True)
        else:
            shutil.rmtree(temp_root, ignore_errors=True)
    print(
        json.dumps(
            {
                "baseline": baseline,
                "cases": len(results),
                "mutations": [name for name in names if name != "clean"],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DriverError as error:
        print(json.dumps({"driverError": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
