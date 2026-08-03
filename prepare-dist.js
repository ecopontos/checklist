const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Files and directories to copy to dist/
const ASSETS = [
  '*.html',
  '*.css',
  '*.js',
  'vendor',
  'config.js',
  'config.local.example.js',
];

// Directories/files to exclude from copy
const EXCLUDE = new Set([
  'dist',
  'src-tauri',
  'node_modules',
  'electron',
  'gas',
  'legado',
  'tests',
  'docs',
  '.git',
  '.github',
  '.claude',
  '.remember',
  '.superpowers',
  '.worktrees',
  '.playwright-mcp',
  'package.json',
  'package-lock.json',
  'PUBLICACAO.md',
  'public',
]);

// Clean dist
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

function copyFile(src, relPath) {
  const dest = path.join(DIST, relPath);
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

function copyDir(src, relPath) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destRel = path.join(relPath, entry.name);
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.isDirectory()) {
      copyDir(srcPath, destRel);
    } else {
      copyFile(srcPath, destRel);
    }
  }
}

// Copy root-level files
const rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
for (const entry of rootEntries) {
  if (EXCLUDE.has(entry.name)) continue;
  if (entry.isDirectory()) {
    copyDir(entry.name, entry.name);
  } else {
    // Copy files matching our asset patterns
    const ext = path.extname(entry.name).toLowerCase();
    if (['.html', '.css', '.js', '.json'].includes(ext)) {
      copyFile(entry.name, entry.name);
    }
  }
}

console.log('Frontend assets copied to dist/');
