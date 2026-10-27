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
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = Path("scripts/verify/z3-mcp-acceptance.sh")
X3_SCRIPT = Path("scripts/verify/x3-mcp-extension-surface.sh")
FIXTURE = Path("tests/fixtures/mcp-extension-surface.ts")
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

    def __init__(self, name: str, target: Path, why: str, apply) -> None:
        self.name = name
        self.target = target
        self.why = why
        self.apply = apply


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
    clause4 = json.loads((run_dir(copy) / "clause-4.json").read_text())
    if mutation is None:
        if result.returncode != 0 or any(state != "PASS" for state in statuses.values()):
            failing = {number: state for number, state in statuses.items() if state != "PASS"}
            raise DriverError(f"clean baseline did not pass: exit {result.returncode}, {failing}, {clause4.get('error')}")
        record["gateComputed"] = clause4["gateComputed"]
        return record
    if statuses[4] == "INCONCLUSIVE":
        raise DriverError(f"{name}: gate answered INCONCLUSIVE, a probe that reported success must be rejected as FAIL")
    if statuses[4] == "PASS":
        raise DriverError(f"{name}: gate answered PASS, the mutation is not detected")
    if result.returncode == 0:
        raise DriverError(f"{name}: gate exited 0 with R1-4 FAIL")
    record["clause4Error"] = clause4.get("error")
    record["clause4GateComputed"] = clause4.get("gateComputed")
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
