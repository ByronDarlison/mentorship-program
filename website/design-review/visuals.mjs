import { escape } from '../src/render.mjs';

export function conversationIllustration() {
  return '';
}

export function addTrainingVisuals(html, manual) {
  const tokens = manual.sectionById.get('training-curriculum').tokens;
  const moves = tokens.flatMap((token, index) => {
    if (token.type !== 'heading_open' || token.tag !== 'h4') return [];
    const title = tokens[index + 1].content;
    const match = /^(Focus|Explore|Help|Close): (.+)$/.exec(title);
    return match ? [{ label: match[1], detail: match[2], id: token.attrGet('id'), title }] : [];
  });
  if (moves.map(move => move.label).join(',') !== 'Focus,Explore,Help,Close') {
    throw new Error('Review the conversation visual when the canonical moves change');
  }
  // These are flexible moves, not a numbered or one-directional procedure.
  // Labels and explanations come from the same headings as the lesson below.
  const guide = `<figure class="conversation-guide" aria-label="Focus, Explore, Help and Close">
<ul class="conversation-moves" role="list">${moves.map(move => `<li><strong>${escape(move.label)}</strong><span>${escape(move.detail)}</span></li>`).join('')}</ul>
</figure>`;
  const focusHeading = `<h3 id="${moves[0].id}">${escape(moves[0].title)}</h3>`;
  if (!html.includes(focusHeading)) throw new Error('Training visual insertion point is missing');
  return html.replace(focusHeading, `${guide}\n${focusHeading}`);
}
