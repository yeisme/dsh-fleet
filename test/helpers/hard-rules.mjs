/**
 * The user-adopted hard rules (2026-11-27, from the S0 spike report) as line scanners.
 * A line carrying the text `hard-rule-ignore` is exempt — used only by comments that must NAME the
 * forbidden token to explain the rule. Scanned: src/, scripts/, lib/, index.js (not test/, not docs/).
 */
export const RULES = [
  {
    id: 1,
    pattern: /jsx-dev-runtime/, // hard-rule-ignore
    why: 'JSX must build with development:false; the dev runtime is not one of the host\'s require seed words',
  },
  {
    id: 2,
    pattern: /state-done/, // hard-rule-ignore
    why: 'the state-done tokens are #0A84FF (same as "working") in the Quartz dark theme; "done" must use state-success',
  },
  {
    id: 3,
    pattern: /(['"`])(?:ctrl|control|alt|shift|meta|cmd|super)-[A-Za-z0-9]+\1/i, // hard-rule-ignore
    why: 'key chords are plus-separated (e.g. ctrl+c); the hyphen form is not in herdr\'s documented key grammar',
  },
]

/** @returns {{ rule: number, line: number, text: string, why: string }[]} */
export function scanText(text) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (line.includes('hard-rule-ignore')) return
    for (const rule of RULES) {
      if (rule.pattern.test(line)) hits.push({ rule: rule.id, line: index + 1, text: line.trim().slice(0, 120), why: rule.why })
    }
  })
  return hits
}
