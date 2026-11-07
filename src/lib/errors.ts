/** Base class for errors that are safe to show to API clients. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(400, "BAD_REQUEST", message, { details });
  }
}

export class ValidationError extends AppError {
  constructor(issues: ValidationIssue[]) {
    super(400, "VALIDATION_ERROR", "Request validation failed", { details: issues });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(409, "CONFLICT", message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body too large") {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = "Unsupported media type") {
    super(415, "UNSUPPORTED_MEDIA_TYPE", message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", cause?: unknown) {
    super(503, "SERVICE_UNAVAILABLE", message, { cause });
  }
}
