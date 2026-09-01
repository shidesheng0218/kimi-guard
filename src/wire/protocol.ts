export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const WIRE_PROTOCOL_VERSION = "1.10";

export interface InitializeParams {
  protocol_version: string;
  client?: { name: string; version?: string };
  external_tools?: unknown[];
  capabilities?: { supports_question?: boolean; supports_plan_mode?: boolean };
  hooks?: Array<{ id: string; event: string; matcher?: string; timeout?: number }>;
}

export interface InitializeResult {
  protocol_version: string;
  server: { name: string; version: string };
  slash_commands?: Array<{ name: string; description: string; aliases: string[] }>;
  capabilities?: { supports_question?: boolean };
  hooks?: { supported_events: string[]; configured: Record<string, number> };
}

export interface PromptResult {
  status: "finished" | "cancelled" | "max_steps_reached";
  steps?: number;
}

export interface SteerResult {
  status: "steered";
}

export interface ToolCallPayload {
  type: "function";
  id: string;
  function: { name: string; arguments?: string | null };
  extras?: unknown;
}

export interface ToolResultPayload {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output: string | Array<{ type: string; [k: string]: unknown }>;
    message: string;
    display?: unknown[];
  };
}

export interface TokenUsage {
  input_other: number;
  output: number;
  input_cache_read: number;
  input_cache_creation: number;
}

export interface StatusUpdatePayload {
  context_usage?: number | null;
  context_tokens?: number | null;
  max_context_tokens?: number | null;
  token_usage?: TokenUsage | null;
  message_id?: string | null;
  plan_mode?: boolean | null;
}

export interface StepBeginPayload {
  n: number;
}

export interface StepRetryPayload {
  n: number;
  next_attempt: number;
  max_attempts: number;
  wait_s: number;
  error_type: string;
  status_code?: number | null;
}

export interface SubagentEventPayload {
  parent_tool_call_id?: string | null;
  agent_id?: string | null;
  subagent_type?: string | null;
  event: { type: string; payload: object };
}

export interface HookRequestPayload {
  id: string;
  subscription_id: string;
  event: string;
  target: string;
  input_data: object;
}

export interface HookResponse {
  request_id: string;
  action: "allow" | "block";
  reason: string;
}

export interface ApprovalRequestPayload {
  id: string;
  tool_call_id: string;
  sender: string;
  action: string;
  description: string;
  source_kind?: "foreground_turn" | "background_agent" | null;
  agent_id?: string | null;
  subagent_type?: string | null;
}

export interface QuestionRequestPayload {
  id: string;
  tool_call_id: string;
  questions: unknown[];
}
