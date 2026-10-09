// Virelune Agent Village: start Village Hall (backend + web app). Works with zero agent integrations.
import { createServer } from './lib/api.ts';
import { Village } from './lib/app.ts';
import { loadConfig } from './lib/config.ts';
import { createRuntimeAdapters } from './lib/runtimes.ts';

const config = loadConfig();
// Real runtime adapters only. A resident can answer only when its checks pass AND its adapter is here.
const village = new Village(config, { adapters: (v) => createRuntimeAdapters(v, () => `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`) });
village.start();
const server = createServer(village);

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${config.port} is in use. Set VILLAGE_PORT in .env to another port.`);
  else console.error(e);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log('  Virelune Agent Village is running');
  console.log(`  Open ${url} in your browser`);
  console.log(`  Machine: ${config.machineName}   Data: ${config.dataDir}`);
  if (village.registries.errors.length) console.log(`  Registry problems: ${village.registries.errors.length} (see the control panel)`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

const shutdown = () => {
  server.close();
  village.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
