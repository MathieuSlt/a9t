import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateToken, type McpTokenPayload } from "./auth.js";
import { sendJsonRpcError } from "./errors.js";

/** The only room a guest token (mcp_tokens.room_id) may use. */
export interface RoomScope {
  roomId: string;
  roomRef: string;
  name: string | null;
}

export interface AuthenticatedRequest extends Request {
  mcpAuth: {
    payload: McpTokenPayload;
    tokenRowId: string | null;
    /** Set for guest tokens; null for personal tokens. */
    roomScope: RoomScope | null;
  };
}

/**
 * Express middleware that validates the JWT, checks revocation against
 * mcp_tokens, and updates last_used_at. Attaches the validated payload
 * to `req.mcpAuth` for downstream handlers.
 */
export function createAuthMiddleware(
  supabase: SupabaseClient,
  jwtSecret: string,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = await validateToken(req, jwtSecret);
    if (!auth.valid) {
      sendJsonRpcError(res, -32001, auth.message ?? "Unauthorized", 401);
      return;
    }

    let tokenRowId: string | null = null;
    let roomScope: RoomScope | null = null;

    if (auth.payload?.jti) {
      const { data } = await supabase
        .from("mcp_tokens")
        .select("id, room_id, rooms(room_ref, name)")
        .eq("jti", auth.payload.jti)
        .is("revoked_at", null)
        .maybeSingle();

      // A guest token's row is deleted with its room.
      if (!data) {
        sendJsonRpcError(res, -32001, "Token has been revoked.", 401);
        return;
      }
      tokenRowId = data.id;
      if (data.room_id) {
        const room = (Array.isArray(data.rooms) ? data.rooms[0] : data.rooms) as
          | { room_ref: string; name: string | null }
          | null
          | undefined;
        if (!room) {
          sendJsonRpcError(res, -32001, "Token has been revoked.", 401);
          return;
        }
        roomScope = { roomId: data.room_id, roomRef: room.room_ref, name: room.name };
      }
    }

    if (tokenRowId) {
      supabase
        .from("mcp_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", tokenRowId)
        .then(({ error }) => {
          if (error) {
            console.error(
              "Failed to update mcp_tokens last_used_at:",
              error.message,
            );
          }
        });
    }

    if (!auth.payload) {
      sendJsonRpcError(res, -32001, "Invalid token payload.", 401);
      return;
    }

    const authenticatedReq = req as AuthenticatedRequest;
    authenticatedReq.mcpAuth = {
      payload: auth.payload,
      tokenRowId,
      roomScope,
    };

    next();
  };
}
