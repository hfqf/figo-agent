export function parseModelJson(content: string): unknown {
  let text = content.trim();
  while (text.startsWith("<think>")) {
    const end = text.indexOf("</think>", "<think>".length);
    if (end < 0) throw new Error("model thinking block is incomplete");
    text = text.slice(end + "</think>".length).trimStart();
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return JSON.parse(fenced ? fenced[1] : text);
}
