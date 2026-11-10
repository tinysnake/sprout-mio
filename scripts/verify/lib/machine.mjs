// 机器负载决定「时间预算型门禁」的结果能不能当证据：满载机器上的超时不是产品缺陷（见
// docs/verification.md 的机器负载策略）。runner 把核数、内存与 loadavg 写进报告，负载高到一定
// 程度就直接拒绝开跑，免得一小时的假红被当成真失败——判红前先看 uptime 是人工动作，这里把它
// 挪到运行之前。手工复跑单条门禁仍可随时用 SPROUT_VERIFY_ALLOW_LOADED=1 绕过。
//
// 判定只看 loadavg，不看可用内存：macOS 的 os.freemem() 只报 free 列表，健康机器上就只有几百 MB
// （实测 228MB），拿它做门槛会把正常机器当成「不适合验证」。内存数字仍写进报告，供判红时参考。
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";

/** 复跑前提示「负载偏高」的阈值：loadavg 达到这个核数倍数。 */
export const LOADED_FACTOR = 0.75;
/** 拒绝开跑的阈值：loadavg 达到这个核数倍数。 */
export const UNFIT_LOAD_FACTOR = 1.5;
/** 设为 1 时忽略拒绝判定，仍然开跑。 */
export const LOADED_BYPASS_ENV = "SPROUT_VERIFY_ALLOW_LOADED";
/** 测试注入机器状态的入口：值是 machineState 的 JSON。 */
export const MACHINE_STATE_ENV = "SPROUT_VERIFY_MACHINE_STATE";

export function machineState(environment = process.env) {
  const injected = environment[MACHINE_STATE_ENV];
  if (injected !== undefined) {
    const state = JSON.parse(injected);
    return {
      cpus: state.cpus,
      totalMemMB: state.totalMemMB,
      freeMemMB: state.freeMemMB,
      load: state.load,
    };
  }
  return {
    cpus: availableParallelism(),
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    freeMemMB: Math.round(freemem() / 1024 / 1024),
    load: loadavg().map((value) => Number(value.toFixed(2))),
  };
}

export function loadedMachine(state) {
  return state.load[0] >= state.cpus * LOADED_FACTOR;
}

export function unfitMachine(state) {
  return state.load[0] >= state.cpus * UNFIT_LOAD_FACTOR;
}

export function unfitReason(state) {
  const limit = Number((state.cpus * UNFIT_LOAD_FACTOR).toFixed(2));
  return `loadavg ${state.load[0]} ≥ ${limit}（${state.cpus} 核 × ${UNFIT_LOAD_FACTOR}）`;
}
