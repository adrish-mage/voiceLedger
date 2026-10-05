// Hinglish -> canonical English item names. Extend as your recordings reveal gaps.
// The app normalizes item names itself; we never trust the LLM's spelling.
export const ITEM_ALIASES = {
  rice: ['rice', 'chawal', 'chaawal'],
  oil: ['oil', 'tel', 'tail'],
  dal: ['dal', 'daal'],
  sugar: ['sugar', 'cheeni', 'chini'],
  flour: ['flour', 'atta', 'aata'],
  salt: ['salt', 'namak'],
  milk: ['milk', 'doodh', 'dudh'],
  tea: ['tea', 'chai', 'chaai'],
  soap: ['soap', 'sabun'],
  biscuit: ['biscuit', 'biscuits'],
};

const LOOKUP = new Map(Object.entries(ITEM_ALIASES).flatMap(([canon, words]) => words.map((w) => [w, canon])));

export const canonicalItem = (word) => LOOKUP.get(String(word).trim().toLowerCase()) ?? null;
export const knownItemWords = () => [...LOOKUP.keys()];
