/** 仅声明本 extension 使用的 Pi MCP API 子集（托管 Pi 1.4.0 的 `@earendil-works/pi-mcp`）。 */
export type JsonRpcId = string | number;
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export interface McpTransportSendOptions {
  signal?: AbortSignal;
}
/** 与 pi-mcp `McpTransport` 同形的六方法加一可选。 */
export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
  setProtocolVersion?(version: string): void;
}

export interface McpRoot {
  uri: string;
  name?: string;
}
export interface McpClientOptions {
  name: string;
  version: string;
  capabilities?: Record<string, unknown>;
  requestTimeoutMs?: number;
  roots?: readonly McpRoot[];
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}
export type McpContentBlock = { type: string } & Record<string, unknown>;
export interface McpCallToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}
export interface McpRequestOptions {
  signal?: AbortSignal;
}
export interface McpClient {
  readonly connectionState: "idle" | "connecting" | "connected" | "closed";
  connect(transport: McpTransport): Promise<unknown>;
  setRequestHandler(
    method: string,
    handler: (params: unknown, context: { signal: AbortSignal }) => unknown,
  ): () => void;
  onNotification(method: string, listener: (params: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
  listTools(options?: McpRequestOptions): Promise<McpTool[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
}
/** 运行时注入句柄：只用到处方里出现的构造函数，不引入 SDK 类型依赖。 */
export interface PiMcpModule {
  McpClient: new (options: McpClientOptions) => McpClient;
  parseJsonRpcMessage(value: unknown): JsonRpcMessage;
  toLlmContent(result: McpCallToolResult): McpContentBlock[];
  /** 实测解析到的 pi-mcp 安装目录，用于证据与报错。 */
  readonly root: string;
  /** 实测导出名列表，用于报告核对。 */
  readonly exportNames: readonly string[];
}
