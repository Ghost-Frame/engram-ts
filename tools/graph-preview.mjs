#!/usr/bin/env node
import { execSync } from 'child_process';
/**
 * graph-preview.mjs - Visual feedback tool for Engram GUI development
 *
 * Renders engram-gui.html with real or mock data, takes a screenshot,
 * and saves it so Claude Code can view it with the Read tool.
 *
 * Usage:
 *   node tools/graph-preview.mjs [options]
 *
 * Options:
 *   --html <path>      Path to HTML file (default: ./engram-gui.html)
 *   --output <path>    Screenshot output path (default: ./tools/preview.png)
 *   --width <n>        Viewport width (default: 1920)
 *   --height <n>       Viewport height (default: 1080)
 *   --wait <ms>        Wait time after load for simulation to settle (default: 4000)
 *   --mock             Use built-in mock data instead of real API
 *   --api <url>        Engram API base URL (default: $ENGRAM_URL or http://100.64.0.13:4200)
 *   --api-key <key>    Engram API key (default: $ENGRAM_API_KEY)
 *   --zoom <level>     Zoom level: "fit", "close", "detail" (default: fit)
 *   --region <x,y,w,h> Capture specific region (CSS pixels)
 *   --no-ui            Hide sidebar/topbar/legend for clean graph capture
 *   --compare <path>   Reference image to show side-by-side
 *   --multi            Take 3 shots: full, zoomed, detail (outputs preview-full.png, etc.)
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  if (args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return true;
}
function hasFlag(name) { return args.includes('--' + name); }

const config = {
  html: resolve(getArg('html', resolve(PROJECT_ROOT, 'engram-gui.html'))),
  output: resolve(getArg('output', resolve(__dirname, 'preview.png'))),
  width: parseInt(getArg('width', '1920')),
  height: parseInt(getArg('height', '1080')),
  wait: parseInt(getArg('wait', '4000')),
  useMock: hasFlag('mock'),
  apiUrl: getArg('api', process.env.ENGRAM_URL || 'http://100.64.0.13:4200'),
  apiKey: getArg('api-key', process.env.ENGRAM_API_KEY || (() => { try { return execSync('cred get engram api-key-claude --raw', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); } catch { return ''; } })()),
  zoom: getArg('zoom', 'fit'),
  region: getArg('region', null),
  noUi: hasFlag('no-ui'),
  compare: getArg('compare', null),
  multi: hasFlag('multi'),
};

// Generate mock graph data (enough to test visual rendering)
function generateMockData() {
  const categories = ['task', 'discovery', 'decision', 'state', 'issue', 'reference'];
  const nodes = [];
  const edges = [];

  // Create 120 mock nodes across categories
  for (let i = 1; i <= 120; i++) {
    const cat = categories[i % categories.length];
    nodes.push({
      id: `m${i}`,
      label: `Memory ${i}: ${cat} item with some label text`,
      type: 'memory',
      category: cat,
      importance: 0.3 + Math.random() * 0.7,
      confidence: 0.5 + Math.random() * 0.5,
      group: cat,
      size: 5 + Math.random() * 5,
      source: ['claude-code', 'opencode', 'gir', 'forge'][i % 4],
      created_at: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
      is_static: 0,
      is_forgotten: 0,
      is_archived: 0,
      source_count: Math.floor(Math.random() * 4) + 1,
      content: `This is the content of memory ${i}. It belongs to the ${cat} category and has some meaningful content that describes what was learned or tracked.`,
      version: 1,
    });
  }

  // Add some entities and projects
  for (let i = 1; i <= 15; i++) {
    nodes.push({
      id: `e${i}`,
      label: `Entity ${i}`,
      type: 'entity',
      category: 'entity',
      importance: 0.6 + Math.random() * 0.4,
      confidence: 0.9,
      group: 'entity',
      size: 8,
      source: 'system',
      created_at: new Date().toISOString(),
      source_count: Math.floor(Math.random() * 6) + 2,
      content: `Entity node ${i}`,
    });
  }

  for (let i = 1; i <= 5; i++) {
    nodes.push({
      id: `p${i}`,
      label: `Project ${i}`,
      type: 'project',
      category: 'project',
      importance: 0.8,
      confidence: 1,
      group: 'project',
      size: 10,
      source: 'system',
      created_at: new Date().toISOString(),
      source_count: 5,
      content: `Project node ${i}`,
    });
  }

  // Create edges (similarity links between memories)
  const memNodes = nodes.filter(n => n.id.startsWith('m'));
  for (let i = 0; i < 250; i++) {
    const a = memNodes[Math.floor(Math.random() * memNodes.length)];
    const b = memNodes[Math.floor(Math.random() * memNodes.length)];
    if (a.id !== b.id) {
      edges.push({
        source: a.id,
        target: b.id,
        type: 'similarity',
        weight: 0.5 + Math.random() * 0.5,
      });
    }
  }

  // Entity-memory links
  const entNodes = nodes.filter(n => n.id.startsWith('e'));
  for (const ent of entNodes) {
    const count = 3 + Math.floor(Math.random() * 8);
    for (let i = 0; i < count; i++) {
      const mem = memNodes[Math.floor(Math.random() * memNodes.length)];
      edges.push({ source: ent.id, target: mem.id, type: 'entity_link', weight: 0.7 });
    }
  }

  return {
    nodes,
    edges,
    links: edges,
    node_count: nodes.length,
    edge_count: edges.length,
  };
}

// Fetch real graph data from Engram API
async function fetchRealData() {
  const url = `${config.apiUrl}/graph`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Engram API returned ${res.status}`);
  return res.json();
}

// Start local server to serve the HTML and intercept API calls
function startServer(htmlContent, graphData) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
      } else if (req.url === '/graph') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(graphData));
      } else if (req.url === '/inbox') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      } else if (req.url === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
      } else {
        // Proxy other requests to real API
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function takeScreenshot(page, outputPath, label) {
  await page.screenshot({ path: outputPath, type: 'png' });
  const size = readFileSync(outputPath).length;
  console.log(`  ${label}: ${outputPath} (${(size / 1024).toFixed(0)}KB)`);
}

async function main() {
  console.log('Engram Graph Preview Tool');
  console.log('========================');

  // Read HTML
  if (!existsSync(config.html)) {
    console.error(`HTML file not found: ${config.html}`);
    process.exit(1);
  }
  let htmlContent = readFileSync(config.html, 'utf-8');

  // Patch the BASE URL to point to our local server (will be set after server starts)
  // The HTML uses: var BASE = window.location.origin; or similar
  // We'll handle this by serving from localhost

  // Get graph data
  console.log(config.useMock ? 'Using mock data...' : 'Fetching real graph data...');
  let graphData;
  try {
    graphData = config.useMock ? generateMockData() : await fetchRealData();
    console.log(`  Nodes: ${graphData.nodes?.length || graphData.node_count}`);
    console.log(`  Edges: ${(graphData.edges || graphData.links)?.length || graphData.edge_count}`);
  } catch (e) {
    console.error(`Failed to get graph data: ${e.message}`);
    if (!config.useMock) {
      console.log('Falling back to mock data...');
      graphData = generateMockData();
    } else {
      process.exit(1);
    }
  }

  // Start local server
  const { server, port } = await startServer(htmlContent, graphData);
  const localUrl = `http://127.0.0.1:${port}`;
  console.log(`Local server: ${localUrl}`);

  // Launch browser
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl2-compute-context'],
  });

  const page = await browser.newPage({
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: 2,  // Retina for crisp screenshots
  });

  // Collect console messages for debugging
  const consoleMsgs = [];
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warn') {
      consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => consoleMsgs.push(`[PAGE ERROR] ${err.message}`));

  try {
    console.log('Loading page...');
    await page.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for loading overlay to disappear (graph loaded and rendered)
    console.log('Waiting for graph to render...');
    try {
      await page.waitForSelector('#loading.hidden', { timeout: 15000 });
    } catch {
      console.warn('  Loading overlay did not hide (graph may not have loaded). Taking screenshot anyway.');
    }

    // Wait for force simulation to settle
    console.log(`Waiting ${config.wait}ms for simulation to settle...`);
    await page.waitForTimeout(config.wait);

    // Hide UI elements if requested
    if (config.noUi) {
      await page.evaluate(() => {
        ['topbar', 'sidebar', 'legend-wrap', 'nav-controls', 'timeline-bar', 'list-panel', 'inbox-panel'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      });
      await page.waitForTimeout(100);
    }

    if (config.multi) {
      // Multi-shot mode: full, zoomed center, detail
      const base = config.output.replace(/\.png$/, '');

      // Full view
      await takeScreenshot(page, `${base}-full.png`, 'Full view');

      // Zoom to center (simulate scroll zoom)
      await page.evaluate(() => {
        // Trigger a zoom via d3 if available, or use transform
        const canvas = document.getElementById('graph');
        if (canvas && window.d3) {
          // Simulate zoom to 2x
          const evt = new WheelEvent('wheel', {
            deltaY: -300, clientX: canvas.width / 4, clientY: canvas.height / 4
          });
          canvas.dispatchEvent(evt);
        }
      });
      await page.waitForTimeout(1500);
      await takeScreenshot(page, `${base}-zoom.png`, 'Zoomed view');

      // Zoom further for detail
      await page.evaluate(() => {
        const canvas = document.getElementById('graph');
        if (canvas) {
          for (let i = 0; i < 3; i++) {
            canvas.dispatchEvent(new WheelEvent('wheel', {
              deltaY: -200, clientX: canvas.width / 4, clientY: canvas.height / 4
            }));
          }
        }
      });
      await page.waitForTimeout(1500);
      await takeScreenshot(page, `${base}-detail.png`, 'Detail view');

      console.log('\nAll screenshots saved. View with Read tool:');
      console.log(`  ${base}-full.png`);
      console.log(`  ${base}-zoom.png`);
      console.log(`  ${base}-detail.png`);
    } else {
      // Single shot
      await takeScreenshot(page, config.output, 'Screenshot');
      console.log(`\nScreenshot saved. View with Read tool:`);
      console.log(`  ${config.output}`);
    }

    // Report any console errors
    if (consoleMsgs.length > 0) {
      console.log('\nBrowser console messages:');
      consoleMsgs.slice(0, 10).forEach(m => console.log(`  ${m}`));
      if (consoleMsgs.length > 10) console.log(`  ... and ${consoleMsgs.length - 10} more`);
    }

  } finally {
    await browser.close();
    server.close();
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
