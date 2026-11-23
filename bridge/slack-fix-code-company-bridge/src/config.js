import { createConfigApi } from 'slack-bridge-core/config.js';
import profile from './profile.js';

export { resolveModels, selectDefaultRuntime, loadEnvBeside } from 'slack-bridge-core/config.js';
export const { configHome, findConfig, loadConfig, defaultSkill } = createConfigApi(profile);
