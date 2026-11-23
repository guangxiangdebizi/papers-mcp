import test from 'node:test';
import { runLive } from './live.mjs';

test('real online MCP workflow over stdio and stateless HTTP, files independently read back', { timeout: 360000 }, async () => { await runLive(); });
