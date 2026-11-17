import { classifyRuns } from "./core.mjs";
import { settled } from "./evidence.mjs";

export function createSettlementCheck({ now = Date.now } = {}) {
  let stableSince = 0,
    signature = "";
  return (latest) => {
    const terminalFailure = classifyRuns(latest.runs);
    if (terminalFailure) {
      const error = new Error(`agent run terminated ${terminalFailure}`);
      error.runClassification = terminalFailure;
      throw error;
    }
    const nextSignature = JSON.stringify(latest);
    if (!settled(latest) || signature !== nextSignature) {
      stableSince = now();
      signature = nextSignature;
      return false;
    }
    return now() - stableSince >= 1000;
  };
}
