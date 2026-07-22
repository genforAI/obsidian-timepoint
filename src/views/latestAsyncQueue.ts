/**
 * Serialize expensive async refreshes and coalesce queued requests to the
 * newest value. A second render is never allowed to clear the same canvas
 * while the first render is still restoring its viewport.
 */
export class LatestAsyncQueue<T> {
  private latest: T | null = null;
  private operation: Promise<void> | null = null;

  constructor(private readonly apply: (value: T) => Promise<void>) {}

  get active(): boolean {
    return this.operation !== null;
  }

  request(value: T): Promise<void> {
    this.latest = value;
    if (this.operation) return this.operation;
    const operation = this.drain();
    const tracked = operation.finally(() => {
      if (this.operation === tracked) this.operation = null;
    });
    this.operation = tracked;
    return tracked;
  }

  private async drain(): Promise<void> {
    while (this.latest !== null) {
      const value = this.latest;
      this.latest = null;
      await this.apply(value);
    }
  }
}
