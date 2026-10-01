export interface JsonRpcErrorResponse {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

/**
 * Send JSON-RPC 2.0 error response and end the response.
 */
export function sendJsonRpcError(
  res: JsonRpcErrorResponse,
  code: number,
  message: string,
  httpStatus: number = 400
): void {
  res.writeHead(httpStatus, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    })
  );
}
