# CLAUDE.md

**Penguin Push**: a 3D (Three.js) penguin sumo party game, a static PWA deployed by
uploading `dist/` (built from `public/`) to Netlify. See README.md for gameplay and
architecture.

## Conventions (mirrors pomelo-penguin)

- No bundler, no transpile. ES modules under `public/src/`, relative URLs (`./src/main.js`).
  `scripts/build.js` minifies per-file only.
- JSDoc + `tsc --checkJs` strict (`npm run typecheck`). Three.js types come from `@types/three`
  via `public/vendor/three.module.min.d.ts`.
- Prettier: tabs, single quotes, 100 cols. ESLint `--max-warnings 0`.
- Vitest uses explicit imports. Playwright reads `window.__game`, never pixel diffs.
- One threaded `state` object (`state.js`). Fixed 60 Hz `tick()` in `game.js`.

## Multiplayer

- `public/src/net/` and `relay/` are **generated** from pomelo-penguin's `packages/netplay`
  (`npm run net:sync`, needs `../pomelo-penguin`, `../pomelopenguin.com` or `NETPLAY_REPO`).
  Don't hand-edit them. Engine changes belong in pomelo-penguin.
- The relay must never parse game payloads. Everything game-specific is in `multi.js`.
- Maps are a tile grid (`arena.level`/`block`/`crack`; `CELL` = 1.25). Don't reintroduce free-form
  geometry. Snowballs roll along grid axes and only downhill.
- Determinism: anything every screen must agree on (map, jars, floes, waves, snowball rolls)
  is derived from the match seed plus match time in `arena.js`. Use the netplay RNG there,
  never `Math.random`.
- Ownership: only mutate penguins `link.owns(pid)`. For anyone else's penguin, send a `push`.

## Commands

`npm run dev` (port 3000), `npm run dev:relay` (port 8788), `npm test`, `npm run test:e2e`,
`npm run check`, `npm run build`, `npm run deploy:draft` (preview URL), `npm run deploy` (production).

Netlify site ID: `684d55ab-933f-46c1-8e64-f485df605403` (baked into the deploy scripts). Deploys upload
`dist/` via `npx netlify-cli@27`; needs `netlify login` or `NETLIFY_AUTH_TOKEN`. Online play only works
from a `*.pomelopenguin.com` origin (the relay's allowlist).
