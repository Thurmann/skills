import path from 'node:path';

/** Per-variant settings consumed by slack-bridge-core. */
export default Object.freeze({
  id: 'company',
  configDirName: 'fix-code-company-bridge',
  configEnvVar: 'FIX_CODE_COMPANY_CONFIG',
  packageDir: path.resolve(import.meta.dirname, '..'),
  defaultSkillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'),
  github: Object.freeze({ modes: Object.freeze(['user', 'app']), tokenFile: true, requireTokenFile: false, forbidRuntimeTokenEnv: true }),
  routing: Object.freeze({ localRoot: true, aliases: true })
});
