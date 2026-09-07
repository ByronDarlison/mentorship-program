const START = '<!-- internal-note:start -->';
const END = '<!-- internal-note:end -->';

// Notes are complete Markdown blocks. Keep line numbers stable for token maps.
export function readInternalNotes(source) {
  const lines = source.split(/\r?\n/);
  const ranges = [];
  let start;
  const content = lines.map((line, index) => {
    if (!line.includes('internal-note:')) return line;
    if (line !== START && line !== END) throw new Error(`Invalid internal-note marker at line ${index + 1}`);
    if (lines[index - 1]?.trim() || lines[index + 1]?.trim()) {
      throw new Error(`Internal-note markers need blank lines at line ${index + 1}`);
    }
    if (line === START) {
      if (start !== undefined) throw new Error('Nested internal notes are not supported');
      start = index + 1;
    } else {
      if (start === undefined) throw new Error('Internal note ends without a start');
      if (!lines.slice(start, index).some(line => line.trim())) throw new Error('Empty internal note');
      ranges.push({ start, end: index });
      start = undefined;
    }
    return '';
  }).join('\n');
  if (start !== undefined) throw new Error('Unclosed internal note');
  return { content, ranges };
}

export function markInternalTokens(tokens, ranges, content) {
  const lines = content.split('\n');
  const used = new Set();
  for (let index = 0; index < tokens.length;) {
    const first = tokens[index];
    let end = index + 1;
    let depth = first.nesting;
    while (depth > 0 && end < tokens.length) depth += tokens[end++].nesting;
    if (depth !== 0) throw new Error('Unbalanced Markdown block');
    if (first.map) {
      let [from, to] = first.map;
      // List maps can include trailing blank lines beyond their visible content.
      while (from < to && !lines[from].trim()) from++;
      while (to > from && !lines[to - 1].trim()) to--;
      const overlaps = ranges.filter(range => from < range.end && to > range.start);
      if (overlaps.length) {
        const range = overlaps[0];
        if (overlaps.length !== 1 || from < range.start || to > range.end) {
          throw new Error('Internal notes must contain complete top-level Markdown blocks');
        }
        const block = tokens.slice(index, end);
        if (block.some(token => token.type === 'heading_open')) throw new Error('Internal notes cannot contain headings');
        for (const token of block) token.meta = { ...token.meta, internalNote: true };
        used.add(range);
      }
    }
    index = end;
  }
  if (used.size !== ranges.length) throw new Error('Internal note has no renderable content');
}
