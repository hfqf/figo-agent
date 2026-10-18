export class FinalAnswerStream {
  private pending = "";
  private confirmed = false;

  constructor(private readonly emit: (text: string) => void, private readonly allowUnmarkedStreaming = false) {}

  push(delta: string): void {
    if (this.allowUnmarkedStreaming) {
      if (!this.confirmed) {
        this.pending += delta;
        if (looksLikeNativeToolPrefix(this.pending)) return;
        this.confirmed = true;
        this.emit(this.pending);
        this.pending = "";
        return;
      }
      this.confirmed = true;
      this.emit(delta);
      return;
    }
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

function looksLikeNativeToolPrefix(content: string): boolean {
  const candidate = content.trimStart();
  if (!candidate) return true;
  if (!candidate.startsWith("<")) return false;
  const tag = candidate.slice(1).toLowerCase();
  // DSML 的命名空间可跨多个 delta；完整响应仍交给协议解析器裁决。
  if (/^\/?\s*[|｜]/.test(tag)) return true;
  return ["tool_calls", "function_calls", "invoke"].some((name) =>
    name.startsWith(tag) || (tag.startsWith(name) && (!tag[name.length] || /[\s>]/.test(tag[name.length]))));
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
