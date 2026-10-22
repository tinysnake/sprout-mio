import type { Project } from "../../contracts/project";
import { Facts } from "./settings-section";

/**
 * Project 的基本事实：身份、创建时间与本次查询的 requestId。
 * 时间按本地时区展示，`dateTime` 保留服务端的 ISO 事实供机器读取；
 * 时区不同会让服务端与客户端文本不一致，因此该节点忽略 hydration 文本差异。
 */
export function ProjectFacts({ project, requestId }: { project: Project; requestId: string }) {
  return (
    <Facts
      items={[
        {
          label: "Project ID",
          testId: "project-settings-id",
          value: <code className="font-mono text-[0.6875rem]">{project.id}</code>,
        },
        {
          label: "创建时间",
          testId: "project-settings-created-at",
          value: (
            <time dateTime={project.createdAt} title={project.createdAt} suppressHydrationWarning>
              {new Date(project.createdAt).toLocaleString("zh-CN", { hour12: false })}
            </time>
          ),
        },
        {
          label: "requestId",
          testId: "project-settings-request-id",
          value: <code className="font-mono text-[0.6875rem]">{requestId}</code>,
        },
      ]}
    />
  );
}
