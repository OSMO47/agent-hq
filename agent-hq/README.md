# Agent HQ

Local-first manager for a Claude-only AI organization. See `../docs/PHASE1-AUDIT.md` for design and progress.

Requirements: Node.js ≥ 24 (uses built-in `node:sqlite` and TypeScript type stripping — no build step), Claude Code CLI logged in (`claude`).

```powershell
npm test            # unit tests, no Claude usage
npm run test:live   # one real haiku call (uses quota)
```
