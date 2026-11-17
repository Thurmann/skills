export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}
