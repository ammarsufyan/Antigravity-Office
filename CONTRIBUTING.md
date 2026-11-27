# Contributing

Thanks for helping improve **Antigravity Office**.

> **Upstream attribution**: Antigravity Office is forked from [W17ant/Claude-Office](https://github.com/W17ant/Claude-Office) by [W17ANT](https://github.com/W17ant) and its upstream contributors. Please keep all upstream copyright notices ([LICENSE](LICENSE), [NOTICE.md](NOTICE.md)) and translator credits (`locales/*.json`) intact. If you build a general improvement that also helps the upstream project, consider contributing it back to `W17ant/Claude-Office` too.

## What we are building

Antigravity Office visualizes real Google Antigravity activity — sessions, subagents, MCP tool calls, task checklists (`update_steps`), context memory usage, and shell signals — using pure cross-platform Node.js (Windows, macOS, Linux).

## Adding or fixing a language

Translations live in `locales/<code>.json` (no code changes needed):

1. Copy `locales/en.json` to `locales/<code>.json` and fill in `meta` (`name`, `englishName`, and your GitHub handle in `translators`).
2. Keep every `{placeholder}`, slash command (`/status`), `@`-mention, and Dunder Mifflin English line intact.
3. Run `node scripts/i18n-check.mjs <code>` and `npm test`.
4. Open a pull request or report an issue via Settings › Language › *Report a translation error*.

## Before you open a PR

- Run `npm run build` (`tsc && vite build`) and `npm test`.
- Run `npm run check-assets` if you touched sprites or rooms.
- Add or update tests under `tests/` for any behavior you change.
- Update [README.md](README.md) if you change commands, hook events, or defaults.
- Office-themed (`/the-office`) assets are fan art (see [NOTICE.md](NOTICE.md)); do not add more third-party likenesses, logos, or quoted lines.
