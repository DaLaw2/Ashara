/** One titled list of prior-knowledge entries, each already rendered as its line. */
export interface KnowledgeSection {
  readonly heading: string;
  readonly entries: readonly string[];
}

/** ~2K tokens: the knowledge context's share of a brief, counted over its entries. */
const KNOWLEDGE_ENTRIES_MAX_CHARS = 8000;

/**
 * The brief's prior-knowledge context: sections in order, entries kept while together they fit `maxChars` (headings
 * and markers are not counted). Entries past the budget are omitted and the section says how many, so the model
 * never reads a cut list as the whole. "" when there is no entry at all.
 */
export function renderKnowledgeContext(
  sections: readonly KnowledgeSection[],
  maxChars: number = KNOWLEDGE_ENTRIES_MAX_CHARS,
): string {
  const title = "# Prior Knowledge";
  const rendered: string[] = [title];
  let charCount = 0;
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    const lines = [section.heading];
    let kept = 0;
    for (const entry of section.entries) {
      if (charCount + entry.length > maxChars) break;
      lines.push(entry);
      charCount += entry.length;
      kept++;
    }
    const omitted = section.entries.length - kept;
    if (omitted > 0) {
      lines.push(
        `[cut by Ashara: ${omitted} of ${section.entries.length} entries omitted: the entries shown here are limited to ${maxChars} characters together]`,
      );
    }
    rendered.push(lines.join("\n"));
  }
  return rendered.length > 1 ? rendered.join("\n\n") : "";
}
