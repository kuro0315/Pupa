'use strict';

const { execFileSync } = require('node:child_process');

const PORTAL_APP_ID = 'jp.kuro0315.pupa';
const DESKTOP_PATH = `usr/share/applications/${PORTAL_APP_ID}.desktop`;

function validateIdentity(contents) {
  const lines = contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const expected of ['[Desktop Entry]', 'Type=Application', 'Name=Pupa', 'Exec=pupa', 'Icon=pupa', 'NoDisplay=true']) {
    if (lines.filter(line => line === expected).length !== 1) throw new Error(`Invalid portal desktop identity: ${expected}`);
  }
  for (const key of ['Type', 'Name', 'Exec', 'Icon', 'NoDisplay']) {
    if (lines.filter(line => line.startsWith(`${key}=`)).length !== 1) throw new Error(`Duplicate portal desktop key: ${key}`);
  }
  return PORTAL_APP_ID;
}

function verifyDebIdentity(file) {
  // Read a named metadata member only. Never install the package, run maintainer
  // scripts or extract arbitrary paths from the archive during verification.
  const archive = execFileSync('dpkg-deb', ['--fsys-tarfile', file], { maxBuffer: 128 * 1024 * 1024 });
  const listing = execFileSync('tar', ['-tf', '-'], { input: archive, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  const members = listing.split('\n').filter(name => name === DESKTOP_PATH || name === `./${DESKTOP_PATH}`);
  if (members.length !== 1) throw new Error('The deb must contain exactly one portal desktop identity');
  const contents = execFileSync('tar', ['-xOf', '-', '--', members[0]], { input: archive, maxBuffer: 64 * 1024, encoding: 'utf8' });
  return validateIdentity(contents);
}

module.exports = { PORTAL_APP_ID, DESKTOP_PATH, validateIdentity, verifyDebIdentity };
