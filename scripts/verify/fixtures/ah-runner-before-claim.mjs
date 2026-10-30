import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (destination.endsWith("/runner.json")) {
    const claim = JSON.parse(fs.readFileSync(source, "utf8"));
    if (claim.childPid) {
      fs.writeFileSync(process.env.AH_TEST_PAUSED, JSON.stringify(claim));
      process.kill(process.pid, "SIGSTOP");
    }
  }
  return rename(source, destination);
};
syncBuiltinESMExports();
