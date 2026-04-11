export interface DbSession {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  cwd: string | null;
}

export interface DbEvent {
  id: number;
  session_id: string;
  timestamp: string;
  event_type: string;
  agent_id: string | null;
  agent_type: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  message_text: string | null;
  status: string;
  file_before: string | null;
}

export interface DbPermissionRequest {
  id: string;
  event_id: number;
  decision: string;
  decided_at: string | null;
  response_json: string | null;
}

export interface ReconnectSummary {
  total_events: number;
  edits: Array<{ event_id: number; file_path: string; additions: number; deletions: number; is_new: boolean }>;
  commands: Array<{ event_id: number; command: string; status: string }>;
  agents: Array<{ agent_id: string; agent_type: string; tool_count: number; status: string }>;
  tasks_completed: number;
  tasks_in_progress: number;
  last_message: string | null;
}

export interface HookCommonFields {
  session_id: string;
  cwd?: string;
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
  permission_mode?: string;
}

export interface HookToolUse extends HookCommonFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface HookToolUseResult extends HookToolUse {
  tool_response?: Record<string, unknown>;
}

export interface HookStop extends HookCommonFields {
  stop_reason: string;
  assistant_message: string;
}

export interface HookUserPrompt extends HookCommonFields {
  user_input: string;
}

export interface HookPermissionRequest extends HookCommonFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface HookSubagentStart extends HookCommonFields {
  agent_id: string;
  agent_type: string;
}

export interface HookSubagentStop extends HookCommonFields {
  agent_id: string;
  agent_type: string;
  last_assistant_message?: string;
}
