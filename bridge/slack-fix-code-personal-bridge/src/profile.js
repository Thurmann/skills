import path from 'node:path';

/** Per-variant settings consumed by slack-bridge-core. */
export default Object.freeze({
  id: 'personal-local',
  configDirName: 'fix-code-bridge',
  configEnvVar: 'FIX_CODE_CONFIG',
  packageDir: path.resolve(import.meta.dirname, '..'),
  defaultSkillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'),
  github: Object.freeze({ modes: Object.freeze(['user']), tokenFile: false, requireTokenFile: false, forbidRuntimeTokenEnv: false }),
  routing: Object.freeze({ localRoot: true, aliases: true })
});
