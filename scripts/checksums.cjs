'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');

async function main() {
  const directory = resolve(process.argv[2] || 'release');
  const files = (await readdir(directory)).filter((name) => /\.(exe|dmg|zip|AppImage|deb)$/.test(name)).sort();
  if (files.length === 0) throw new Error(`No installers found in ${directory}`);
  const sums = [];
  for (const file of files) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${file}`);
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  console.log(`Wrote SHA256SUMS.txt for ${files.length} installer(s).`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
