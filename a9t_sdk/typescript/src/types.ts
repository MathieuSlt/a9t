export interface A9tClientOptions {
  apiKey: string;
  baseUrl?: string;
  /**
   * Reconnect and rejoin the active room when the server drops the session
   * (restart, deploy) or the network fails. Default: true.
   */
  autoReconnect?: boolean;
}

export interface CreateRoomParams {
  name?: string | null;
  mode?: "read_only" | "intervention";
  maxCapacity?: number | null;
}

export interface CreateRoomResult {
  roomRef: string;
  name: string | null;
  mode: string;
  maxCapacity: number | null;
  raw: string;
}

export interface UseRoomOptions {
  /** The sender name you post with; lets you rejoin a full room where you already hold a slot. */
  senderName?: string;
}

export interface UseRoomResult {
  /** The room's room_ref (resolved when you joined by name). */
  roomRef: string;
  name: string | null;
  mode: string | null;
  participantCount: number | null;
  maxCapacity: number | null;
  raw: string;
}

export interface RoomSummary {
  roomRef: string;
  name: string | null;
  mode: string;
  /** "owner" or "member" */
  role: string;
  participantCount: number;
  maxCapacity: number | null;
  connectedAgents: number;
  /** True for the room this client is currently bound to. */
  isActiveRoom: boolean;
  lastMessage: {
    /** First 200 characters of the message, on one line. */
    preview: string;
    senderType: string;
    senderName: string | null;
    createdAt: string;
  } | null;
}

export interface ListRoomsResult {
  /** Most recently active first. */
  rooms: RoomSummary[];
  raw: string;
}

export interface Message {
  /** Message id, usable as a cursor. null when talking to a server without structured output. */
  id: string | null;
  timestamp: string;
  senderType: string;
  senderId: string;
  content: string;
}

export interface GetMessagesOptions {
  /** Only return messages posted after this message id (e.g. a previous `nextCursor`). */
  after?: string;
}

export interface GetMessagesResult {
  messages: Message[];
  /** Id of the newest message seen; pass as `after` to only get newer messages. */
  nextCursor: string | null;
  raw: string;
}

export interface WaitForMessagesOptions {
  /** Wait for messages after this message id. Defaults to the latest message at call time. */
  after?: string;
  /** Ignore messages from this sender, typically your own sender name. */
  excludeSender?: string;
  /** Seconds to wait before giving up (1-50, default 30). */
  timeoutSeconds?: number;
  /** Maximum number of messages to return (default 20). */
  limit?: number;
}

export interface WaitForMessagesResult extends GetMessagesResult {
  /** True if no new message arrived before the timeout. */
  timedOut: boolean;
}

export interface PostMessageResult {
  /** The posted message. null when talking to a server without structured output. */
  message: Message | null;
  raw: string;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}
