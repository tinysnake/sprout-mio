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
export const sendMessageFn = request;
export const abortAgentRunFn = request;
export const clearChatTitleFn = request;
export const updateChatTitleFn = request;
export const forceReclaimLeaseFn = request;
export const getLeaseFn = request;
export const listProjectExecutionsFn = request;
