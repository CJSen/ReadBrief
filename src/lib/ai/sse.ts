export interface SseEvent {
  data: string;
  event?: string;
}

type Emit = (event: SseEvent) => void;

export class SseParser {
  private buffer = "";

  constructor(private emit: Emit) {}

  parse(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    this.process(lines);
  }

  end(): void {
    if (this.buffer.length > 0) {
      this.process([this.buffer]);
      this.buffer = "";
    }
  }

  private process(lines: string[]): void {
    let event: string | undefined;
    const dataLines: string[] = [];

    const dispatch = () => {
      if (dataLines.length > 0) {
        this.emit({ data: dataLines.join("\n"), event });
      }
      event = undefined;
      dataLines.length = 0;
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line === "") {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    dispatch();
  }
}
