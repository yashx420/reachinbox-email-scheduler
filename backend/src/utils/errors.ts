/** An error that is safe to render to the client, with an HTTP status attached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'Not allowed'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, 'conflict', message);
  }
  static unavailable(message: string): ApiError {
    return new ApiError(503, 'service_unavailable', message);
  }
}
