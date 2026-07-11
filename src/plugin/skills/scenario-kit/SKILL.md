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
  assets/          brand assets such as logo.png (referenced from config.json)
  out/             generated recordings, screenshots and mp4s (gitignored)
```

## Commands

```bash
npx scenario-kit run <name>      # record + render in one step
npx scenario-kit record <name>   # record only -> scenario-kit/out/recordings/<name>.webm
npx scenario-kit render <name>   # convert + composite only -> scenario-kit/out/<name>-demo.mp4
npx scenario-kit shots <name>    # capture PNG screenshots -> scenario-kit/out/shots/<name>/ (no video, no ffmpeg)
npx scenario-kit qa <name>       # record + detect runtime issues -> scenario-kit/out/qa/<name>/{video.mp4,report.json,*.png}
npx scenario-kit login [url]     # save a logged-in session for recording pages behind a login
npx scenario-kit init            # scaffold scenario-kit/ in a new project
npx scenario-kit --help          # full command and steps reference
```

If a command from this document is missing from `npx scenario-kit --help`
output, the project has an older scenario-kit installed — run it with an
explicit version (`npx -y scenario-kit@latest <command> <name>`) or update the
dependency, instead of concluding the command doesn't exist.

`login` opens a browser for the user to log in manually (it needs their input —
tell them to log in and press Enter in the terminal), then saves a Playwright
storageState file. Set `"storageState": ".auth/state.json"` in
`scenario-kit/config.json` so recordings start already logged in. Never write
login steps (credentials) into a scenario. The saved session is
origin-scoped: a session saved against production does not log you into
`localhost`. When a scenario targets a different origin (e.g. a local dev
server), check the state file's cookie domains first, and if they don't
cover the target, re-run `npx scenario-kit login <url>` against it.

Requires `ffmpeg`/`ffprobe` on PATH, and `npx playwright install chromium`
once per machine.

## Writing a scenario

A scenario is a JSON file in `scenario-kit/scenarios/` (e.g.
`scenario-kit/scenarios/landing.json`) with a `steps` array. Each step is a
single-key object:

| step         | argument          | effect                                                                                              |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------- |
| `goto`       | url               | navigate to a URL                                                                                   |
| `click`      | locator           | click a Playwright locator                                                                          |
| `type`       | `[locator, text]` | type text into a locator                                                                            |
| `move`       | `[x, y]`          | move the mouse cursor                                                                               |
| `scroll`     | y                 | smooth-scroll to a Y offset                                                                         |
| `pause`      | ms                | wait                                                                                                |
| `waitFor`    | locator           | wait for a locator to appear                                                                        |
| `mark`       | label             | record a named timeline marker                                                                      |
| `highlight`  | locator           | draw a red highlight box around a locator (`shots` only, no-op in `record`/`qa`)                    |
| `screenshot` | label             | capture the current viewport as a PNG, then clear highlights (`shots`/`qa` only, no-op in `record`) |

`locator` is any Playwright locator string (e.g. `text=Get started`,
`#hero`, `[data-testid=cta]`).

Don't guess locators or expected texts — read them from the app source
(element ids, `aria-label`s, i18n message files). `waitFor` with `text=`
must match the rendered text exactly, including punctuation; a paraphrased
message times out. Each wrong guess costs a full scenario run, so a minute
in the source first is cheaper than iterating on failures.

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

## Screenshots

`npx scenario-kit shots <name>` runs the same scenario but captures PNG
screenshots instead of a video — no `ffmpeg`/Remotion, no pseudo-cursor. Add
`highlight` (red box around a locator) and `screenshot` (capture + clear
highlights) steps to a scenario to produce annotated screenshots for release
notes or docs:

```json
{ "highlight": "text=Get started" },
{ "screenshot": "hero" }
```

Output goes to `scenario-kit/out/shots/<name>/01-hero.png` (capture order,
numbered), and the directory is wiped and recreated on each run.
`highlight`/`screenshot` are no-ops during `record`, so the same scenario
file can drive both the demo video and release-note screenshots.

## QA workflow

After implementing or changing a feature, use `npx scenario-kit qa <name>` as
the last check before handing off to a human: it drives the real UI like
`record` (video + pseudo-cursor), but also watches the page for runtime
errors and writes a structured `report.json` instead of a branded video.

1. Write (or reuse) a scenario in `scenario-kit/scenarios/<name>.json` (or
   `.ts`) that exercises the feature end-to-end. If the existing demo
   scenarios target production, write a separate local variant (e.g.
   `<name>-local.json`) pointing at the dev server instead of editing them —
   and check the login note above if the origins differ.
2. Run `npx scenario-kit qa <name>`. It exits `0` when the scenario completed
   with zero detected issues, `2` otherwise.
3. If the exit code is non-zero, read
   `scenario-kit/out/qa/<name>/report.json`:
   - `failure` (non-null) means a step itself failed (e.g. a locator wasn't
     found) — see `failure.stepIndex`/`message`/`screenshot`
     (`failure.png`).
   - `issues` is a list of runtime problems detected while driving the page:
     `console-error`, `page-error` (uncaught exception), `http-error`
     (status >= 400 on a document/xhr/fetch request), `request-failed`. Each
     issue records the step index (JSON scenarios only), the most recent
     `mark` label, and an `issue-N.png` screenshot when one was captured.
   - Open the referenced screenshots (`failure.png` / `issue-N.png`) to see
     the page state at the moment of the problem, fix the underlying code or
     scenario, and re-run `qa` — repeat until it exits `0`.
4. Once `qa` exits `0`, tell the human the video path
   (`scenario-kit/out/qa/<name>/video.mp4`) so they can do a final skim —
   `qa`'s job is to catch obvious breakage and runtime errors before that
   point, not to replace a human glance at the result.

`qa` does not do LLM-based visual judgment or pixel-diffing — it only
surfaces deterministic signals (runtime errors, failed navigation/network
requests, step failures) for an agent to act on.
