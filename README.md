# OpenCode Goal Mode

A durable, safety-bounded `/goal` workflow built for the current OpenCode 2 plugin API.

Unlike goal plugins written for OpenCode 1 or older V2 previews, this plugin registers commands with the current add-only command transform and uses the current session, tool, storage, and event APIs.

## Features

- `/goal <objective>` starts a session-scoped goal.
- `/goal status`, `/goal edit`, `/goal pause`, `/goal resume`, and `/goal clear` manage it.
- Durable plugin storage preserves goal state across OpenCode restarts.
- `goal_complete` requires the exact active goal ID and concrete completion evidence.
- `goal_blocked` requires the exact active goal ID, a specific blocker, and attempted-resolution evidence.
- Automatic continuation resumes at settled idle boundaries.
- A finite automatic-turn limit and prompt-failure ceiling prevent runaway loops.
- Plan-mode safety pauses active goal execution instead of escaping the selected agent boundary.
- No runtime dependencies.

## Compatibility

Tested against:

- OpenCode `2.0.32`
- `@opencode/plugin` `2.0.32`

Releases pin the exact stable API version they were tested against.

## Install

Install the current branch globally:

```sh
opencode plugin add github:phall1/opencode-goal-mode#main
opencode service restart
```

For reproducible configuration, pin a full commit hash in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:phall1/opencode-goal-mode#<full-commit-sha>"
  ]
}
```

OpenCode's current plugin configuration supports npm-compatible Git specs, branches, tags, and full commit hashes. Full hashes do not auto-update.

## Usage

```text
/goal finish the migration and verify every affected test
/goal status
/goal edit finish the migration but do not change the public API
/goal pause
/goal resume
/goal clear
```

While a goal is active, the model receives a compact Goal Mode contract containing the objective and a stale-call guard ID. Plain assistant text does not complete the goal; the model must call `goal_complete` with evidence.

## Options

Use the object form in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "github:phall1/opencode-goal-mode#<full-commit-sha>",
      "options": {
        "auto_continue": true,
        "max_automatic_turns": 25,
        "max_prompt_failures": 3,
        "min_continue_interval_ms": 2000
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | ---: | --- |
| `auto_continue` | `true` | Continue an active goal after the session settles idle. |
| `max_automatic_turns` | `25` | Pause after this many automatic follow-up turns. |
| `max_prompt_failures` | `3` | Pause after repeated continuation delivery failures. |
| `min_continue_interval_ms` | `2000` | Minimum time between automatic prompt admissions. |

Resuming resets the automatic-turn and prompt-failure epoch without changing the objective.

## Development

```sh
npm install
npm test
npm run check
```

The tests verify command registration against the current add-only API, lifecycle state, stale completion guards, context injection, and bounded continuation.

## License

MIT
