export interface DraftSnapshot {
  text: string;
  revision: string;
}

export interface DraftPort {
  read(): DraftSnapshot;
  write(text: string): void;
  generate(text: string, signal: AbortSignal): Promise<string>;
  repaint(): void;
  notify(message: string, type: "info" | "error"): void;
}

/** One editor's restorable draft; request identity prevents canceled work from landing. */
export class Drafts {
  private original?: string;
  private pending?: string;
  private request?: { abort: AbortController; snapshot: DraftSnapshot };
  private writing = false;

  constructor(private readonly port: DraftPort) {}

  get working(): boolean { return this.request !== undefined; }
  get ready(): boolean { return this.pending !== undefined; }
  get hasPair(): boolean { return this.original !== undefined; }

  changed(text: string): void {
    if (this.writing) return;
    if (!text.trim()) {
      this.reset();
      return;
    }
  }

  reset(): void {
    this.request?.abort.abort();
    this.request = undefined;
    this.original = undefined;
    this.pending = undefined;
    this.port.repaint();
  }

  cancel(): void {
    this.request?.abort.abort();
    this.request = undefined;
    this.port.repaint();
  }

  async polish(): Promise<void> {
    if (this.working) return;
    const snapshot = this.port.read();
    if (!snapshot.text.trim()) return;
    const request = { abort: new AbortController(), snapshot };
    this.pending = undefined;
    this.request = request;
    this.port.repaint();
    try {
      const polished = await this.port.generate(snapshot.text, request.abort.signal);
      if (this.request !== request || request.abort.signal.aborted) return;
      const current = this.port.read();
      if (current.revision === snapshot.revision && current.text === snapshot.text) {
        this.original = snapshot.text;
        this.replace(polished);
      } else {
        this.pending = polished;
        this.port.notify("润色已完成，草稿有新修改。点击按钮可应用结果，当前内容会保留为原稿。", "info");
      }
    } catch (error) {
      if (this.request === request && !request.abort.signal.aborted) {
        this.port.notify(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (this.request === request) this.request = undefined;
      this.port.repaint();
    }
  }

  applyOrRestore(): void {
    if (this.working) { this.cancel(); return; }
    if (this.pending) {
      this.original = this.port.read().text;
      const polished = this.pending;
      this.pending = undefined;
      this.replace(polished);
    } else if (this.original !== undefined) {
      const original = this.original;
      this.original = undefined;
      this.replace(original);
    } else {
      return;
    }
    this.port.repaint();
  }

  private replace(text: string): void {
    this.writing = true;
    try { this.port.write(text); }
    finally { this.writing = false; }
  }
}
