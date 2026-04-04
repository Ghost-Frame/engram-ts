// ============================================================================
// CONVERSATIONS DOMAIN - Type definitions
// ============================================================================

export interface Conversation {
  id: number;
  agent: string;
  session_id: string | null;
  title: string | null;
  metadata: string | null;
  user_id: number;
  started_at: string;
  updated_at: string;
}

export interface ConversationListItem {
  id: number;
  agent: string;
  session_id: string | null;
  title: string | null;
  metadata: string | null;
  started_at: string;
  updated_at: string;
  message_count: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface CreateConversationBody {
  agent: string;
  session_id?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateConversationBody {
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BulkMessageInput {
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export interface BulkInsertBody {
  agent: string;
  session_id?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  messages: BulkMessageInput[];
}

export interface UpsertConversationBody {
  agent: string;
  session_id: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  messages?: BulkMessageInput[];
}

export interface SearchMessagesBody {
  query: string;
  limit?: number;
}
