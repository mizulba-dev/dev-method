---
name: scenario-kit
description: Record and regenerate this project's product demo video with scenario-kit (Playwright recording + Remotion compositing). Use when asked to create, update, or regenerate a demo video, or to add a new demo scenario.
allowed-tools: Bash(npx scenario-kit:*)
---

# scenario-kit

`scenario-kit` records a product demo by driving a real browser (Playwright), then
composites the recording into a branded mp4 (Remotion): intro card → rounded
browser window → outro card.

This project's demo config and scenarios live in `scenario-kit/` at the project
root:

```
scenario-kit/
  config.json      brand + output settings
  scenarios/
    <name>.json    one or more recording scenarios
  out/             generated recordings and mp4s (gitignored)
```

## Commands

```bash
npx scenario-kit run <name>      # record + render in one step
npx scenario-kit record <name>   # record only -> scenario-kit/out/recordings/<name>.webm
npx scenario-kit render <name>   # convert + composite only -> scenario-kit/out/<name>-demo.mp4
npx scenario-kit login [url]     # save a logged-in session for recording pages behind a login
npx scenario-kit init            # scaffold scenario-kit/ in a new project
npx scenario-kit --help          # full command and steps reference
```

`login` opens a browser for the user to log in manually (it needs their input —
tell them to log in and press Enter in the terminal), then saves a Playwright
storageState file. Set `"storageState": ".auth/state.json"` in
`scenario-kit/config.json` so recordings start already logged in. Never write
login steps (credentials) into a scenario.

Requires `ffmpeg`/`ffprobe` on PATH, and `npx playwright install chromium`
once per machine.

## Writing a scenario

A scenario is a JSON file in `scenario-kit/scenarios/` (e.g.
`scenario-kit/scenarios/landing.json`) with a `steps` array. Each step is a
single-key object:

| step      | argument          | effect                         |
| --------- | ----------------- | ------------------------------ |
| `goto`    | url               | navigate to a URL              |
| `click`   | locator           | click a Playwright locator     |
| `type`    | `[locator, text]` | type text into a locator       |
| `move`    | `[x, y]`          | move the mouse cursor          |
| `scroll`  | y                 | smooth-scroll to a Y offset    |
| `pause`   | ms                | wait                           |
| `waitFor` | locator           | wait for a locator to appear   |
| `mark`    | label             | record a named timeline marker |

`locator` is any Playwright locator string (e.g. `text=Get started`,
`#hero`, `[data-testid=cta]`).

Example `scenario-kit/scenarios/landing.json`:

```json
{
  "$schema": "https://unpkg.com/scenario-kit/schema/scenario.schema.json",
  "steps": [
    { "goto": "https://example.com" },
    { "move": [720, 400] },
    { "pause": 1000 },
    { "mark": "hero" },
    { "scroll": 800 },
    { "mark": "section-1" },
    { "pause": 500 }
  ]
}
```

The `$schema` field (written by `scenario-kit init`) gives editors validation and
autocomplete for the steps above — write scenarios by hand or generate them,
then run `npx scenario-kit run <name>` to check the result.

For scripted interactions the JSON vocabulary can't express, use a
`<name>.ts` scenario instead (`scenario-kit/scenarios/landing.ts`, resolved
when no `<name>.json` exists). A plain default-exported async function is enough —
no import of `scenario-kit` required, so this works with `npx scenario-kit` alone:

```ts
export default async ({ page, mark }) => {
  await page.goto("https://example.com");
  mark("hero");
};
```

If `scenario-kit` is a dependency of the project, wrap it in `defineScenario`
for typed `page`/`mark` parameters (an identity function, for type-checking
only):

```ts
import { defineScenario } from "scenario-kit";

export default defineScenario(async ({ page, mark }) => {
  await page.goto("https://example.com");
  mark("hero");
});
```
