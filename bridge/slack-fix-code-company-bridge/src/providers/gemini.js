import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunnerError } from '../errors.js';

const WRITE_TOOLS = ['write_file', 'replace', 'run_shell_command'];
const NETWORK_TOOLS = ['web_fetch', 'google_web_search'];

const policyPath = ({ readonly, outputDir }) => {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw new RunnerError('INVALID_OUTPUT_DIR', 'gemini runner requires an absolute outputDir for its policy file');
  return path.join(outputDir, `gemini-policy-${readonly ? 'readonly' : 'implementer'}.toml`);
};

export function policyToml({ readonly, allowNetwork }) {
  const rule = (toolName, decision, priority) => `[[rule]]\ntoolName = "${toolName}"\ndecision = "${decision}"\npriority = ${priority}\n`;
  return [
    ...WRITE_TOOLS.map((tool) => rule(tool, readonly ? 'deny' : 'allow', 900)),
    ...(allowNetwork ? [] : NETWORK_TOOLS.map((tool) => rule(tool, 'deny', 950))),
  ].join('\n');
}

export default {
  name: 'gemini',
  defaultCommand: 'gemini',
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
  enforcesReadonly: true,
  promptTools: { implementer: 'file reading and search, file editing, shell commands', readonly: 'file reading and search only, with no edits, shell commands, or commits' },
  buildArgs({ model, readonly, outputDir, skillPath }) {
    // --skip-trust is folder trust, not an approval bypass; without it headless runs in an untrusted folder cannot write.
    return [
      '--output-format', 'stream-json', '--model', model,
      '--approval-mode', readonly ? 'plan' : 'auto_edit',
      '--policy', policyPath({ readonly, outputDir }),
      '--allowed-mcp-server-names', '__fix_code_none__',
      ...(skillPath ? ['--include-directories', [skillPath, outputDir].join(',')] : ['--include-directories', outputDir]),
      ...(readonly ? [] : ['--skip-trust']),
      '-p', 'Follow the task instructions provided on standard input.',
    ];
  },
  async prepare({ readonly, allowNetwork, outputDir }) {
    const file = policyPath({ readonly, outputDir });
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeFile(file, policyToml({ readonly, allowNetwork }), { mode: 0o600 });
    await chmod(file, 0o600);
  },
  createParser() {
    let text = '';
    return {
      onEvent(event) {
        const out = {};
        if (event.type === 'init' && event.session_id) out.sessionId = String(event.session_id);
        else if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
          text = event.delta ? text + event.content : event.content;
          out.finalText = text;
        } else if (event.type === 'tool_use') text = '';
        else if (event.type === 'result') {
          if (event.stats != null) out.usage = event.stats;
          if (event.status === 'error') out.error = event.error?.message || true;
        }
        return out;
      },
    };
  },
  doctorChecks: () => [{ name: 'version', args: ['--version'] }],
};
