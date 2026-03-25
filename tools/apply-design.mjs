#!/usr/bin/env node
/**
 * apply-design.mjs - Apply graph-design.json parameters into engram-gui.html
 *
 * Reads the design config and patches the corresponding values in the HTML.
 * Creates a backup before modifying. Run graph-preview.mjs after to see results.
 *
 * Usage:
 *   node tools/apply-design.mjs [--config tools/graph-design.json] [--html engram-gui.html] [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  return args[i + 1] || def;
}
const dryRun = args.includes('--dry-run');

const configPath = resolve(getArg('config', resolve(__dirname, 'graph-design.json')));
const htmlPath = resolve(getArg('html', resolve(PROJECT_ROOT, 'engram-gui.html')));

console.log('Apply Design Config');
console.log('===================');
console.log(`Config: ${configPath}`);
console.log(`HTML:   ${htmlPath}`);
if (dryRun) console.log('(DRY RUN - no changes will be written)');

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
let html = readFileSync(htmlPath, 'utf-8');
let changes = 0;

function replacePattern(pattern, replacement, label) {
  const match = html.match(pattern);
  if (match) {
    const before = match[0];
    const after = before.replace(pattern, replacement);
    if (before !== after) {
      html = html.replace(before, after);
      changes++;
      console.log(`  [CHANGED] ${label}`);
      console.log(`    - ${before.trim().substring(0, 80)}`);
      console.log(`    + ${after.trim().substring(0, 80)}`);
    } else {
      console.log(`  [OK] ${label} (already matches)`);
    }
  } else {
    console.log(`  [SKIP] ${label} (pattern not found)`);
  }
}

// Apply category colors
console.log('\nCategory colors:');
for (const [cat, color] of Object.entries(config.colors.categories)) {
  const pat = new RegExp(`(${cat}:\\s*\\{\\s*fill:\\s*)'[^']*'`);
  replacePattern(pat, `$1'${color}'`, cat);
}

// Apply force parameters
console.log('\nForce parameters:');
const forceMap = {
  'alpha_initial':       [/\.alpha\([\d.]+\)/, `.alpha(${config.force.alpha_initial})`],
  'alpha_decay':         [/\.alphaDecay\([\d.]+\)/, `.alphaDecay(${config.force.alpha_decay})`],
  'alpha_min':           [/\.alphaMin\([\d.]+\)/, `.alphaMin(${config.force.alpha_min})`],
  'charge_distance_max': [/\.distanceMax\([\d.]+\)/, `.distanceMax(${config.force.charge_distance_max})`],
  'collision_strength':  [/\.force\('collide'[\s\S]*?\.strength\([\d.]+\)/,
                          (m) => m.replace(/\.strength\([\d.]+\)/, `.strength(${config.force.collision_strength})`)],
  'center_strength':     [/d3\.forceCenter\(0,\s*0\)\.strength\([\d.]+\)/,
                          `d3.forceCenter(0, 0).strength(${config.force.center_strength})`],
};

for (const [name, [pat, repl]] of Object.entries(forceMap)) {
  const match = html.match(pat);
  if (match) {
    const before = match[0];
    const after = typeof repl === 'function' ? repl(before) : before.replace(pat, repl);
    if (before !== after) {
      html = html.replace(before, after);
      changes++;
      console.log(`  [CHANGED] ${name}`);
    } else {
      console.log(`  [OK] ${name}`);
    }
  } else {
    console.log(`  [SKIP] ${name}`);
  }
}

// Apply node size parameters
console.log('\nNode sizes:');
const nodeMap = {
  'base_radius':    [/var radius = (\d+) \+ imp/, `var radius = ${config.nodes.base_radius} + imp`],
  'importance_scale': [/imp \* (\d+)/, `imp * ${config.nodes.importance_scale}`],
  'max_radius':     [/radius = Math\.min\(radius, (\d+)\)/, `radius = Math.min(radius, ${config.nodes.max_radius})`],
};

for (const [name, [pat, repl]] of Object.entries(nodeMap)) {
  replacePattern(pat, repl, name);
}

// Apply shader neuron parameters
console.log('\nShader parameters:');
const [w1, w2, w3] = config.shader.neuron_wobble_amplitude;
const [f1, f2, f3] = config.shader.neuron_wobble_frequencies;
// These are in the GLSL shader strings - be careful with regex
const shaderPatterns = {
  'cell_radius': [/float cellR=[\d.]+/, `float cellR=${config.shader.neuron_cell_radius.toFixed(2)}`],
  'nucleus_ratio': [/cellR\*[\d.]+,d\);\n/, `cellR*${config.shader.nucleus_radius_ratio.toFixed(2)},d);\n`],
};

for (const [name, [pat, repl]] of Object.entries(shaderPatterns)) {
  replacePattern(pat, repl, name);
}

console.log(`\n${changes} changes applied.`);

if (changes > 0 && !dryRun) {
  // Backup
  const backupPath = htmlPath + '.pre-design-bak';
  copyFileSync(htmlPath, backupPath);
  console.log(`Backup: ${backupPath}`);

  writeFileSync(htmlPath, html);
  console.log(`Written: ${htmlPath}`);
  console.log('\nRun preview to see results:');
  console.log('  node tools/graph-preview.mjs');
} else if (dryRun) {
  console.log('\nDry run complete. Remove --dry-run to apply.');
}
