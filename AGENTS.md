# Working on Three Kingdoms Chess

- Read README.md and docs/规则与初始坐标.md before changing gameplay.
- This milestone is same-screen play, with Vue 3 and TypeScript. Java/Spring Boot and WebSocket are the next milestone.
- Preserve the 29-piece canonical initial setup and faction-dependent forward direction. Display coordinates are code coordinates plus one.
- Keep rules in src/game.ts as pure functions. UI feedback, persistence and dialogs belong in the Vue adapter.
- Keep the temporary capture-the-king mode explicit. Mandatory check responses, self-check restrictions, checkmate timing and automatic repetition draws remain unconfirmed.
- A rejected move must not mutate the board, turn or move history. Eliminating a country removes all its pieces before choosing the next turn.
- Update rule and interaction tests when a behavior changes. Use npm test and npm run build for relevant source changes.
- Run browser acceptance where supported and report what was actually verified. Simulated-DOM tests do not prove visual or touch correctness.
- Preserve existing Git history, user documents and images when integrating this baseline into the existing GitHub repository.
- After each substantial completed change, run the relevant verification, create a local Git commit, and push the resulting branch to the configured GitHub remote. Never force-push over existing history; report authentication or remote conflicts instead of bypassing them.
