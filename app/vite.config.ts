import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, type Plugin} from 'vite';

/**
 * Serve the local workspace's browser artifact in dev, so the app explores
 * exactly what the pipeline last built on this machine (the published copy
 * can lag behind schema changes until the next push).
 */
function serveLocalArtifact(): Plugin {
  const workspace = process.env.WORKSPACE ?? 'default';
  const artifact = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../workspaces',
    workspace,
    'anchorage-current.duckdb',
  );
  return {
    name: 'serve-local-artifact',
    configureServer(server) {
      // Exact match only: duckdb-wasm also probes for a `.wal` sibling next
      // to the database, and connect's prefix routing would happily serve the
      // database itself as that WAL, corrupting the attach.
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url === '/anchorage-current.duckdb.wal') {
          // Expected-missing WAL sibling; vite's SPA fallback would otherwise
          // answer 200 with index.html and duckdb would replay it as a WAL.
          res.statusCode = 404;
          res.end();
          return;
        }
        if (url !== '/anchorage-current.duckdb') {
          return next();
        }
        if (!fs.existsSync(artifact)) {
          res.statusCode = 404;
          res.end(
            `Local artifact not found at ${artifact}. ` +
              'Run `pnpm run pull` (or `pnpm run ingest`) in the repo root first, ' +
              'or set VITE_DATA_URL to the published dataset.',
          );
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(fs.statSync(artifact).size));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(artifact).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveLocalArtifact()],
});
