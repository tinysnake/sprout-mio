type Control = { settle: (state: string) => void; calls: number };
const control = ((window as any).__p7 = { calls: 0 }) as Control;
export async function request() {
  control.calls++;
  return new Promise<any>((resolve, reject) => {
    control.settle = (state) => {
      if (state === "unknown") reject(new TypeError("response lost after submission"));
      else if (state === "failure")
        resolve({
          ok: false,
          error: { code: "forbidden", message: "业务拒绝", requestId: "req_p7" },
        });
      else
        resolve({
          ok: true,
          requestId: "req_p7",
          data: {
            mutationId: "mut_p7",
            action: "acquire",
            state: "completed",
            completedGeneration: 1,
            expectedGeneration: 0,
          },
        });
    };
  });
}
export const assistantActionFn = request;
export const sendMessageFn = request;
export const abortAgentRunFn = request;
export const clearChatTitleFn = request;
export const updateChatTitleFn = request;
export const forceReclaimLeaseFn = request;
export const getLeaseFn = request;
export const listProjectExecutionsFn = request;
/**
 * 分页窗口读：夹具的 ChatPane 直接吃 `page` 属性，这个读只在翻页时才会走，
 * 回一份空窗口即可（不能借用 `request`，否则会污染 send 动作的调用计数）。
 */
export async function listMessagesFn() {
  return {
    ok: true as const,
    requestId: "req_p7",
    data: { messages: [], tailCursor: null, olderCursor: null, hasOlder: false, hasNewer: false },
  };
}
