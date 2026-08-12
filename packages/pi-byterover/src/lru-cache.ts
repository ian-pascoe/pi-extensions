export class LruCache<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly maxSize: number) {}

  get(key: K) {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;

    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    this.#entries.delete(key);
    this.#entries.set(key, value);

    if (this.#entries.size <= this.maxSize) return;

    const oldestKey = this.#entries.keys().next().value;
    if (oldestKey !== undefined) this.#entries.delete(oldestKey);
  }
}
