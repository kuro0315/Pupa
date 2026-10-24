'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PORTAL_APP_ID, DESKTOP_PATH, validateIdentity } = require('../scripts/linux-identity.cjs');

const identity = readFileSync(join(__dirname, '../build/jp.kuro0315.pupa.desktop'), 'utf8');

test('packaged portal identity matches both Linux formats without changing the visible launcher', () => {
  assert.equal(validateIdentity(identity), PORTAL_APP_ID);
  const config = JSON.parse(readFileSync(join(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.identifier, PORTAL_APP_ID);
  assert.equal(config.productName, 'Pupa');
  for (const format of ['deb', 'appimage']) {
    assert.equal(config.bundle.linux[format].files[`/${DESKTOP_PATH}`], '../build/jp.kuro0315.pupa.desktop');
  }
});

test('portal desktop validation rejects missing or conflicting application metadata', () => {
  for (const key of ['Name=Pupa', 'Exec=pupa', 'Icon=pupa', 'NoDisplay=true']) {
    assert.throws(() => validateIdentity(identity.replace(key, '')));
  }
  assert.throws(() => validateIdentity(`${identity}\nExec=another-application\n`));
});
