import type { Request } from "express";
import { jwtVerify } from "jose";

const HEADER_A9T_TOKEN = "a9t_token";

const JWT_ISSUER = "a9t-mcp";
const JWT_AUDIENCE = "a9t-mcp-server";

function extractSingleHeader(
  value: string | string[] | undefined
): string | undefined {
  if (!value) return undefined;
  const s = typeof value === "string" ? value : value[0];
  return s?.trim() || undefined;
}

/**
 * Extract token from the A9T_TOKEN header.
 */
export function extractToken(req: Request): string | undefined {
  return extractSingleHeader(req.headers[HEADER_A9T_TOKEN]);
}

export interface McpTokenPayload {
  sub: string;
  email?: string;
  jti: string;
}

export interface AuthResult {
  valid: boolean;
  message?: string;
  payload?: McpTokenPayload;
}

/**
 * Validate that the request carries a valid JWT signed with the shared secret.
 * Returns validation result and decoded payload (sub = user_id, email, jti).
 */
export async function validateToken(
  req: Request,
  jwtSecret: string
): Promise<AuthResult> {
  const token = extractToken(req);
  if (!token) {
    return {
      valid: false,
      message:
        "Authentication required. Provide A9T_TOKEN header.",
    };
  }

  try {
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const sub = payload.sub;
    const jti = payload.jti;

    if (typeof sub !== "string" || !sub) {
      return { valid: false, message: "Invalid token: missing sub." };
    }
    if (typeof jti !== "string" || !jti) {
      return { valid: false, message: "Invalid token: missing jti." };
    }

    return {
      valid: true,
      payload: {
        sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        jti,
      },
    };
  } catch {
    return { valid: false, message: "Invalid or expired token." };
  }
}
