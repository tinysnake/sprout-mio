import type { RunActivityKind } from "../contracts/agent-run";

/**
 * 工具调用的一句话摘要。runner 在 `tool_execution_start` 时调用它，把结果随
 * progress 发给宿主；宿主只做展示，不再解析工具入参。这里保持纯函数且不引
 * node 内置模块，因为 runner 通过 jiti 直接加载本文件。
 */
export type ToolActivityDescription = {
  kind: RunActivityKind;
  label: string;
  detail?: string;
  toolName: string;
};

export type DescribeToolOptions = {
  /** 用于把绝对路径缩成仓库内相对路径。 */
  cwd?: string;
  /** 由 Code Mode 等父工具发起的嵌套调用。 */
  nested?: boolean;
};

const DETAIL_LIMIT = 160;
const PATH_LIMIT = 160;

const HINT_KEYS = [
  "command",
  "path",
  "query",
  "pattern",
  "url",
  "claim",
  "body",
  "title",
  "description",
  "name",
  "taskId",
  "executionId",
  "machineId",
  "text",
  "prompt",
  "script",
  "code",
  "action",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function clip(value: string, limit = DETAIL_LIMIT): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function pathDetail(value: string, cwd?: string): string {
  const path = clip(value, PATH_LIMIT);
  if (!cwd) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  return path.startsWith(base) ? clip(path.slice(base.length), PATH_LIMIT) : path;
}

function hint(args: Record<string, unknown>, keys: readonly string[] = HINT_KEYS) {
  for (const key of keys) {
    const value = args[key];
    const text = stringValue(value);
    if (text) return clip(text);
    if (Array.isArray(value)) {
      const first = value.find((item): item is string => typeof item === "string" && !!item.trim());
      if (first) return clip(first);
    }
  }
  return undefined;
}

function describe(
  toolName: string,
  kind: RunActivityKind,
  label: string,
  detail?: string,
): ToolActivityDescription {
  return detail ? { kind, label, detail, toolName } : { kind, label, toolName };
}

function describeKnown(
  toolName: string,
  args: Record<string, unknown>,
  options: DescribeToolOptions,
): ToolActivityDescription | undefined {
  const command = stringValue(args.command);
  const path = stringValue(args.path);
  switch (toolName) {
    case "bash":
      return describe(
        toolName,
        "bash",
        "Bash 命令",
        command ? clip(firstLine(command)) : undefined,
      );
    case "read":
      return describe(
        toolName,
        "file",
        "读取文件",
        path ? pathDetail(path, options.cwd) : undefined,
      );
    case "write":
      return describe(
        toolName,
        "file",
        "写入文件",
        path ? pathDetail(path, options.cwd) : undefined,
      );
    case "edit":
      return describe(
        toolName,
        "file",
        "编辑文件",
        path ? pathDetail(path, options.cwd) : undefined,
      );
    case "grep":
    case "ffgrep": {
      const pattern = stringValue(args.pattern) ?? stringValue(args.query);
      const scope = stringValue(args.path);
      const detail = pattern
        ? scope
          ? `${clip(pattern, 80)} · ${pathDetail(scope, options.cwd)}`
          : clip(pattern, 80)
        : hint(args);
      return describe(toolName, "search", "搜索内容", detail);
    }
    case "find":
    case "fffind": {
      const pattern = stringValue(args.pattern) ?? stringValue(args.query);
      const scope = stringValue(args.path);
      return describe(
        toolName,
        "search",
        "查找文件",
        pattern ? clip(pattern, 80) : scope ? pathDetail(scope, options.cwd) : undefined,
      );
    }
    case "ls":
      return describe(
        toolName,
        "file",
        "查看目录",
        path ? pathDetail(path, options.cwd) : hint(args),
      );
    case "web_search": {
      const queries = args.queries;
      const query = Array.isArray(queries)
        ? queries.find((item): item is string => typeof item === "string")
        : stringValue(args.query);
      return describe(toolName, "web", "网络搜索", query ? clip(query) : undefined);
    }
    case "fetch_content": {
      const urls = args.urls;
      const url = Array.isArray(urls)
        ? urls.find((item): item is string => typeof item === "string")
        : stringValue(args.url);
      return describe(toolName, "web", "抓取网页", url ? clip(url, 100) : undefined);
    }
    case "source_check":
      return describe(toolName, "web", "核对来源", hint(args, ["claim", "queries"]));
    case "get_search_content":
      return describe(toolName, "web", "读取搜索结果", hint(args, ["query", "url"]));
    case "tool_search":
      return describe(toolName, "search", "查找工具", hint(args, ["query"]));
    case "codemode":
      return describe(toolName, "code_mode", "Code Mode 脚本", hint(args, ["script", "code"]));
    case "sprout_status":
      return describe(toolName, "tool", "读取宿主状态");
    case "sprout_info_hub_get":
      return describe(toolName, "task", "读取 Info Hub", hint(args));
    case "sprout_chat_get":
      return describe(toolName, "task", "读取对话", hint(args));
    case "sprout_chat_send":
      return describe(toolName, "task", "发送消息", hint(args));
    case "sprout_chat_continuation_get":
      return describe(toolName, "task", "读取对话接续", hint(args));
    case "sleep":
      return describe(
        toolName,
        "tool",
        "本地等待",
        typeof args.ms === "number" && Number.isFinite(args.ms)
          ? `${args.ms / 1_000} 秒`
          : undefined,
      );
    case "sprout_remote_execution_wait":
      return describe(toolName, "remote", "等待远程执行", hint(args));
    case "sprout_remote_execution_get":
      return describe(toolName, "remote", "查询远程执行", hint(args));
    case "sprout_remote_execution_list":
      return describe(toolName, "remote", "列出远程执行", hint(args));
    case "sprout_remote_execution_cancel":
      return describe(toolName, "remote", "取消远程执行", hint(args));
    case "sprout_remote_execution_log":
      return describe(toolName, "remote", "读取远程执行日志", hint(args));
    case "sprout_remote_shell":
      return describe(
        toolName,
        "remote",
        "远程命令",
        command ? clip(firstLine(command)) : undefined,
      );
    case "sprout_remote_file_read":
      return describe(
        toolName,
        "remote",
        "远程读取",
        path ? pathDetail(path, options.cwd) : undefined,
      );
    case "sprout_remote_file_write":
      return describe(
        toolName,
        "remote",
        "远程写入",
        path ? pathDetail(path, options.cwd) : undefined,
      );
    default:
      break;
  }

  if (toolName.startsWith("sprout_remote_"))
    return describe(toolName, "remote", "远程操作", hint(args));
  if (toolName.startsWith("sprout_lease_"))
    return describe(toolName, "remote", "Machine 租约", hint(args, ["machineId", "action"]));
  if (toolName.startsWith("sprout_task_"))
    return describe(toolName, "task", "Task 协作", hint(args));
  // Chat 工具按各自语义命名；新增的 Chat 工具不能默认继承「发送消息」。
  if (toolName.startsWith("sprout_chat_"))
    return describe(toolName, "task", "对话协作", hint(args));
  if (toolName.startsWith("sprout_"))
    return describe(toolName, "tool", "Sprout 工具", hint(args) ?? toolName.slice(7));
  return undefined;
}

/**
 * 把 Pi 的工具名与入参压成一句人类可读的活动描述。
 * 未知工具绝不丢事件：落到「工具调用」并尽量给出第一个可读字符串参数。
 */
export function describeToolCall(
  toolName: string,
  rawArgs: unknown,
  options: DescribeToolOptions = {},
): ToolActivityDescription {
  const args = asRecord(rawArgs);
  if (toolName.startsWith("mcp__")) {
    const body = toolName.slice("mcp__".length);
    const separator = body.indexOf("__");
    const server = separator > 0 ? body.slice(0, separator) : body;
    const tool = separator > 0 ? body.slice(separator + 2) : "call";
    const argHint = hint(args);
    return describe(
      toolName,
      "mcp",
      "MCP 调用",
      argHint ? `${server} · ${tool} · ${argHint}` : `${server} · ${tool}`,
    );
  }

  const known = describeKnown(toolName, args, options);
  if (known) {
    if (!options.nested) return known;
    return {
      ...known,
      kind: "code_mode",
      label: `Code Mode · ${known.label}`,
    };
  }

  const fallback = describe(toolName, "tool", "工具调用", hint(args) ?? clip(toolName, 80));
  if (!options.nested) return fallback;
  return { ...fallback, kind: "code_mode", label: `Code Mode · ${fallback.label}` };
}
