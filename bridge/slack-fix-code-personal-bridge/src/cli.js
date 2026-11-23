#!/usr/bin/env node
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { runCli } from 'slack-bridge-core/cli.js';
import profile from './profile.js';

await runCli(profile, { SocketModeClient, WebClient });
