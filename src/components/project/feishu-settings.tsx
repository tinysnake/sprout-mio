import { useState } from "react";
import { FeishuBindingPanel } from "./feishu-binding-panel";
import { FeishuConfigPanel } from "./feishu-config-panel";

/**
 * 配置段与绑定段是同一次会话里的两步：保存凭证后重建绑定段，让它按新配置重新读取，
 * 而不是继续展示「未配置」。
 */
export function FeishuSettings({ projectId }: { projectId: string }) {
  const [savedRevision, setSavedRevision] = useState(0);
  return (
    <>
      <FeishuConfigPanel
        projectId={projectId}
        onSaved={() => setSavedRevision((value) => value + 1)}
      />
      <FeishuBindingPanel key={`${projectId}:${savedRevision}`} projectId={projectId} />
    </>
  );
}
