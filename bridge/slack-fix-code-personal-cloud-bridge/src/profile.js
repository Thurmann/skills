import path from 'node:path';

/** Per-variant settings consumed by slack-bridge-core. */
export default Object.freeze({
  id: 'personal-cloud',
  configDirName: 'fix-code-personal-cloud-bridge',
  configEnvVar: 'FIX_CODE_PERSONAL_CLOUD_CONFIG',
  packageDir: path.resolve(import.meta.dirname, '..'),
  defaultSkillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'),
  github: Object.freeze({ modes: Object.freeze(['user']), tokenFile: true, requireTokenFile: true, forbidRuntimeTokenEnv: true }),
  routing: Object.freeze({ localRoot: false, aliases: false })
});
