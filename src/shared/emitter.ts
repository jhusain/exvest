/** Minimal typed pub/sub used by every BrokerAdapter implementation. */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: any) => void>>();

  on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }
}
