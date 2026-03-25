import http from 'http';
import { readFileSync, watchFile } from 'fs';
import { resolve } from 'path';

const variant = process.argv[2] || 'neural';
const htmlPath = resolve(`variant-${variant}.html`);
const apiUrl = process.env.ENGRAM_URL || 'http://100.64.0.13:4200';
const apiKey = process.env.ENGRAM_API_KEY || '';
const PORT = 9999;

let graphCache = null;

async function fetchGraph() {
  if (graphCache) return graphCache;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${apiUrl}/graph`, { headers });
  graphCache = await res.text();
  return graphCache;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.url === '/graph') {
    try {
      const data = await fetchGraph();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/inbox') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"items":[]}');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving variant-${variant}.html at http://localhost:${PORT}`);
  console.log('Edit the file, refresh browser to see changes.');
});
