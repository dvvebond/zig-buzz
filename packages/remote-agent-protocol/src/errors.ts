export type RemoteProtocolErrorCode =
  | "AUTH_REQUIRED"
  | "CAPABILITY_DENIED"
  | "CONFIG_INVALID"
  | "DEPLOYMENT_NOT_FOUND"
  | "ENROLLMENT_EXPIRED"
  | "ENROLLMENT_INVALID"
  | "ENROLLMENT_USED"
  | "MESSAGE_EXPIRED"
  | "MESSAGE_TOO_LARGE"
  | "OWNER_APPROVAL_REQUIRED"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "RATE_LIMITED"
  | "RECIPIENT_MISMATCH"
  | "REPLAY_DETECTED"
  | "SECRET_REFERENCE_MISSING"
  | "SENDER_MISMATCH"
  | "SEQUENCE_INVALID"
  | "SIGNATURE_INVALID"
  | "TAG_INVALID";

export class RemoteProtocolError extends Error {
  public readonly code: RemoteProtocolErrorCode;

  public constructor(code: RemoteProtocolErrorCode, message: string) {
    super(message);
    this.name = "RemoteProtocolError";
    this.code = code;
  }
}
