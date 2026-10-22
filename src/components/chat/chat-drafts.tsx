import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

type DraftStore = {
  drafts: Record<string, string>;
  setDraft: (chatId: string, value: string) => void;
};

const DraftContext = createContext<DraftStore | null>(null);

/**
 * 未发送的草稿按 Chat 分开保存。切换对话时不丢用户已经输入的内容，
 * 也不会把 A 的草稿带进 B；服务端确认发送后由调用方清空对应 Chat。
 * 状态只活在这层 React 树里，不写 localStorage，也不跨页面存活。
 */
export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const store = useMemo<DraftStore>(
    () => ({
      drafts,
      setDraft: (chatId, value) =>
        setDrafts((current) =>
          current[chatId] === value ? current : { ...current, [chatId]: value },
        ),
    }),
    [drafts],
  );
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

/** 一条对话的草稿与写入函数；没有 Provider 时退回组件本地状态。 */
export function useChatDraft(chatId: string): [string, (value: string) => void] {
  const store = useContext(DraftContext);
  const [local, setLocal] = useState("");
  if (!store) return [local, setLocal];
  return [store.drafts[chatId] ?? "", (value) => store.setDraft(chatId, value)];
}
