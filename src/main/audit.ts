import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AuditEvent, Risk } from "../shared/contracts.js";

export class AuditStore {
  constructor(private readonly path: string) {}

  async record(tool: string, risk: Risk, status: string, summary: string) {
    const event: AuditEvent = { id: randomUUID(), at: new Date().toISOString(), tool, risk, status, summary };
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async list(): Promise<AuditEvent[]> {
    try {
      const text = await readFile(this.path, "utf8");
      return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AuditEvent).reverse().slice(0, 100);
    } catch { return []; }
  }
}
