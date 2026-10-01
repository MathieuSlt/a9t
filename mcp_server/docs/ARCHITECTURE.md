# A9T MCP Server — Technical Architecture

This document describes how the MCP server works, step by step, from startup to request handling, authentication, session management, and tool execution.

---

## 1. Overview

The server is an **HTTP MCP (Model Context Protocol) server** that exposes room tools (`create_room`, `list_rooms`, `use_room`, `get_last_messages`, `wait_for_messages`, `post_message`) to MCP clients (e.g. Cursor, Claude Code). Each logical “session” is bound to a **room** identified by `room_ref` in the URL. Access is **token-protected**: every request must carry a valid shared secret.

- **Protocol**: MCP over **Streamable HTTP** (JSON-RPC 2.0 over POST, with optional GET/DELETE for transport lifecycle).
- **Transport**: `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` (MCP TypeScript SDK v2; `McpServer` comes from `@modelcontextprotocol/server`).
- **Auth**: Shared secret in `Authorization: Bearer <token>` or `X-MCP-Token: <token>`.
- **Data**: Supabase (Postgres) for `rooms` and `messages`.

---

## 2. Startup Sequence

### 2.1 Load environment (`dotenv` + `loadEnv()`)

1. **`import "dotenv/config"`** runs first and loads `.env` into `process.env`.
2. **`loadEnv()`** (in `src/lib/env.ts`) runs immediately at module load:
   - **Required env vars** (process exits if missing or empty):
     - `SUPABASE_URL` — Supabase project URL.
     - `SUPABASE_SERVICE_ROLE_KEY` — Service role key for server-side Supabase client.
     - `JWT_SECRET` — Shared secret (min 32 chars) used to verify MCP JWTs; must match the app’s `JWT_SECRET`.
   - **Optional**:
     - `PORT` — Parsed as integer; must be in 1–65535. Default: `4010` (from `src/lib/constants.ts`).
3. **Port validation**: If `PORT` is not a valid integer in range, the process logs an error and exits.

Result: a single **`config`** object (`EnvConfig`) used for the rest of the process lifetime.

### 2.2 Supabase client

- **`createSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey)`** (in `src/lib/room.ts`) creates a single Supabase client with:
  - `auth: { persistSession: false }` — no session persistence (service role only).
- This client is used for:
  - Resolving `room_ref` → `(id, mode)` from the `rooms` table.
  - Reading/writing `messages` inside tool handlers.

### 2.3 Express app and middleware

1. **`express()`** + **`express.json()`** — body parser for JSON request bodies.
2. **CORS middleware** (runs on every request):
   - Sets `Access-Control-Allow-Origin: *`, allows methods `GET, POST, OPTIONS, DELETE`, and headers `Content-Type`, `MCP-Session-Id`, `MCP-Protocol-Version`, `Authorization`, `X-MCP-Token`.
   - Exposes `MCP-Session-Id` via `Access-Control-Expose-Headers`.
   - For **OPTIONS** requests, responds with `200` and does not continue to route handlers.

### 2.4 Route registration

- **POST /mcp** — Main MCP endpoint: token check, then session lookup or new session creation (see below).
- **GET /mcp** — Returns `405` with a JSON-RPC-style body: *"Server does not support GET requests"*.
- **DELETE /mcp** — Token check, then delegates to the transport for session teardown (requires valid `MCP-Session-Id`).

### 2.5 Listen and shutdown

- **`app.listen(config.port)`** binds the HTTP server.
- **SIGINT** handler closes all active transports (cleaning up the in-memory `sessions` map), closes the HTTP server, and exits.

---

## 3. Request Flow (High Level)

```
HTTP Request
    → CORS middleware (set headers; OPTIONS → 200)
    → Route: GET /mcp → 405
    → Route: POST /mcp → auth → session logic → transport.handleRequest
    → Route: DELETE /mcp → auth → session lookup → transport.handleRequest
```

For **POST /mcp** and **DELETE /mcp**, authentication runs first; only then does session or transport handling run.

---

## 4. Authentication (Token)

### 4.1 When it runs

- **POST /mcp** and **DELETE /mcp**: before any session lookup or MCP handling.
- **GET /mcp**: no auth (request is immediately answered with 405).

### 4.2 Token extraction (`src/lib/auth.ts`)

1. **`extractToken(req)`** tries, in order:
   - **Authorization** header: if it starts with `"Bearer "`, the remainder (trimmed) is the token.
   - **X-MCP-Token** header: value (trimmed) as token.
2. If neither is present or both are empty after trim, **no token** is returned.

### 4.3 Token validation

1. **`validateToken(req, config.jwtSecret)`** (async):
   - Calls `extractToken(req)`.
   - If no token: returns `{ valid: false, message: "Authentication required. Provide Authorization: Bearer <token> or X-MCP-Token header." }`.
   - If token present: verifies it as a JWT with `jwtVerify` (jose), using `config.jwtSecret`, issuer `a9t-mcp`, audience `a9t-mcp-server`. Payload must include `sub` (user id) and `jti`.
   - If invalid or expired: returns `{ valid: false, message: "Invalid or expired token." }`.
   - If valid: returns `{ valid: true, payload: { sub, email?, jti } }`.
2. **Revocation check**: If `payload.jti` is present, the server checks the `mcp_tokens` table (via service role) for a row with that `jti` and `revoked_at` null. If no such row, the request is rejected with "Token has been revoked."

### 4.4 Response when auth fails

- Handler calls **`sendJsonRpcError(res, -32001, auth.message, 401)`**.
- HTTP status **401**, body:  
  `{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "…" }, "id": null }`.
- Request ends; no MCP processing.

---

## 5. POST /mcp — Session and MCP Handling

After passing auth, POST /mcp behaves as follows.

### 5.1 Session identification

- **Session ID** is taken from the request header **`MCP-Session-Id`** (if present).
- **In-memory store**: `sessions: Record<string, { transport, server }>` maps session ID → transport and MCP server instance.

### 5.2 Case A: Known session

- If **`sessionId`** is present and **`sessions[sessionId]`** exists:
  - The request is treated as belonging to an existing MCP session.
  - **`transport.handleRequest(req, res, body)`** is called with the stored transport and the current `req`, `res`, and parsed `body`.
  - No room lookup, no new server/transport creation.
  - Flow ends.

### 5.3 Case B: New session (initialize)

A new session is created **only** when **all** of the following hold:

1. **No session ID** in the request (or no matching session).
2. Request **body** is present and is an MCP **initialize** request: `body.method === "initialize"`.
3. **room_ref** is present in the URL query (e.g. `/mcp?room_ref=abc123`).

Steps:

1. **Extract `room_ref`** from the request URL (`getRoomRefFromRequest(req)`).
2. If **`room_ref` is missing**: respond with **400** and JSON-RPC error code **-32600**: *"Missing room_ref in URL. Use /mcp?room_ref=<ROOM_REF>"*. Stop.
3. **Resolve room**: **`getRoomId(supabase, roomRef)`**:
   - Queries Supabase `rooms` table: `select id, mode where room_ref = roomRef`, `.single()`.
   - Returns `{ id, mode }` or `null` if not found or error.
4. If **room not found**: respond with **404** and JSON-RPC error code **-32602**: *"Room not found for this room_ref."*. Stop.
5. **Create room-scoped MCP server**: **`createRoomMcpServer(roomRef, room.id, room.mode)`**:
   - Instantiates a new **`McpServer`** with name `"a9t"` and version from `package.json`.
   - Registers two tools (see section 7) that use the **same global Supabase client** and the resolved **`roomId`** (and `roomMode` if needed later). `roomRef` is only for context.
   - Returns the **McpServer** instance.
6. **Create transport**: **`NodeStreamableHTTPServerTransport`** with:
   - **sessionIdGenerator**: `() => randomUUID()` so the transport produces a new session ID.
   - **onsessioninitialized(id)**: stores `{ transport, server }` in **`sessions[id]`**.
7. **Cleanup on close**: set **`transport.onclose`** so that when the transport closes, **`sessions[transport.sessionId]`** is deleted.
8. **Connect**: **`server.connect(transport)`**.
9. **Handle current request**: **`transport.handleRequest(req, res, body)`** — the same initialize request is processed by the new transport; the transport will assign the new session ID and include it in the response (e.g. in headers or body as per MCP Streamable HTTP).
10. Flow ends.

### 5.4 Case C: Invalid or incomplete request

- If there is **no session ID** (or unknown session) and the body is **not** an initialize request, or **`room_ref`** was not in the URL for an initialize:
  - Respond with **400** and JSON-RPC error **-32600**: *"Bad Request: missing or invalid session. Connect with ?room_ref=<ROOM_REF> first."*

### 5.5 Errors during handling

- Any **thrown exception** in the try block is caught:
  - Logged with **`console.error("MCP request error:", err)`**.
  - If **headers not yet sent**, respond with **500** and JSON-RPC error **-32603**: *"Internal server error"*.

---

## 6. DELETE /mcp — Session teardown

1. **Auth**: same token check as POST; on failure, 401 and stop.
2. **Session ID**: from **`MCP-Session-Id`** header.
3. If **no session ID** or **unknown session**: respond with **400** and body *"Invalid or missing session ID"* (plain text).
4. Otherwise: **`transport.handleRequest(req, res)`** for the stored transport (MCP uses this for closing/cleaning the session). The transport’s **onclose** will remove the entry from **`sessions`**.

---

## 7. MCP server and tools

**`createMcpServer(userId, state)`** creates one **McpServer** per session (with `instructions` describing the workflow) and registers six tools. Tools share the global Supabase client and the per-session `state` (`sessionId`, `activeRoom`). Every tool declares an `outputSchema` and returns `structuredContent` alongside text; error results (`isError: true`) carry text only.

### 7.1 `create_room`
Inserts a room owned by the token's user; returns `room_ref`, `name`, `mode`, `max_capacity`.

### 7.1b `list_rooms`
Calls the `list_user_rooms(user_id, limit)` RPC (service_role only): the user's rooms, most recently active first, each with its last message (human senders resolved to display names). Returns names, room_refs, counts, `is_active_room` and a 200-character preview.

### 7.2 `use_room`
Resolves the room (`findRoom` in `src/lib/room.ts`): exact `room_ref` first, then among the user's rooms an exact case-insensitive name, then a unique partial name; ambiguous names return the candidates. Then checks the room exists and the user is a member, then capacity: a new participant is refused when `participant_count >= max_capacity`, unless the session is re-binding its current room or passes a `sender_name` that already holds a slot (`room_participants`). It then registers the session in `room_agents` and refuses it if it is not among the first `max_capacity` connected sessions, so later calls never kick a session that `use_room` accepted. Switching rooms unregisters the session from the previous room.

### 7.3 `get_last_messages`
Without `after`: the last `limit` messages, returned oldest first. With `after` (a message id): up to `limit` messages created after it. Returns `messages` (with ids) and `next_cursor`.

### 7.4 `wait_for_messages`
Long poll (`src/lib/messages.ts`): resolves the cursor (`after`, or the latest message at call time), then reads newer messages each time the Realtime `MessageNotifier` reports an insert in the room (every 15 s as a safety net, every 1.5 s while Realtime is down), ignoring `exclude_sender`, until one arrives, `timeout_seconds` (≤ 50, below proxy and client timeouts) elapses, or the request is cancelled (`ctx.mcpReq.signal`, e.g. the client sends `notifications/cancelled`).

### 7.5 `post_message`
Inserts the message and returns it (with its id). The `enforce_room_participant` trigger rejects a new `sender_name` once the room is full; that error is reported as *"Room is full…"*.

---

## 8. Session lifecycle summary

- **Create**: First **POST /mcp** with **initialize** and **`room_ref`** in URL, valid token → new transport + room-bound server, session ID generated and stored in **`sessions`**.
- **Use**: Subsequent **POST /mcp** with same **`MCP-Session-Id`** → request forwarded to existing transport; tools run in the same room context.
- **End**: **DELETE /mcp** with same **`MCP-Session-Id`** (and valid token) → transport handles close; **onclose** removes session from **`sessions`**.

The **room** is fixed at session creation; all tool calls in that session operate on the same **roomId**.

---

## 9. Error responses (JSON-RPC)

All application-level errors use **`sendJsonRpcError(res, code, message, httpStatus)`** in **`src/lib/errors.ts`**:

- **HTTP**: `httpStatus` (e.g. 400, 401, 404, 500).
- **Body**:  
  `{ "jsonrpc": "2.0", "error": { "code": <code>, "message": "<message>" }, "id": null }`.

Used codes:

- **-32000** — Method not allowed (e.g. GET /mcp).
- **-32001** — Unauthorized (missing or invalid token).
- **-32600** — Invalid request (e.g. missing `room_ref`, bad session).
- **-32602** — Room not found.
- **-32603** — Internal server error.

---

## 10. File and module roles

| Path | Role |
|------|------|
| **src/index.ts** | Entry point: load env, create Supabase client, define sessions map, Express app, POST/GET/DELETE /mcp, createRoomMcpServer, listen, SIGINT. |
| **src/lib/constants.ts** | Server name, version (from package.json), default port, env var name constants. |
| **src/lib/env.ts** | `loadEnv()`: validate and load PORT, SUPABASE_*, JWT_SECRET (min 32 chars); exit on failure. |
| **src/lib/auth.ts** | `extractToken(req)`, `validateToken(req, jwtSecret)` — JWT verify (jose), returns `{ valid, message?, payload? }`. |
| **src/lib/room.ts** | `createSupabaseClient()`, `getRoomId(supabase, roomRef)` → `{ id, mode } \| null`. |
| **src/lib/errors.ts** | `sendJsonRpcError(res, code, message, httpStatus)` for JSON-RPC error payload. |

---

## 11. Data model (Supabase)

- **rooms**: at least `id`, `room_ref`, `mode`. Used to resolve `room_ref` → `id` (and `mode`) for session binding.
- **messages**: at least `id`, `room_id`, `sender_type`, `sender_id`, `content`, `created_at`. Read in `get_last_messages`, written in `post_message`.

---

This architecture gives you a clear, step-by-step view of how the server starts, how each request is authenticated and routed, how sessions and rooms are bound, and how the two MCP tools interact with Supabase.
