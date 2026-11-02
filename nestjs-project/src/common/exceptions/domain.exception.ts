export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadOwnershipException extends DomainException {
  constructor() {
    super('UPLOAD_OWNERSHIP', 403, 'You do not own this channel');
  }
}

export class UploadInitiateFailedException extends DomainException {
  constructor() {
    super('UPLOAD_INITIATE_FAILED', 500, 'Failed to initiate multipart upload');
  }
}

export class UploadCompleteFailedException extends DomainException {
  constructor() {
    super('UPLOAD_COMPLETE_FAILED', 500, 'Failed to complete multipart upload');
  }
}

export class UploadPartCountMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PART_COUNT_MISMATCH',
      422,
      'Parts count does not match recorded partCount',
    );
  }
}
