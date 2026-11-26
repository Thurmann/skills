import path from 'node:path';
import { RunnerError } from '../errors.js';

function buildCodexArgs({ model, effort, cwd, readonly, gitCommonDir, allowNetwork }) {
  const args = [
    'exec', '--json', '--cd', cwd, '--model', model,
    '--sandbox', readonly ? 'read-only' : 'workspace-write',
    '--ignore-user-config',
    '-c', 'approval_policy="never"',
    '-c', 'agents.enabled=true',
    '-c', 'mcp_servers={}',
    '-c', `sandbox_workspace_write.network_access=${allowNetwork ? 'true' : 'false'}`,
  ];
  if (effort) args.push('-c', `model_reasoning_effort=${tomlString(effort)}`);
  if (!readonly && gitCommonDir) {
    if (typeof gitCommonDir !== 'string' || !path.isAbsolute(gitCommonDir)) {
      throw new RunnerError('INVALID_GIT_COMMON_DIR', 'gitCommonDir must be an absolute path');
    }
    args.push('--add-dir', gitCommonDir);
  }
  args.push('-');
  return args;
}

function tomlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export default {
  name: 'codex',
  defaultCommand: 'codex',
  envVars: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  enforcesReadonly: true,
  buildArgs: buildCodexArgs,
  createParser() {
    let sessionId;
    return {
      onEvent(event) {
        const out = {};
        const next = event.thread_id || (event.type === 'thread.started' && event.thread?.id);
        if (next && next !== sessionId) out.sessionId = sessionId = String(next);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          out.finalText = event.item.text;
        } else if (event.type === 'turn.completed') {
          out.usage = event.usage ?? event;
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          // Recorded, not fatal: Codex also reports retried stream errors here and exits nonzero itself.
          out.errorDetail = event.error?.message ?? event.message;
        }
        return out;
      },
    };
  },
  doctorChecks: () => [{ name: 'version', args: ['--version'] }, { name: 'login', args: ['login', 'status'] }],
};
