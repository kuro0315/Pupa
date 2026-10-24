'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readdir, writeFile, stat, mkdir, copyFile } = require('node:fs/promises');
const { resolve, join, basename, extname } = require('node:path');
const { version } = require('../package.json');

function installerName(file) {
  const extension = extname(file);
  const target = process.env.PUPA_BUILD_TARGET || '';
  const arm64 = target ? target.startsWith('aarch64-') : process.arch === 'arm64';
  const suffix = {
    '.exe': 'windows-x64-setup.exe',
    '.dmg': `mac-${arm64 ? 'arm64' : 'x64'}.dmg`,
    '.AppImage': `linux-${arm64 ? 'aarch64' : 'x86_64'}.AppImage`,
    '.deb': `linux-${arm64 ? 'arm64' : 'amd64'}.deb`,
  }[extension];
  if (!suffix) throw new Error(`Unsupported installer: ${file}`);
  return `Pupa-${version}-${suffix}`;
}

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(target));
    else if (/\.(exe|dmg|AppImage|deb)$/.test(item.name)) files.push(target);
  }
  return files;
}
async function main() {
  const input = resolve(process.argv[2] || 'release');
  const output = resolve(process.argv[3] || 'release');
  const files = (await walk(input)).sort();
  if (!files.length) throw new Error(`No installers found in ${input}`);
  await mkdir(output, { recursive: true });
  const manifest = { commit: process.env.GITHUB_SHA || null, version, target: process.env.PUPA_BUILD_TARGET || null, platform: process.platform, arch: process.arch, files: [] };
  for (const file of files) {
    const name = installerName(file);
    if (manifest.files.some(item => item.name === name)) throw new Error(`Duplicate installer name: ${name}`);
    const destination = join(output, name);
    if (file !== destination) await copyFile(file, destination);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    const entry = { name, originalName: basename(file), bytes: (await stat(destination)).size, sha256: hash.digest('hex') };
    manifest.files.push(entry);
    console.log(`${entry.name}\t${entry.bytes} bytes\tSHA256 ${entry.sha256}`);
  }
  await writeFile(join(output, 'SHA256SUMS.txt'), manifest.files.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
  await writeFile(join(output, 'installer-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Recorded ${files.length} individual installer(s), not the enclosing CI artifact ZIP size.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
