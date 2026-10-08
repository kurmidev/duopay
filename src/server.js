import { createServer } from 'node:http';
import { createApp } from './app.js';

let app;
try {
  app = createApp();
} catch (e) {
  console.error(`\n[duopay] cannot start: ${e.message}\n`);
  process.exit(1);
}
const server = createServer(app.handle);
server.listen(app.cfg.port, app.cfg.host, () => {
  console.log(`DuoPay on http://${app.cfg.host}:${app.cfg.port}`);
  console.log(`  routing advisor: ${app.cfg.anthropic.apiKey ? `Claude (${app.cfg.anthropic.model})` : 'rules only (set ANTHROPIC_API_KEY to enable Claude)'}`);
  console.log(`  simulators: ${app.cfg.enableSimulators ? 'ON (dev)' : 'OFF'}`);
});
