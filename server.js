import { app, BROKERS } from './app.js';

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Shoal backend  →  http://localhost:${PORT}`);
  for (const b of Object.values(BROKERS)) {
    console.log(`${b.name.padEnd(15)}→  paper/demo ${b.endpoints.paper}  ·  live ${b.endpoints.live}`);
  }
  console.log('Sessions are held in memory — no credentials written to disk.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nERROR: Port ${PORT} is already in use.`);
    console.error(`Either stop the other process or set a different port:\n  PORT=3002 node server.js\n`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});

export { app, server };
