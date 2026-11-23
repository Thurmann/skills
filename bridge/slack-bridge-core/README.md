# slack-bridge-core

Shared code for the fix-code Slack bridges: Slack Socket Mode protocol, the durable SQLite queue and outbox, the coding runner and its providers (Claude Code, Codex, Gemini CLI, opencode), Git and repository routing, configuration, the CLI, and cloud deployment scripts.

Nothing runs from this directory on its own. Three variants consume it: [personal](../slack-fix-code-personal-bridge/README.md) (local `gh` login), [personal cloud](../slack-fix-code-personal-cloud-bridge/README.md) (token file on a VM) and [company](../slack-fix-code-company-bridge/README.md) (GitHub App tokens, Vertex AI or Foundry).

## Layout

- `src/`: the bridge. `bridge.js` (authorization, serial queue, phases), `protocol.js`, `store.js`, `runner.js`, `providers/`, `repository-router.js`, `git.js`, `config.js` (profile-bound configuration API) and `cli.js` (`runCli`).
- `test/`: core tests.
- `deploy/`: systemd template, cloud-init, Azure provisioning and secret fetching. See [`deploy/README.md`](deploy/README.md).
- `docs/architecture.md`: component boundaries, the core/variant split and the profile table.

## How a variant consumes it

A variant directory contains:

1. `package.json`: `"slack-bridge-core": "file:../slack-bridge-core"` plus the Slack SDK packages (`@slack/socket-mode`, `@slack/web-api`).
2. `.npmrc` with `install-links=false`, so npm links the directory rather than copying it.
3. `src/profile.js`: the frozen profile (`id`, `configDirName`, `configEnvVar`, `packageDir`, `defaultSkillPath`, `github`, `routing`).
4. `src/cli.js`: the Slack SDK entry point. It is the only place the SDK is imported.
5. `src/config.js`: a shim that binds the profile to core's config API.

Example from the personal-cloud variant, `src/cli.js`:

```js
#!/usr/bin/env node
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { runCli } from 'slack-bridge-core/cli.js';
import profile from './profile.js';

await runCli(profile, { SocketModeClient, WebClient });
```

Its `src/profile.js` (the variant-specific values):

```js
import path from 'node:path';

export default Object.freeze({
  id: 'personal-cloud',
  configDirName: 'fix-code-personal-cloud-bridge',
  configEnvVar: 'FIX_CODE_PERSONAL_CLOUD_CONFIG',
  packageDir: path.resolve(import.meta.dirname, '..'),
  defaultSkillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'),
  github: Object.freeze({ modes: Object.freeze(['user']), tokenFile: true, requireTokenFile: true, forbidRuntimeTokenEnv: true }),
  routing: Object.freeze({ localRoot: false, aliases: false })
});
```

Core validates the profile (`validateProfile`) and rejects any config key the profile does not allow, with a message such as `githubTokenFile is not supported by the personal-local bridge.`

## Adding a variant

1. Copy the closest variant (without `node_modules`), rename it, and change `profile.js` (`id`, config dir, env var, `github` and `routing` flags).
2. Add its config example, `.env.example`, Slack manifest, README and profile-rejection tests, then `npm ci` (it needs `../slack-bridge-core` beside it).
3. Add it to the CI `bridge` matrix, the root README and the variant table in `docs/architecture.md`.

## Tests

```bash
npm test     # node --test test/*.test.js
npm run check
```

Core tests are slow because many create disposable Git repositories and fake runners. `npm run check` syntax-checks `src/` and runs `bash -n` on the deploy scripts.

## Rule

Core must never import `@slack/*`, or any other package. The Slack SDK is injected by each variant's `cli.js`, which is why this package has no `dependencies`.
