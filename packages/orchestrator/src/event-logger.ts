import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PipelineEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

export class EventLogger {
  private readonly logPath: string;
  private initialized = false;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  emit(event: PipelineEvent): void {
    if (!this.initialized) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.initialized = true;
    }
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
    appendFileSync(this.logPath, line + "\n");
  }
}
