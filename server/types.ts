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

