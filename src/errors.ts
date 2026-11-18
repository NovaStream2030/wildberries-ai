export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly detail?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    type: "invalid_request_error" | "upstream_error" | "server_error" = "invalid_request_error",
    detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.detail = detail;
  }
}

export function errorBody(err: ApiError) {
  return {
    error: {
      message: err.detail ? `${err.message}: ${err.detail}` : err.message,
      type: err.type,
      param: null,
      code: err.code,
    },
  };
}

export function errorResponse(err: unknown): Response {
  const api =
    err instanceof ApiError
      ? err
      : new ApiError(500, "internal_error", "Internal server error", "server_error", String(err));
  return Response.json(errorBody(api), {
    status: api.status,
    headers: { "cache-control": "no-store" },
  });
}

export function sseError(err: ApiError): string {
  return `data: ${JSON.stringify(errorBody(err))}\n\n`;
}
