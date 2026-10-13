// Checks that eval sentences are not copied into the system prompt.
//   node scripts/check-leak.mjs
import fs from 'node:fs';
import { SYSTEM_PROMPT } from '../src/ai/interpret.llm.js';

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const prompt = norm(SYSTEM_PROMPT);
const files = ['eval/cases.json', 'eval/cases.holdout.json'].filter((f) => fs.existsSync(f));

let leaks = 0;
const phraseHits = new Map();
for (const f of files) {
  for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    for (const s of c.steps) {
      if (!s.say) continue;
      const n = norm(s.say);
      if (n.split(' ').length >= 3 && prompt.includes(n)) { leaks++; console.log(`LEAK [${f} / ${c.id}]: ${s.say}`); }
      const w = n.split(' ').filter((x) => x.length >= 3 && !/^\p{N}+$/u.test(x));
      for (let i = 0; i < w.length - 1; i++) {
        const g = `${w[i]} ${w[i + 1]}`;
        if (prompt.includes(g)) phraseHits.set(g, (phraseHits.get(g) ?? new Set()).add(c.id));
      }
    }
  }
}
console.log(leaks ? `\n${leaks} full-sentence leak(s) found.` : '\nNo full eval sentence appears in the prompt.');
console.log('\nTwo-word phrases shared with the prompt (review by eye; generic words are fine, specific eval phrases are not):');
for (const [g, ids] of phraseHits) console.log(`  "${g}"  <- ${[...ids].join(', ')}`);
