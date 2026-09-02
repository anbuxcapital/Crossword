/**
 * Thrown by commands when a business rule is violated.
 * Over RPC the caller receives an Error with the same `name` and `message`
 * (other properties are not preserved), so map on `err.name` in the gateway.
 */
export class DomainError extends Error {
  override readonly name = "DomainError";
}

export class NotInitializedError extends Error {
  override readonly name = "NotInitializedError";
  constructor(kind: string) {
    super(`${kind} aggregate has not been initialized; call init(id) first`);
  }
}
