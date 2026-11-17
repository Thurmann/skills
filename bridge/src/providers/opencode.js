const rule = (action, effect = 'allow') => ({ action, resource: '*', effect });

export function opencodePermissions({ readonly, allowNetwork }) {
  const allowed = readonly ? ['read', 'glob', 'grep'] : ['read', 'glob', 'grep', 'edit', 'shell', 'subagent', 'skill'];
  // Last matching rule wins, so the blanket deny comes first. Skill files and evidence live outside the worktree.
  return [rule('*', 'deny'), ...allowed.map((a) => rule(a)), rule('external_directory'), ...(allowNetwork ? [rule('webfetch'), rule('websearch')] : [])];
}

export default {
  name: 'opencode',
  defaultCommand: 'opencode',
  envVars: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
  enforcesReadonly: true,
  promptTools: { implementer: 'file reading and search, file editing, shell commands, and sub-agents', readonly: 'file reading and search only, with no edits, shell commands, or commits' },
  buildArgs: ({ model }) => ['run', '--standalone', '--format', 'json', '--archived', '--model', model],
  extraEnv: ({ readonly, allowNetwork }) => ({
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permissions: opencodePermissions({ readonly, allowNetwork }) }),
  }),
  createParser() {
    const texts = new Map();
    let sessionId;
    return {
      onEvent(event) {
        const out = {};
        if (typeof event.sessionID === 'string' && event.sessionID && event.sessionID !== sessionId) out.sessionId = sessionId = event.sessionID;
        const part = event.part;
        if (event.type === 'text' && typeof part?.text === 'string') {
          const key = part.messageID ?? '';
          out.finalText = (texts.get(key) ?? '') + part.text;
          texts.set(key, out.finalText);
        } else if (event.type === 'step_finish' && part) out.usage = { tokens: part.tokens, cost: part.cost };
        else if (event.type === 'error') out.error = event.error?.data?.message || event.error?.message || true;
        return out;
      },
    };
  },
  doctorChecks: () => [{ name: 'version', args: ['--version'] }],
};
