import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import http from 'http';
import { resolve } from 'path';

const ROOT = 'C:/Users/Zan/Projects/engram';
const variant = process.argv[2]; // 'constellation' or 'neural'
const htmlPath = resolve(ROOT, `tools/variant-${variant}.html`);
const outPath = resolve(ROOT, `tools/preview-${variant}-zoom.png`);

const apiUrl = process.env.ENGRAM_URL || 'http://100.64.0.13:4200';
const apiKey = process.env.ENGRAM_API_KEY || '';
const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

const res = await fetch(`${apiUrl}/graph`, { headers });
const graphData = await res.json();

const htmlContent = readFileSync(htmlPath, 'utf-8');
const server = http.createServer((req, resp) => {
  if (req.url === '/') { resp.writeHead(200, {'Content-Type':'text/html'}); resp.end(htmlContent); }
  else if (req.url === '/graph') { resp.writeHead(200, {'Content-Type':'application/json'}); resp.end(JSON.stringify(graphData)); }
  else if (req.url === '/inbox') { resp.writeHead(200, {'Content-Type':'application/json'}); resp.end('{"items":[]}'); }
  else { resp.writeHead(200, {'Content-Type':'application/json'}); resp.end('{}'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
try { await page.waitForSelector('#loading.hidden', { timeout: 15000 }); } catch {}
await page.waitForTimeout(5000);

// Zoom in by simulating wheel events at center
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, -150);
  await page.waitForTimeout(100);
}
await page.waitForTimeout(2000);

await page.screenshot({ path: outPath, type: 'png' });
console.log(`Saved: ${outPath}`);
await browser.close();
server.close();
