#!/usr/bin/env node
'use strict';

/**
 * scripts/update-readme.js
 * ---------------------------------------------------------------------------
 * Run by .github/workflows/release.yml right after a release's assets are
 * all uploaded. Rewrites the three marked download blocks in README.md
 * (Windows / macOS / Linux) to point at this release's real asset URLs, and
 * bumps the version number mentioned elsewhere in the file.
 *
 * Usage:
 *   node scripts/update-readme.js <tag> <path-to-assets.json>
 *
 * <path-to-assets.json> is the raw `.assets` array from the GitHub Releases
 * API for that tag, e.g. produced by:
 *   gh api repos/OWNER/REPO/releases/tags/<tag> --jq '.assets' > assets.json
 *
 * README.md must contain these marker pairs for this script to find where
 * to write (see the README diff that introduced them):
 *   <!-- DOWNLOAD_WIN_START -->  ... <!-- DOWNLOAD_WIN_END -->
 *   <!-- DOWNLOAD_MAC_START -->  ... <!-- DOWNLOAD_MAC_END -->
 *   <!-- DOWNLOAD_LINUX_START --> ... <!-- DOWNLOAD_LINUX_END -->
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const [, , tag, assetsPath] = process.argv;
if (!tag || !assetsPath) {
  console.error('Usage: node scripts/update-readme.js <tag> <assets.json>');
  process.exit(1);
}

// Repo's tags look like "v.2.1.0" (literal dot after the v) — strip
// whichever prefix is present so this works for "v.2.1.0" or "v2.1.0" alike.
const version = tag.replace(/^v\.?/, '');

const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf-8'));

function findAssetUrl(re) {
  const asset = assets.find((a) => re.test(a.name));
  return asset ? asset.browser_download_url : null;
}

const winUrl = findAssetUrl(/\.exe$/i);
const macUrl = findAssetUrl(/\.dmg$/i);
const linuxUrl = findAssetUrl(/\.AppImage$/i);

const readmePath = path.join(process.cwd(), 'README.md');
let readme = fs.readFileSync(readmePath, 'utf-8');

function replaceBlock(name, url, label, logo, extraLine) {
  const startMarker = `<!-- DOWNLOAD_${name}_START -->`;
  const endMarker = `<!-- DOWNLOAD_${name}_END -->`;
  const blockRe = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);

  if (!blockRe.test(readme)) {
    console.warn(`Markers for ${name} not found in README.md — skipping that block`);
    return;
  }
  if (!url) {
    console.warn(`No ${label} asset found in this release — leaving the ${name} block untouched`);
    return;
  }

  const badge = `[![Download NexGrab for ${label}](https://img.shields.io/badge/Download-NexGrab%20for%20${label.replace(/\s+/g, '%20')}-0ea5e9?style=for-the-badge&logo=${logo}&logoColor=white)](${url})`;
  const body = [badge, extraLine ? `\n${extraLine}` : ''].join('\n').trimEnd();
  const block = `${startMarker}\n${body}\n${endMarker}`;

  readme = readme.replace(blockRe, block);
}

replaceBlock('WIN', winUrl, 'Windows', 'windows', `Download and run **NexGrab Setup ${version} for Windows (64-bit)**.`);
replaceBlock('MAC', macUrl, 'macOS', 'apple');
replaceBlock('LINUX', linuxUrl, 'Linux', 'linux');

// Bump any "NexGrab vX.Y.Z" and "NexGrab Setup X.Y.Z" mentions elsewhere in
// the file (badge alt text, prose) to the new version.
readme = readme.replace(/NexGrab v[\d.]+/g, `NexGrab v${version}`);
readme = readme.replace(/NexGrab Setup [\d.]+/g, `NexGrab Setup ${version}`);

fs.writeFileSync(readmePath, readme);
console.log(`README.md updated for ${tag} (win: ${!!winUrl}, mac: ${!!macUrl}, linux: ${!!linuxUrl})`);
