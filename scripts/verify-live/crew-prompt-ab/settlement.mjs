import { classifyRuns } from "./core.mjs";
import { settled } from "./evidence.mjs";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function artifactSnapshot(scopes = [], files = []) {
  return scopes.flatMap(({ worktree }) => files.map((file) => {
    const path = join(worktree, file);
    try {
      const stat = statSync(path);
      return { path, mtimeMs: stat.mtimeMs, size: stat.size, content: readFileSync(path, "utf8") };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { path, missing: true };
    }
  }));
}

export function createSettlementCheck({ now = Date.now } = {}) {
  let stableSince = 0,
    signature = "";
  return (latest, artifacts = []) => {
    const terminalFailure = classifyRuns(latest.runs);
    if (terminalFailure) {
      const error = new Error(`agent run terminated ${terminalFailure}`);
      error.runClassification = terminalFailure;
      throw error;
    }
    const nextSignature = JSON.stringify({ latest, artifacts });
    if (!settled(latest) || signature !== nextSignature) {
      stableSince = now();
      signature = nextSignature;
      return false;
    }
    return now() - stableSince >= 1000;
  };
}
