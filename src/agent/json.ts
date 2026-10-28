export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("AI returned text instead of a plan");

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && inString) { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, index + 1)); }
        catch { throw new Error("AI returned an unreadable plan"); }
      }
    }
    throw new Error("AI returned an incomplete plan");
  }
}
