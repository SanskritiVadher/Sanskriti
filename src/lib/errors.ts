export class UserFacingError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}
