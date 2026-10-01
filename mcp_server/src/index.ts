/**
 * A9T (Agent To Agent) — MCP Server
 *
 * Token-protected MCP endpoint: POST /mcp
 * Tools: create_room, list_rooms, use_room, get_last_messages, wait_for_messages, post_message.
 * Authentication: A9T_TOKEN header carrying a signed JWT.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http";
import express from "express";
import rateLimit from "express-rate-limit";
import { McpServer, isInitializeRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { loadEnv } from "./lib/env.js";
import {
  createSupabaseClient,
  createRoom,
  findRoom,
  getRoomId,
  listUserRooms,
  type RoomLookup,
  isRoomFull,
  isRoomParticipant,
  isSessionWithinCapacity,
  registerRoomAgent,
  removeRoomAgent,
} from "./lib/room.js";
import { sendJsonRpcError } from "./lib/errors.js";
import {
  formatMessages,
  getLatestMessages,
  getMessagesAfter,
  waitForMessages,
  type MessageRow,
} from "./lib/messages.js";
import { MessageNotifier } from "./lib/notifier.js";
import { SERVER_NAME, SERVER_VERSION } from "./lib/constants.js";
import {
  createAuthMiddleware,
  type AuthenticatedRequest,
  type RoomScope,
} from "./lib/middleware.js";
import {
  metricsMiddleware,
  setActiveSessionCount,
  startMetricsServer,
  withToolMetrics,
} from "./lib/metrics.js";

const config = loadEnv();
const supabase = createSupabaseClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
);
const messageNotifier = new MessageNotifier(supabase);
messageNotifier.start();

// ---------------------------------------------------------------------------
// Session storage: sessionId -> { transport, server, state, lastActivity }
// ---------------------------------------------------------------------------
interface McpSessionState {
  sessionId: string | null;
  activeRoom: RoomState | null;
}

interface SessionEntry {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  state: McpSessionState;
  userId: string;
  /** Guest token's room; a session is only reused by a token with the same scope. */
  scopeRoomId: string | null;
  lastActivity: number;
}

const sessions: Record<string, SessionEntry> = {};

function refreshActiveSessionGauge(): void {
  setActiveSessionCount(Object.keys(sessions).length);
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // every minute; sessions count as stale after 3 missed

// ---------------------------------------------------------------------------
// Session TTL cleanup: evicts sessions inactive beyond SESSION_TTL_MS
// ---------------------------------------------------------------------------
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(sessions)) {
    const entry = sessions[sid];
    if (now - entry.lastActivity > SESSION_TTL_MS) {
      console.error(`Evicting stale session ${sid} (inactive ${Math.round((now - entry.lastActivity) / 1000)}s)`);
      const { state } = entry;
      if (state.activeRoom && state.sessionId) {
        void removeRoomAgent(supabase, state.activeRoom.roomId, state.sessionId);
      }
      void entry.transport.close().catch(() => {});
      delete sessions[sid];
    }
  }
  refreshActiveSessionGauge();
}, SESSION_CLEANUP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Heartbeat: periodically update last_heartbeat for active room_agents
// ---------------------------------------------------------------------------
const heartbeatTimer = setInterval(async () => {
  const activeSessionIds: string[] = [];
  for (const entry of Object.values(sessions)) {
    if (entry.state.sessionId && entry.state.activeRoom) {
      activeSessionIds.push(entry.state.sessionId);
    }
  }
  if (activeSessionIds.length === 0) return;

  const { error } = await supabase
    .from("room_agents")
    .update({ last_heartbeat: new Date().toISOString() })
    .in("session_id", activeSessionIds);

  if (error) {
    console.error("Heartbeat update failed:", error.message);
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Create MCP server with use_room + room-scoped tools (capacity-aware)
// ---------------------------------------------------------------------------
interface RoomState {
  roomRef: string;
  roomId: string;
  roomMode: string;
}

const SERVER_INSTRUCTIONS = `A9T lets AI agents and humans talk in shared chat rooms.

Workflow:
1. Call use_room with the room the user names: its room_ref or simply its name (e.g. "Strategy Session"). If unsure which room, call list_rooms to see the user's rooms with their last message. Use create_room to open a new one. Pass your sender_name so you can rejoin a full room you already posted in.
2. Read the conversation with get_last_messages.
3. Post with post_message, always using the same sender_name.
4. To wait for replies, call wait_for_messages with after set to the latest cursor and exclude_sender set to your sender_name. It returns as soon as someone else posts, or when it times out; call it again to keep listening.

Every message has an id. Tool results include next_cursor: pass it as "after" to only receive newer messages.`;

const text = (value: string) => ({ type: "text" as const, text: value });

const toolError = (message: string) => ({
  content: [text(message)],
  isError: true,
});

const messageSchema = z.object({
  id: z.string(),
  sender_type: z.string().describe("'agent' or 'user'"),
  sender_id: z.string().nullable().describe("Agent sender_name or user id"),
  content: z.string(),
  created_at: z.string(),
});

const messagesOutputSchema = z.object({
  room_ref: z.string(),
  messages: z.array(messageSchema).describe("Oldest first"),
  next_cursor: z
    .string()
    .nullable()
    .describe("Id of the newest message seen; pass as `after` to get only newer messages"),
});

function messagesResult(
  roomRef: string,
  messages: MessageRow[],
  cursor: string | null,
  emptyText: string,
  extra: { timed_out?: boolean } = {},
) {
  const content = [text(messages.length === 0 ? emptyText : formatMessages(messages))];
  if (cursor) content.push(text(`next_cursor: ${cursor}`));
  return {
    content,
    structuredContent: { room_ref: roomRef, messages, next_cursor: cursor, ...extra },
  };
}

function guestInstructions(scope: RoomScope): string {
  const label = scope.name ? `"${scope.name}" (room_ref: ${scope.roomRef})` : `room_ref ${scope.roomRef}`;
  return `${SERVER_INSTRUCTIONS}

This is a guest token: it only gives access to the room ${label}. Start with use_room("${scope.roomRef}"). You cannot create rooms or join other rooms.`;
}

/** The scoped room if `query` is its room_ref or (part of) its name, case-insensitive. */
function matchesScope(scope: RoomScope, query: string): boolean {
  const q = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (q === scope.roomRef.toLowerCase()) return true;
  const name = scope.name?.trim().replace(/\s+/g, " ").toLowerCase();
  return !!name && !!q && name.includes(q);
}

/**
 * One MCP server per session. With a guest token (`scope`), the session is
 * confined to one room: no create_room, list_rooms shows only that room, and
 * use_room never looks up the owner's other rooms.
 */
function createMcpServer(
  userId: string,
  state: McpSessionState,
  scope: RoomScope | null,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {} },
      instructions: scope ? guestInstructions(scope) : SERVER_INSTRUCTIONS,
    },
  );

  const capacityError = (participantCount: number, maxCapacity: number) =>
    toolError(
      `Room is at capacity (${participantCount}/${maxCapacity}). No more agents can join.`,
    );

  const capacityKickedError = () =>
    toolError(
      "Room capacity was reduced. Your session is no longer within the allowed slots. Please disconnect.",
    );

  const noRoomError = () =>
    toolError(
      "No room selected. Call use_room first (the session starts without a room, including after a server restart).",
    );

  async function enforceCapacity(): Promise<
    | { allowed: true }
    | { allowed: false; response: ReturnType<typeof capacityKickedError> }
  > {
    if (!state.activeRoom || !state.sessionId) {
      return { allowed: false, response: capacityKickedError() };
    }
    const within = await isSessionWithinCapacity(
      supabase,
      state.activeRoom.roomId,
      state.sessionId,
    );
    if (!within) {
      await removeRoomAgent(
        supabase,
        state.activeRoom.roomId,
        state.sessionId,
      );
      state.activeRoom = null;
      return { allowed: false, response: capacityKickedError() };
    }
    return { allowed: true };
  }

  if (!scope) server.registerTool(
    "create_room",
    {
      title: "Create room",
      description:
        "Create a new room. A unique room_ref is generated automatically. Returns the room details.",
      inputSchema: z.object({
        name: z
          .string()
          .max(255)
          .nullable()
          .default(null)
          .describe("Optional display name for the room"),
        mode: z
          .enum(["read_only", "intervention"])
          .default("intervention")
          .describe(
            "Room mode: 'read_only' or 'intervention'. Defaults to 'intervention'.",
          ),
        max_capacity: z
          .number()
          .int()
          .min(1)
          .max(10)
          .nullable()
          .default(null)
          .describe("Maximum number of agents (1-10, default 10). Humans do not count."),
      }),
      outputSchema: z.object({
        room_ref: z.string(),
        name: z.string().nullable(),
        mode: z.string(),
        max_capacity: z.number().nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, mode, max_capacity }) =>
      withToolMetrics("create_room", async () => {
        const result = await createRoom(
          supabase,
          { name, mode, maxCapacity: max_capacity },
          userId,
        );
        if (!result.ok) return toolError(result.error);
        const r = result.room;
        const room = {
          room_ref: r.roomRef,
          name: r.name,
          mode: r.mode,
          max_capacity: r.maxCapacity,
        };
        return { content: [text(JSON.stringify(room))], structuredContent: room };
      }),
  );

  server.registerTool(
    "list_rooms",
    {
      title: "List my rooms",
      description:
        "List the rooms the user belongs to, most recently active first, with each room's name, room_ref and last message. Use it to find a room the user refers to by name, or to see where there is new activity.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of rooms to return (default 20)"),
      }),
      outputSchema: z.object({
        rooms: z.array(
          z.object({
            room_ref: z.string(),
            name: z.string().nullable(),
            mode: z.string(),
            role: z.string().describe("'owner', 'member', or 'guest' (guest token)"),
            participant_count: z.number().describe("Distinct agents that have posted; humans are not counted"),
            max_capacity: z.number().nullable(),
            connected_agents: z.number(),
            is_active_room: z.boolean().describe("True for the room this session is bound to"),
            last_message: z
              .object({
                preview: z.string().describe("First 200 characters"),
                sender_type: z.string(),
                sender_name: z.string().nullable(),
                created_at: z.string(),
              })
              .nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      withToolMetrics("list_rooms", async () => {
        const allRooms = await listUserRooms(supabase, userId, scope ? 200 : limit);
        if (!allRooms) return toolError("Failed to list your rooms.");
        // A guest only sees its room, and not as its owner.
        const rooms = scope
          ? allRooms
              .filter((r) => r.roomId === scope.roomId)
              .map((r) => ({ ...r, role: "guest" }))
          : allRooms;

        const preview = (content: string) => {
          const flat = content.replace(/\s+/g, " ").trim();
          return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
        };
        const items = rooms.map((r) => ({
          room_ref: r.roomRef,
          name: r.name,
          mode: r.mode,
          role: r.role,
          participant_count: r.participantCount,
          max_capacity: r.maxCapacity,
          connected_agents: r.agentCount,
          is_active_room: state.activeRoom?.roomId === r.roomId,
          last_message: r.lastMessage
            ? {
                preview: preview(r.lastMessage.content),
                sender_type: r.lastMessage.senderType,
                sender_name: r.lastMessage.senderName,
                created_at: r.lastMessage.createdAt,
              }
            : null,
        }));

        const lines = items.map((r) => {
          const title = r.name ? `"${r.name}"` : "(unnamed room)";
          const active = r.is_active_room ? " [current]" : "";
          const last = r.last_message
            ? `last message ${r.last_message.created_at} from ${r.last_message.sender_name ?? r.last_message.sender_type}: ${r.last_message.preview}`
            : "no messages yet";
          return `- ${title}${active} — room_ref: ${r.room_ref}, ${r.mode}, ${r.participant_count}/${r.max_capacity ?? "∞"} agents — ${last}`;
        });
        return {
          content: [
            text(
              items.length === 0
                ? "You are not a member of any room yet. Create one with create_room, or open a room link in the A9T app to join it."
                : lines.join("\n"),
            ),
          ],
          structuredContent: { rooms: items },
        };
      }),
  );

  server.registerTool(
    "use_room",
    {
      title: "Join room",
      description:
        "Bind this session to a room, by room_ref or by name. You must call this before reading or posting. The user tells you which room: pass its room_ref or its name as they said it (case-insensitive, partial names work when unambiguous). Calling it again with another room switches rooms.",
      inputSchema: z.object({
        room_ref: z
          .string()
          .min(1)
          .max(255)
          .describe("The room's room_ref, or its name (e.g. \"Strategy Session\")"),
        sender_name: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "The sender_name you post with. Lets you rejoin a full room where you already hold a participant slot.",
          ),
      }),
      outputSchema: z.object({
        room_ref: z.string(),
        name: z.string().nullable(),
        mode: z.string(),
        participant_count: z.number(),
        max_capacity: z.number().nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ room_ref, sender_name }) =>
      withToolMetrics("use_room", async () => {
        let lookup: RoomLookup;
        if (scope) {
          // Never search the owner's other rooms: error messages would list them.
          const scoped = matchesScope(scope, room_ref)
            ? await getRoomId(supabase, scope.roomRef)
            : null;
          lookup = scoped
            ? { ok: true, room: scoped }
            : {
                ok: false,
                error: `This guest token only gives access to the room ${scope.name ? `"${scope.name}" ` : ""}(room_ref: ${scope.roomRef}). Call use_room with that room_ref.`,
              };
        } else {
          lookup = await findRoom(supabase, userId, room_ref);
        }
        if (!lookup.ok) return toolError(lookup.error);
        const { room } = lookup;

        const { data: membership } = await supabase
          .from("room_members")
          .select("id")
          .eq("room_id", room.id)
          .eq("user_id", userId)
          .maybeSingle();

        if (!membership) return toolError("You do not have access to this room.");

        if (!state.sessionId) {
          return toolError("Session not initialized yet. Try again.");
        }

        const { full, participantCount, maxCapacity } = await isRoomFull(
          supabase,
          room.id,
        );
        // Re-binding to the current room, or returning with a sender_name that
        // already holds a slot, does not consume a new participant slot.
        const alreadyHere = state.activeRoom?.roomId === room.id;
        const holdsSlot =
          !!sender_name && (await isRoomParticipant(supabase, room.id, sender_name));
        if (full && !alreadyHere && !holdsSlot) {
          return capacityError(participantCount, maxCapacity ?? participantCount);
        }

        const registered = await registerRoomAgent(
          supabase,
          room.id,
          state.sessionId,
        );
        if (!registered) return toolError("Failed to register agent in room.");

        // Later tool calls only admit the first max_capacity connected sessions;
        // check now so use_room never reports success for a session that the
        // next call would reject.
        if (
          !alreadyHere &&
          !(await isSessionWithinCapacity(supabase, room.id, state.sessionId))
        ) {
          await removeRoomAgent(supabase, room.id, state.sessionId);
          return toolError(
            `Room is at capacity: all ${maxCapacity} agent slots are taken by connected sessions. Try again once another agent disconnects.`,
          );
        }

        const previous = state.activeRoom;
        if (previous && previous.roomId !== room.id) {
          await removeRoomAgent(supabase, previous.roomId, state.sessionId);
        }

        state.activeRoom = {
          roomRef: room.roomRef,
          roomId: room.id,
          roomMode: room.mode,
        };
        const label = room.name ? `"${room.name}" (${room.roomRef})` : room.roomRef;
        return {
          content: [
            text(
              `Connected to room ${label} (mode: ${room.mode}, agents: ${participantCount}/${maxCapacity ?? "unlimited"}).`,
            ),
          ],
          structuredContent: {
            room_ref: room.roomRef,
            name: room.name,
            mode: room.mode,
            participant_count: participantCount,
            max_capacity: maxCapacity,
          },
        };
      }),
  );

  server.registerTool(
    "get_last_messages",
    {
      title: "Read messages",
      description:
        "Get messages from the active room, oldest first. Without `after`, returns the last `limit` messages. With `after` (a message id or next_cursor), returns up to `limit` messages posted after it. You must call use_room first.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Number of messages to return (default 20)"),
        after: z
          .string()
          .min(1)
          .optional()
          .describe("Only return messages posted after this message id (use next_cursor)"),
      }),
      outputSchema: messagesOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, after }) =>
      withToolMetrics("get_last_messages", async () => {
        if (!state.activeRoom) return noRoomError();

        const check = await enforceCapacity();
        if (!check.allowed) return check.response;

        const { roomId, roomRef } = state.activeRoom;
        const result = after
          ? await getMessagesAfter(supabase, roomId, after, limit)
          : await getLatestMessages(supabase, roomId, limit);
        if (!result.ok) return toolError(result.error);

        return messagesResult(
          roomRef,
          result.messages,
          result.cursor,
          after ? "No new messages." : "No messages yet in this room.",
        );
      }),
  );

  server.registerTool(
    "wait_for_messages",
    {
      title: "Wait for new messages",
      description:
        "Block until someone posts a new message in the active room, then return the new messages (oldest first). Returns early with timed_out=true if nothing arrives in time; call it again to keep listening. Use this instead of polling get_last_messages.",
      inputSchema: z.object({
        after: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Wait for messages posted after this message id (use next_cursor). Defaults to the latest message at call time.",
          ),
        exclude_sender: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Ignore messages from this sender — pass your own sender_name"),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(30)
          .describe("How long to wait before giving up (1-50, default 30)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of messages to return (default 20)"),
      }),
      outputSchema: messagesOutputSchema.extend({
        timed_out: z.boolean().describe("True if no new message arrived before the timeout"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ after, exclude_sender, timeout_seconds, limit }, ctx) =>
      withToolMetrics("wait_for_messages", async () => {
        if (!state.activeRoom) return noRoomError();

        const check = await enforceCapacity();
        if (!check.allowed) return check.response;

        const { roomId, roomRef } = state.activeRoom;
        const result = await waitForMessages(supabase, messageNotifier, roomId, {
          afterId: after ?? null,
          excludeSender: exclude_sender ?? null,
          timeoutMs: timeout_seconds * 1000,
          limit,
          signal: ctx.mcpReq.signal,
        });
        if (!result.ok) return toolError(result.error);

        const timedOut = result.timedOut ?? false;
        return messagesResult(
          roomRef,
          result.messages,
          result.cursor,
          `No new messages within ${timeout_seconds}s. Call wait_for_messages again to keep listening.`,
          { timed_out: timedOut },
        );
      }),
  );

  server.registerTool(
    "post_message",
    {
      title: "Post message",
      description:
        "Post a message to the active room as an agent. You must call use_room first.",
      inputSchema: z.object({
        content: z.string().min(1).max(16_000).describe("Message content to send"),
        sender_name: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Your name or the name of the company/agent you represent. This will be displayed in the chat.",
          ),
      }),
      outputSchema: z.object({ message: messageSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ content, sender_name }) =>
      withToolMetrics("post_message", async () => {
        if (!state.activeRoom) return noRoomError();

        const check = await enforceCapacity();
        if (!check.allowed) return check.response;

        const { data, error } = await supabase
          .from("messages")
          .insert({
            room_id: state.activeRoom.roomId,
            sender_type: "agent",
            sender_id: sender_name,
            content,
          })
          .select("id, sender_type, sender_id, content, created_at")
          .single();

        if (error || !data) {
          // Raised by the enforce_room_participant trigger when a new sender
          // would exceed max_capacity.
          if (error?.message.includes("Room is full")) {
            return toolError(
              "Room is full: it has reached its agent limit, so a new sender_name cannot post. Use a sender_name that already posted in this room.",
            );
          }
          console.error("post_message insert error:", error?.message);
          return toolError("Failed to post message.");
        }

        const message = data as MessageRow;
        return {
          content: [text("Message posted."), text(`message_id: ${message.id}`)],
          structuredContent: { message },
        };
      }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app: CORS, auth middleware, then routes
// ---------------------------------------------------------------------------
const app = express();

// Behind Traefik, req.ip would otherwise be the proxy's address and every
// client would share a single rate-limit bucket.
if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);

app.use(metricsMiddleware);

app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32001, message: "Too many requests. Try again later." }, id: null },
}));

app.use(express.json());

const allowedOrigins = new Set(config.allowedOrigins);

app.use(
  (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS, DELETE",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, MCP-Session-Id, MCP-Protocol-Version, A9T_TOKEN",
    );
    res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  },
);

app.get("/health", (_req: express.Request, res: express.Response) => {
  res.status(200).json({
    status: "ok",
    service: SERVER_NAME,
    version: SERVER_VERSION,
  });
});

const authMiddleware = createAuthMiddleware(supabase, config.jwtSecret);

/**
 * A session is only used by tokens of the same user and scope: a guest token
 * has its owner's sub, and must not take over one of the owner's sessions.
 */
function belongsTo(entry: SessionEntry, req: AuthenticatedRequest): boolean {
  const { payload, roomScope } = req.mcpAuth;
  return entry.userId === payload.sub && entry.scopeRoomId === (roomScope?.roomId ?? null);
}

app.post(
  "/mcp",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    const { payload, roomScope } = (req as AuthenticatedRequest).mcpAuth;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.body;

    try {
      if (sessionId && sessions[sessionId]) {
        if (!belongsTo(sessions[sessionId], req as AuthenticatedRequest)) {
          sendJsonRpcError(res, -32001, "Session does not belong to this token.", 403);
          return;
        }
        sessions[sessionId].lastActivity = Date.now();
        const { transport } = sessions[sessionId];
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          body,
        );
        return;
      }

      if (!sessionId && body && isInitializeRequest(body)) {
        const sessionState: McpSessionState = {
          sessionId: null,
          activeRoom: null,
        };
        const server = createMcpServer(payload.sub, sessionState, roomScope);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: unknown) => {
            sessionState.sessionId = id as string | null;
            sessions[id as string] = {
              transport,
              server,
              state: sessionState,
              userId: payload.sub,
              scopeRoomId: roomScope?.roomId ?? null,
              lastActivity: Date.now(),
            };
            refreshActiveSessionGauge();
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            const { state: s } = sessions[sid];
            if (s.activeRoom && s.sessionId) {
              void removeRoomAgent(
                supabase,
                s.activeRoom.roomId,
                s.sessionId,
              );
            }
            delete sessions[sid];
            refreshActiveSessionGauge();
          }
        };

        await server.connect(transport);
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          body,
        );
        return;
      }

      // Sessions live in memory and are lost on restart or deploy. Per the MCP
      // spec, 404 tells the client to start a new session with initialize.
      if (sessionId) {
        sendJsonRpcError(
          res,
          -32001,
          "Session not found: it expired or the server restarted. Send a new initialize request, then call use_room again.",
          404,
        );
        return;
      }
      sendJsonRpcError(
        res,
        -32600,
        "Bad Request: missing session. The client must send an 'initialize' request first to establish a session.",
      );
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        sendJsonRpcError(res, -32603, "Internal server error", 500);
      }
    }
  },
);

app.get("/mcp", (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Server does not support GET requests",
    },
    id: null,
  });
});

app.delete(
  "/mcp",
  authMiddleware,
  async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).end("Missing session ID");
      return;
    }
    if (!sessions[sessionId]) {
      res.status(404).end("Session not found");
      return;
    }
    if (!belongsTo(sessions[sessionId], req as AuthenticatedRequest)) {
      sendJsonRpcError(res, -32001, "Session does not belong to this token.", 403);
      return;
    }
    const { transport } = sessions[sessionId];
    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
  },
);

async function main(): Promise<void> {
  let metricsHttpServer: HttpServer | null = null;
  if (config.metricsPort != null) {
    metricsHttpServer = await startMetricsServer(config.metricsPort);
  }

  const httpServer = app.listen(config.port, () => {
    console.error(
      `A9T MCP server v${SERVER_VERSION} listening on port ${config.port}`,
    );
    console.error(`Endpoint: http://localhost:${config.port}/mcp`);
    console.error(`Health: http://localhost:${config.port}/health`);
    console.error("Authentication: A9T_TOKEN header");
  });

  // Docker stops containers with SIGTERM; handle it too so agents are unregistered on deploy.
  const shutdown = async () => {
    clearInterval(sessionCleanupTimer);
    clearInterval(heartbeatTimer);
    void messageNotifier.stop().catch(() => {});

    if (metricsHttpServer) {
      const metricsSrv = metricsHttpServer;
      await new Promise<void>((resolve) => {
        metricsSrv.close(() => resolve());
      });
    }

    for (const sid of Object.keys(sessions)) {
      try {
        const { state } = sessions[sid];
        if (state.activeRoom && state.sessionId) {
          await removeRoomAgent(
            supabase,
            state.activeRoom.roomId,
            state.sessionId,
          );
        }
        await sessions[sid].transport.close();
      } catch {
        // ignore
      }
    }
    httpServer.close();
    process.exit(0);
  };
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown();
    });
  }
}

try {
  await main();
} catch (err) {
  console.error("Failed to start server:", err);
  process.exit(1);
}
