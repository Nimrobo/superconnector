export class SuperconnectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SuperconnectorError';
  }
}

export class UnknownSessionError extends SuperconnectorError {
  constructor(
    public readonly sessionId: string,
    public readonly appId: string,
    public readonly cwd: string,
    public readonly sessionSelector?: string,
  ) {
    super(
      sessionSelector === undefined
        ? `No session "${sessionId}" recorded for appId "${appId}" in cwd "${cwd}"`
        : `No session "${sessionId}" recorded for appId "${appId}" and sessionSelector "${sessionSelector}" in cwd "${cwd}"`,
    );
    this.name = 'UnknownSessionError';
  }
}

export class AdapterNotSetError extends SuperconnectorError {
  constructor() {
    super('No adapter set. Call setAdapter() or pass { adapter } to createSuperconnector().');
    this.name = 'AdapterNotSetError';
  }
}

export class InvalidCwdError extends SuperconnectorError {
  constructor(
    public readonly cwd: string,
    public readonly processCwd: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid cwd "${cwd}". Explicit cwd must be the current process cwd or a descendant of "${processCwd}".`,
      options,
    );
    this.name = 'InvalidCwdError';
  }
}

export class AdapterFailedError extends SuperconnectorError {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'AdapterFailedError';
  }
}

export class PermissionRequiredError extends AdapterFailedError {
  constructor(
    public readonly sessionId: string,
    public readonly cwd: string,
    public readonly resumeCommand: string,
    exitCode: number | null,
    stderr: string,
  ) {
    super(
      `Agent halted on a permission request. Resume interactively with: ${resumeCommand}`,
      exitCode,
      stderr,
    );
    this.name = 'PermissionRequiredError';
  }
}

export class NotImplementedError extends SuperconnectorError {
  constructor(adapter: string) {
    super(`Adapter "${adapter}" is not implemented yet.`);
    this.name = 'NotImplementedError';
  }
}
