## What and why

<!-- What changes for a person or an agent, and why. Link the issue if there is one. -->

## How it was checked

<!-- The tests you added or ran. For the editor: which browser suite. For an agent run, a phone or a second device: what you ran on it and what you saw. -->

## Checklist

- [ ] `npm test`, `npm run typecheck` and `npm run check:docs` pass
- [ ] New behaviour has a test
- [ ] The guide and `docs/guide/changelog.md` say what changed; a claim states what was run, and a limit is stated as a limit
- [ ] After a change to an MCP tool, `npx tsx scripts/gen-docs-reference.ts` was run
- [ ] After a change to the dependencies, `node scripts/gen-third-party-notices.mjs` was run
- [ ] New document fields are additive, and older builds keep what they do not understand
- [ ] Nothing was read, copied or derived from Paper Desktop or a reverse engineered clone of a design tool
