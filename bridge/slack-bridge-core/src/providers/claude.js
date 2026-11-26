const READONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Agent'];

function buildClaudeArgs({ model, effort, readonly }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model];
  if (effort) args.push('--effort', effort);
  // These are ordinary Claude Code permission controls, not permission bypass switches.
  args.push('--permission-mode', readonly ? 'plan' : 'acceptEdits');
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  args.push('--tools', ...(readonly ? READONLY_TOOLS : WRITE_TOOLS));
  args.push('--allowedTools', ...(readonly ? READONLY_TOOLS : WRITE_TOOLS));
  return args;
}

export default {
  name: 'claude',
  defaultCommand: 'claude',
  envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  enforcesReadonly: true,
  buildArgs: buildClaudeArgs,
  createParser() {
    return {
      onEvent(event) {
        const out = {};
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) out.sessionId = String(event.session_id);
        if (event.type === 'result') {
          if (typeof event.result === 'string') out.finalText = event.result;
          if (event.usage != null) out.usage = event.usage;
          if (event.is_error === true) out.error = typeof event.result === 'string' && event.result ? event.result : true;
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const pieces = event.message.content.filter((item) => item?.type === 'text' && typeof item.text === 'string');
          if (pieces.length) out.finalText = pieces.map((item) => item.text).join('\n');
          if (event.message.usage != null) out.usage = event.message.usage;
        }
        return out;
      },
    };
  },
  doctorChecks: () => [{ name: 'version', args: ['--version'] }],
};
