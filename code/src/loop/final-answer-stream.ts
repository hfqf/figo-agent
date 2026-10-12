export class FinalAnswerStream {
  private pending = "";
  private confirmed = false;

  constructor(private readonly emit: (text: string) => void) {}

  push(delta: string): void {
    if (this.confirmed) {
      this.emit(delta);
      return;
    }
    this.pending += delta;
    const candidate = withoutLeadingThinking(this.pending);
    if (candidate.startsWith("FINAL\n")) {
      this.confirmed = true;
      const text = candidate.slice(6);
      this.pending = "";
      if (text) this.emit(text);
    }
  }

  finish(content: string, isFinal: boolean): string {
    if (!isFinal) return content;
    const candidate = withoutLeadingThinking(content);
    const answer = candidate.startsWith("FINAL\n") ? candidate.slice(6) : candidate;
    if (!this.confirmed && answer) this.emit(answer);
    return answer;
  }
}

export function hasFinalMarker(content: string): boolean {
  return withoutLeadingThinking(content).startsWith("FINAL\n");
}

function withoutLeadingThinking(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("<think>")) return trimmed;
  const end = trimmed.indexOf("</think>");
  return end === -1 ? trimmed : trimmed.slice(end + 8).trimStart();
}
