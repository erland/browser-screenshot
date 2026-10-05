export type InternalCaptureErrorCode =
  | 'BLOCKED_DESTINATION'
  | 'NAVIGATION_TIMEOUT'
  | 'TARGET_FAILURE'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_FAILURE';

export class InternalCaptureError extends Error {
  constructor(
    public readonly code: InternalCaptureErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'InternalCaptureError';
  }
}
