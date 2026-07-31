export type MediaErrorCode =
  | "AUTHENTICATION_FAILED"
  | "INSUFFICIENT_SCOPE"
  | "HASH_MISMATCH"
  | "FILE_TOO_LARGE"
  | "DISALLOWED_CONTENT_TYPE"
  | "INVALID_CONTENT"
  | "NOT_FOUND"
  | "STORAGE_ERROR";

export class MediaError extends Error {
  public constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export function mediaError(code: MediaErrorCode, detail?: string): MediaError {
  if (code === "AUTHENTICATION_FAILED") {
    return new MediaError(code, "authentication failed", 401);
  }
  if (code === "INSUFFICIENT_SCOPE") {
    return new MediaError(
      code,
      detail ?? "insufficient authorization scope",
      403,
    );
  }
  if (code === "HASH_MISMATCH") {
    return new MediaError(
      code,
      "authorization does not match the uploaded bytes",
      403,
    );
  }
  if (code === "FILE_TOO_LARGE") {
    return new MediaError(
      code,
      detail ?? "file exceeds the configured size limit",
      413,
    );
  }
  if (code === "DISALLOWED_CONTENT_TYPE" || code === "INVALID_CONTENT") {
    return new MediaError(code, detail ?? "file content is not accepted", 415);
  }
  if (code === "NOT_FOUND") return new MediaError(code, "not found", 404);
  return new MediaError(code, detail ?? "media storage failed", 500);
}
