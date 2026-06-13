#!/usr/bin/env node
/*
 * test/parse-sample.js
 * --------------------
 * Development harness: runs the *real* browser parser (js/pdf-parser.js) against
 * a PDF in Node and prints the structured result as JSON. Useful for checking
 * parsing against new sample exports without opening a browser.
 *
 * Usage:
 *   npm install pdfjs-dist@3.11.174 xlsx@0.18.5
 *   node test/parse-sample.js path/to/profile.pdf
 *
 * Add --xlsx to also write an out.xlsx next to this script.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const pdfPath = process.argv[2];
const alsoXlsx = process.argv.includes('--xlsx');

if (!pdfPath) {
  console.error('Usage: node test/parse-sample.js <path-to-pdf> [--xlsx]');
  process.exit(1);
}

let pdfjsLib;
try {
  pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
} catch (e) {
  console.error('Missing dependency. Run: npm install pdfjs-dist@3.11.174 xlsx@0.18.5');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');

// Minimal browser shim so the IIFEs in the app files attach to "window".
global.window = global.window || {};
global.window.pdfjsLib = pdfjsLib;

// Load the actual application parser.
eval(fs.readFileSync(path.join(repoRoot, 'js', 'pdf-parser.js'), 'utf8'));

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const candidate = await global.window.LinkedInParser.parseArrayBuffer(data, path.basename(pdfPath));
  console.log(JSON.stringify(candidate, null, 2));

  if (alsoXlsx) {
    const XLSX = require('xlsx');
    global.window.XLSX = XLSX;
    global.XLSX = XLSX;
    const orig = XLSX.writeFile;
    XLSX.writeFile = (wb) => orig(wb, path.join(repoRoot, 'test', 'out.xlsx'));
    eval(fs.readFileSync(path.join(repoRoot, 'js', 'excel-export.js'), 'utf8'));
    global.window.ExcelExport.download([candidate]);
    console.error('\nWrote test/out.xlsx');
  }
})().catch((err) => {
  console.error('Parse failed:', err);
  process.exit(1);
});
