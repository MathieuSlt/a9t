import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type {
  A9tClientOptions,
  CreateRoomParams,
  CreateRoomResult,
  GetMessagesOptions,
  GetMessagesResult,
  ListRoomsResult,
  Message,
  PostMessageResult,
  ToolTextContent,
  UseRoomOptions,
  UseRoomResult,
  WaitForMessagesOptions,
  WaitForMessagesResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.a9t.io";
const SDK_NAME = "a9t-sdk";
const SDK_VERSION = "0.2.0";

/** Extra time allowed on top of a wait_for_messages timeout before the request itself times out. */
const WAIT_REQUEST_MARGIN_MS = 15_000;

/** Delays between reconnect attempts, about one minute in total (long enough for a deploy). */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Tools that change nothing, so they are safe to resend after a network error. */
const SAFE_TO_RETRY = new Set(["list_rooms", "use_room", "get_last_messages", "wait_for_messages"]);

type Retry = "none" | "safe" | "all";

/**
 * How a failed request may be retried after reconnecting:
 * - "all": the server lost the session (restart or deploy), so it never ran the call;
 * - "safe": the network or the proxy failed, the call may have run;
 * - "none": any other error.
 */
function classifyError(error: unknown): Retry {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 404) return "all";
  // Servers before 2026-09 answered an unknown session with 400.
  if (status === 400 && /invalid or expired session/i.test(message)) return "all";
  if (status === 502 || status === 503 || status === 504) return "safe";
  if (error instanceof TypeError && /fetch failed|network/i.test(message)) return "safe";
  return "none";
}

/** A revoked or invalid token: reconnecting cannot help. */
function isAuthError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ToolResult {
  text: string;
  structured: Record<string, unknown> | undefined;
}

interface StructuredMessage {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  created_at: string;
}

interface StructuredMessages {
  messages: StructuredMessage[];
  next_cursor: string | null;
  timed_out?: boolean;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const item = content.find(
    (c: Record<string, unknown>) => c.type === "text"
  ) as ToolTextContent | undefined;
  return item?.text ?? "";
}

function toMessage(m: StructuredMessage): Message {
  return {
    id: m.id,
    timestamp: m.created_at,
    senderType: m.sender_type,
    senderId: m.sender_id ?? "",
    content: m.content,
  };
}

const MESSAGE_RE = /^\[(.+?)\]\s+(\S+?)(?:\s+\((.+?)\))?:\s+(.*)$/;

/**
 * Fallback for servers without structured output: parse the text transcript.
 * Lines that do not start a new message belong to the previous (multi-line) message.
 */
function parseMessages(raw: string): Message[] {
  if (!raw || raw.startsWith("No messages yet") || raw.startsWith("No new messages")) return [];
  const messages: Message[] = [];
  for (const line of raw.split("\n")) {
    const match = MESSAGE_RE.exec(line);
    const previous = messages.at(-1);
    if (!match && previous) {
      previous.content += `\n${line}`;
      continue;
    }
    messages.push(
      match
        ? {
            id: null,
            timestamp: match[1],
            senderType: match[2],
            senderId: match[3] ?? "",
            content: match[4],
          }
        : { id: null, timestamp: "", senderType: "", senderId: "", content: line }
    );
  }
  return messages;
}

function toMessagesResult(result: ToolResult): GetMessagesResult & { timedOut: boolean } {
  const structured = result.structured as StructuredMessages | undefined;
  if (structured && Array.isArray(structured.messages)) {
    return {
      messages: structured.messages.map(toMessage),
      nextCursor: structured.next_cursor ?? null,
      timedOut: structured.timed_out ?? false,
      raw: result.text,
    };
  }
  return { messages: parseMessages(result.text), nextCursor: null, timedOut: false, raw: result.text };
}

export class A9tClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private isConnected = false;
  private readonly autoReconnect: boolean;
  /** The last successful use_room call, replayed after a reconnect. */
  private activeRoom: Record<string, unknown> | null = null;
  private reconnecting: Promise<void> | null = null;
  /** True between connect() and disconnect(): a dropped session is reopened. */
  private wanted = false;

  constructor(options: A9tClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.autoReconnect = options.autoReconnect ?? true;
  }

  async connect(): Promise<void> {
    this.wanted = true;
    if (this.isConnected) return;

    this.client = new Client({ name: SDK_NAME, version: SDK_VERSION });

    this.transport = new StreamableHTTPClientTransport(
      new URL(`${this.baseUrl}/mcp`),
      {
        requestInit: {
          headers: { a9t_token: this.apiKey },
        },
      }
    );

    await this.client.connect(this.transport);
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.wanted = false;
    this.activeRoom = null;
    if (!this.isConnected) return;
    try {
      await this.client?.close();
    } finally {
      this.client = null;
      this.transport = null;
      this.isConnected = false;
    }
  }

  /**
   * Open a new session and bind it to the room used before, retrying for about
   * a minute. Concurrent callers share one reconnect.
   */
  private reconnect(): Promise<void> {
    this.reconnecting ??= (async () => {
      const room = this.activeRoom;
      try {
        await this.client?.close();
      } catch {
        // The old session is already gone on the server.
      }
      this.client = null;
      this.transport = null;
      this.isConnected = false;

      let lastError: unknown;
      for (const delay of [0, ...RECONNECT_DELAYS_MS]) {
        if (delay) await sleep(delay);
        try {
          await this.connect();
        } catch (error) {
          // The server is still down or restarting.
          if (isAuthError(error)) throw error;
          lastError = error;
          continue;
        }
        try {
          if (room) await this.invokeTool("use_room", room);
          this.activeRoom = room;
          return;
        } catch (error) {
          // e.g. the room was deleted or is now full.
          if (classifyError(error) === "none") throw error;
          lastError = error;
          await (this.client as Client | null)?.close().catch(() => {});
          this.isConnected = false;
        }
      }
      throw new Error(
        `Could not reconnect to the A9T server at ${this.baseUrl}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        { cause: lastError }
      );
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  private ensureConnected(): Client {
    if (!this.client || !this.isConnected) {
      throw new Error("Client is not connected. Call connect() first.");
    }
    return this.client;
  }

  /**
   * Call a tool. If the server lost the session (restart, deploy) or the
   * network failed, reconnect, rejoin the active room and retry once. Calls
   * that post or create are only retried when the server never ran them.
   */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ToolResult> {
    if (this.reconnecting) await this.reconnecting;
    // An earlier reconnect gave up; the server may be back.
    else if (!this.isConnected && this.wanted && this.autoReconnect) await this.reconnect();
    try {
      return await this.invokeTool(name, args, timeoutMs);
    } catch (error) {
      const retry = classifyError(error);
      if (!this.autoReconnect || retry === "none") throw error;
      await this.reconnect();
      if (retry === "safe" && !SAFE_TO_RETRY.has(name)) throw error;
      return this.invokeTool(name, args, timeoutMs);
    }
  }

  private async invokeTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ToolResult> {
    const client = this.ensureConnected();
    const result = await client.callTool(
      { name, arguments: args },
      timeoutMs === undefined ? undefined : { timeout: timeoutMs }
    );

    const text = extractText(result.content);

    if (result.isError) {
      throw new Error(text || `Tool "${name}" returned an error.`);
    }

    const structured = result.structuredContent as Record<string, unknown> | undefined;
    return { text, structured };
  }

  async createRoom(params: CreateRoomParams = {}): Promise<CreateRoomResult> {
    const { text: raw, structured } = await this.callTool("create_room", {
      name: params.name ?? null,
      mode: params.mode ?? "intervention",
      max_capacity: params.maxCapacity ?? null,
    });

    const parsed = (structured ?? JSON.parse(raw)) as {
      room_ref: string;
      name: string | null;
      mode: string;
      max_capacity: number | null;
    };

    return {
      roomRef: parsed.room_ref,
      name: parsed.name,
      mode: parsed.mode,
      maxCapacity: parsed.max_capacity,
      raw,
    };
  }

  /** Rooms the user belongs to, most recently active first, with their last message. */
  async listRooms(limit = 20): Promise<ListRoomsResult> {
    const { text: raw, structured } = await this.callTool("list_rooms", { limit });
    const rooms = ((structured as { rooms?: Record<string, unknown>[] } | undefined)?.rooms ?? []).map(
      (r) => {
        const last = r.last_message as Record<string, unknown> | null;
        return {
          roomRef: r.room_ref as string,
          name: (r.name as string | null) ?? null,
          mode: r.mode as string,
          role: r.role as string,
          participantCount: r.participant_count as number,
          maxCapacity: (r.max_capacity as number | null) ?? null,
          connectedAgents: r.connected_agents as number,
          isActiveRoom: r.is_active_room === true,
          lastMessage: last
            ? {
                preview: last.preview as string,
                senderType: last.sender_type as string,
                senderName: (last.sender_name as string | null) ?? null,
                createdAt: last.created_at as string,
              }
            : null,
        };
      }
    );
    return { rooms, raw };
  }

  /** Bind the session to a room, by room_ref or by name (case-insensitive, unambiguous partial names work). */
  async useRoom(roomRef: string, options: UseRoomOptions = {}): Promise<UseRoomResult> {
    const args: Record<string, unknown> = { room_ref: roomRef };
    if (options.senderName) args.sender_name = options.senderName;
    const { text: raw, structured } = await this.callTool("use_room", args);
    this.activeRoom = args;
    const room = structured as
      | {
          room_ref: string;
          name: string | null;
          mode: string;
          participant_count: number;
          max_capacity: number | null;
        }
      | undefined;
    return {
      roomRef: room?.room_ref ?? roomRef,
      name: room?.name ?? null,
      mode: room?.mode ?? null,
      participantCount: room?.participant_count ?? null,
      maxCapacity: room?.max_capacity ?? null,
      raw,
    };
  }

  async getMessages(limit = 20, options: GetMessagesOptions = {}): Promise<GetMessagesResult> {
    const args: Record<string, unknown> = { limit };
    if (options.after) args.after = options.after;
    const { messages, nextCursor, raw } = toMessagesResult(
      await this.callTool("get_last_messages", args)
    );
    return { messages, nextCursor, raw };
  }

  /**
   * Block until someone posts a new message (or the timeout elapses).
   * Pass the previous `nextCursor` as `after` and your sender name as
   * `excludeSender` to listen for replies in a loop.
   */
  async waitForMessages(options: WaitForMessagesOptions = {}): Promise<WaitForMessagesResult> {
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const args: Record<string, unknown> = { timeout_seconds: timeoutSeconds };
    if (options.after) args.after = options.after;
    if (options.excludeSender) args.exclude_sender = options.excludeSender;
    if (options.limit !== undefined) args.limit = options.limit;
    return toMessagesResult(
      await this.callTool(
        "wait_for_messages",
        args,
        timeoutSeconds * 1000 + WAIT_REQUEST_MARGIN_MS
      )
    );
  }

  async postMessage(content: string, senderName: string): Promise<PostMessageResult> {
    const { text: raw, structured } = await this.callTool("post_message", {
      content,
      sender_name: senderName,
    });
    const message = (structured as { message?: StructuredMessage } | undefined)?.message;
    return { message: message ? toMessage(message) : null, raw };
  }
}
