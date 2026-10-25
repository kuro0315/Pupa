// Runs only inside dbus-run-session: never queries the user's desktop.
const {spawn, execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
process.env.GIO_USE_VFS = 'local';
const sourceDir = path.join(__dirname, '../../src-tauri/src');
const client = ['gnome-icons.js', 'gnome-source.js'].map(name => fs.readFileSync(path.join(sourceDir, name), 'utf8')).join('\n');
const runClient = () => execFileSync('/usr/bin/gjs', ['-c', client], {encoding: 'utf8', timeout: 3000});
assert.equal(runClient().trim(), 'null');
const service = spawn('/usr/bin/gjs', ['-c', `
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const xml = '<node><interface name="jp.kuro0315.Pupa.SourceApp"><method name="GetSource"><arg type="s" direction="out"/></method></interface></node>';
let calls = 0;
const object = Gio.DBusExportedObject.wrapJSObject(xml, {
  GetSourceAsync(_args, invocation) {
    if (++calls === 1)
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({name: 'Synthetic 日本語 Browser'})]));
    // Subsequent calls deliberately never reply, exercising the client timeout.
  }
});
object.export(Gio.DBus.session, '/jp/kuro0315/Pupa/SourceApp');
Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.gnome.Shell', Gio.BusNameOwnerFlags.NONE,
  () => print('ready'), () => {});
new GLib.MainLoop(null, false).run();
`], {stdio: ['ignore', 'pipe', 'inherit']});
let ran = false;
service.stdout.on('data', data => {
  if (ran || !data.toString().includes('ready')) return;
  ran = true;
  try {
    const result = runClient();
    assert.deepEqual(JSON.parse(result), {name: 'Synthetic 日本語 Browser', icon: null});
    assert.equal(runClient().trim(), 'null');
    process.stdout.write('ok\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { service.kill(); }
});
service.on('exit', () => { if (!ran) process.exitCode = 1; });
