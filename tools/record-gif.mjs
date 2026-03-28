#!/usr/bin/env node
/**
 * record-gif.mjs - Record a slow-orbit GIF of the Engram 3D graph
 *
 * Serves the built SvelteKit app, loads the graph page, orbits the
 * camera slowly, captures frames as PNGs, then stitches them into a GIF
 * using Python PIL.
 *
 * Usage:
 *   node tools/record-gif.mjs [options]
 *
 * Options:
 *   --frames <n>     Number of frames to capture (default: 90)
 *   --delay <ms>     Delay between frames in the GIF in ms (default: 100)
 *   --orbit <deg>    Total orbit angle in degrees (default: 360)
 *   --width <n>      Viewport width (default: 1280)
 *   --height <n>     Viewport height (default: 720)
 *   --wait <ms>      Wait for simulation to settle (default: 8000)
 *   --output <path>  Output GIF path (default: tools/gui-demo.gif)
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  if (args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return true;
}

const config = {
  frames: parseInt(getArg('frames', '60')),
  delay: parseInt(getArg('delay', '150')),
  orbitDeg: parseFloat(getArg('orbit', '360')),
  width: parseInt(getArg('width', '1280')),
  height: parseInt(getArg('height', '720')),
  scale: parseFloat(getArg('scale', '1')),
  wait: parseInt(getArg('wait', '8000')),
  output: resolve(getArg('output', resolve(__dirname, 'gui-demo.gif'))),
};

// Serve the SvelteKit build directory + proxy /graph to Engram API
function startServer() {
  const buildDir = resolve(PROJECT_ROOT, 'gui', 'build');
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
  };

  const apiUrl = process.env.ENGRAM_URL || 'http://100.64.0.13:4200';
  const apiKey = process.env.ENGRAM_API_KEY || '';

  return new Promise((res) => {
    const server = http.createServer(async (req, resp) => {
      const url = new URL(req.url, 'http://localhost');

      // Proxy /api/* routes to Engram
      if (url.pathname.startsWith('/api/')) {
        const apiPath = url.pathname.replace('/api', '');
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const apiResp = await fetch(`${apiUrl}${apiPath}${url.search}`, { headers });
          const body = await apiResp.text();
          resp.writeHead(apiResp.status, { 'Content-Type': 'application/json' });
          resp.end(body);
        } catch (e) {
          resp.writeHead(502, { 'Content-Type': 'application/json' });
          resp.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // Serve static files from build dir
      let filePath = resolve(buildDir, url.pathname.replace(/^\//, ''));
      if (!existsSync(filePath) || !filePath.includes('.')) {
        filePath = resolve(buildDir, 'index.html');
      }
      if (existsSync(filePath)) {
        const ext = '.' + filePath.split('.').pop();
        resp.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        resp.end(readFileSync(filePath));
      } else {
        resp.writeHead(404);
        resp.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      res({ server, port: server.address().port });
    });
  });
}

async function main() {
  console.log('Engram GIF Recorder');
  console.log('===================');
  console.log(`Frames: ${config.frames}, Delay: ${config.delay}ms, Orbit: ${config.orbitDeg}deg`);
  console.log(`Resolution: ${config.width}x${config.height}`);

  const { server, port } = await startServer();
  const localUrl = `http://127.0.0.1:${port}`;
  console.log(`Server: ${localUrl}`);

  // Create temp dir for frames
  const framesDir = resolve(__dirname, '.gif-frames');
  if (existsSync(framesDir)) {
    readdirSync(framesDir).forEach(f => unlinkSync(resolve(framesDir, f)));
  } else {
    mkdirSync(framesDir);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl2-compute-context'],
  });

  const page = await browser.newPage({
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: 1,
  });

  page.on('console', msg => {
    console.log(`  [browser:${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', err => console.log(`  [page-error] ${err.message}`));

  try {
    // Set API key in localStorage before navigating
    const apiKey = process.env.ENGRAM_API_KEY || '';
    if (apiKey) {
      await page.goto(`${localUrl}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate((key) => localStorage.setItem('engram_api_key', key), apiKey);
    }

    console.log('Loading graph page...');
    await page.goto(`${localUrl}/graph`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for graph instance to be available
    try {
      await page.waitForFunction(() => (window).__graph != null, { timeout: 20000 });
    } catch {
      console.warn('Graph instance not found on window. Waiting extra time...');
    }

    console.log(`Waiting ${config.wait}ms for simulation to settle...`);
    await page.waitForTimeout(config.wait);

    // Zoom to fit, then pull camera in closer for detail
    await page.evaluate(() => {
      const g = (window).__graph;
      if (g) g.zoomToFit(800, 100);
    });
    await page.waitForTimeout(2000);

    // Get camera position after zoomToFit, then move 60% closer
    const camInfo = await page.evaluate(() => {
      const g = (window).__graph;
      if (!g) return null;
      const pos = g.cameraPosition();
      const dist = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
      return { x: pos.x, y: pos.y, z: pos.z, dist };
    });

    if (!camInfo) {
      throw new Error('Could not access graph camera');
    }

    // Use 15% of the zoomToFit distance for a close, detailed view showing node detail
    const orbitDist = camInfo.dist * 0.15;
    console.log(`Camera distance: zoomToFit=${camInfo.dist.toFixed(0)}, orbit=${orbitDist.toFixed(0)}`);

    // Position camera at orbit distance, looking at center
    await page.evaluate(({ dist }) => {
      const g = (window).__graph;
      if (g) g.cameraPosition({ x: 0, y: dist * 0.15, z: dist }, { x: 0, y: 0, z: 0 }, 0);
    }, { dist: orbitDist });
    await page.waitForTimeout(500);

    console.log(`Capturing ${config.frames} frames...`);

    const angleStep = (config.orbitDeg * Math.PI / 180) / config.frames;

    for (let i = 0; i < config.frames; i++) {
      const angle = angleStep * i;
      const x = orbitDist * Math.sin(angle);
      const z = orbitDist * Math.cos(angle);
      const y = orbitDist * 0.15;  // slight elevation

      await page.evaluate(({ x, y, z }) => {
        const g = (window).__graph;
        if (g) g.cameraPosition({ x, y, z }, { x: 0, y: 0, z: 0 }, 0);
      }, { x, y, z });

      // Wait for render + breathing animation to update
      await page.waitForTimeout(80);

      const framePath = resolve(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png' });

      if ((i + 1) % 10 === 0 || i === 0) {
        process.stdout.write(`  ${i + 1}/${config.frames}\n`);
      }
    }

    console.log('All frames captured.');

  } finally {
    await browser.close();
    server.close();
  }

  // Stitch frames into GIF using Python PIL
  console.log('Stitching GIF...');
  const { writeFileSync: writeSync } = await import('fs');
  const stitchScript = resolve(framesDir, 'stitch.py');
  writeSync(stitchScript, `
import glob, os
from PIL import Image

frames_dir = r"${framesDir.replace(/\\/g, '/')}"
output = r"${config.output.replace(/\\/g, '/')}"
delay = ${config.delay}

frame_files = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))
if not frame_files:
    raise RuntimeError("No frames found")

import subprocess, imageio_ffmpeg
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
fps = 1000.0 / delay

# Two-pass ffmpeg GIF encoding with optimized palette (the gold standard)
palette_path = os.path.join(frames_dir, "palette.png")

# Two-pass ffmpeg GIF encoding with optimized palette
# Pass 1: Generate palette
subprocess.run([
    ffmpeg, "-y",
    "-framerate", str(fps),
    "-i", os.path.join(frames_dir, "frame_%04d.png"),
    "-vf", "palettegen=max_colors=256:stats_mode=full",
    palette_path
], check=True, capture_output=True)
print("Palette generated")

# Pass 2: Encode GIF
result = subprocess.run([
    ffmpeg, "-y",
    "-framerate", str(fps),
    "-i", os.path.join(frames_dir, "frame_%04d.png"),
    "-i", palette_path,
    "-filter_complex", "[0:v][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop", "0",
    output
], capture_output=True, text=True)
if result.returncode != 0:
    print("STDERR:", result.stderr[-500:])
    raise RuntimeError(f"ffmpeg failed with code {result.returncode}")

size = os.path.getsize(output)
print(f"Saved: {output} ({size / 1024:.0f}KB)")
`);

  execSync(`python "${stitchScript}"`, { stdio: 'inherit' });

  // Cleanup frames
  readdirSync(framesDir).forEach(f => unlinkSync(resolve(framesDir, f)));
  try { execSync(`rmdir ${JSON.stringify(framesDir)}`); } catch {}

  console.log('\nDone!');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
