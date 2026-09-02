/**
 * Get the stub for one aggregate by its public id.
 * Names are `${kind}:${id}` so an id can never collide across kinds that share a namespace.
 */
export function aggregateStub<T extends Rpc.DurableObjectBranded | undefined>(
  ns: DurableObjectNamespace<T>,
  kind: string,
  id: string,
): DurableObjectStub<T> {
  return ns.get(ns.idFromName(`${kind}:${id}`));
}
