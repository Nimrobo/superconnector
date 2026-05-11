export class SuperconnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperconnectorError';
  }
}

export class UnknownSessionError extends SuperconnectorError {
  constructor(public readonly sessionId: string, public readonly appLabel: string, public readonly cwd: string) {
    super(`No session "${sessionId}" recorded for appLabel "${appLabel}" in cwd "${cwd}"`);
    this.name = 'UnknownSessionError';
  }
}

export class AdapterNotSetError extends SuperconnectorError {
  constructor() {
    super('No adapter set. Call setAdapter() or pass { adapter } to createSuperconnector().');
    this.name = 'AdapterNotSetError';
  }
}

export class AdapterFailedError extends SuperconnectorError {
  constructor(message: string, public readonly exitCode: number | null, public readonly stderr: string) {
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
