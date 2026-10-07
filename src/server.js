import { createServer } from 'node:http';
import { createApp } from './app.js';

const app = createApp();
const server = createServer(app.handle);
server.listen(app.cfg.port, app.cfg.host, () => {
  console.log(`DuoPay on http://${app.cfg.host}:${app.cfg.port}`);
  console.log(`  routing advisor: ${app.cfg.anthropic.apiKey ? `Claude (${app.cfg.anthropic.model})` : 'rules only (set ANTHROPIC_API_KEY to enable Claude)'}`);
  console.log(`  simulators: ${app.cfg.enableSimulators ? 'ON (dev)' : 'OFF'}`);
});
