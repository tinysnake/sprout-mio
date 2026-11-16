import {
  crewDelegationToolInputSchemas,
  delegationToolInputSchemas,
} from "../contracts/delegation";
import type { Situation } from "../contracts/prompt";

/**
 * `delegation` 两个工具 family 该声明给哪些运行。处境是唯一判别式：crew lead 拿四个
 * crew 工具，delegation worker 拿两个上报工具，其余（助手、DM worker）不拿。
 *
 * 没有 situation 的运行不声明（真实宿主总会带上它，见 `resolveRunSituation`）；
 * 宁可少给，也不给一个角色不需要的写工具。
 */
export function delegationToolNames(situation: Situation | undefined): string[] {
  if (situation?.kind === "crew_lead") return Object.keys(crewDelegationToolInputSchemas);
  if (situation?.kind === "delegation_worker") return Object.keys(delegationToolInputSchemas);
  return [];
}
