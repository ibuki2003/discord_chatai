export class CachedMap<T> {
  private cache: Map<string, T>;
  private fetcher: (key: string) => Promise<T>;

  constructor(fetcher: (key: string) => Promise<T>) {
    this.cache = new Map();
    this.fetcher = fetcher;
  }

  async get(key: string): Promise<T | undefined> {
    const v = this.cache.get(key);
    if (v) {
      return v;
    }
    const value = await this.fetcher(key);
    if (value) {
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
  }
}

