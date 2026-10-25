const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const root = path.join(__dirname, '..');

test('local icons require an unambiguous installed app and bounded local PNG', () => {
  class FileIcon { get_file() { return {is_native: () => false}; } to_string() { return 'remote'; } }
  let apps = [], byteCount = 1024;
  const icon = {to_string: () => 'synthetic-icon'};
  const app = (name, value = icon) => ({get_name: () => name, get_display_name: () => name, get_icon: () => value});
  const context = vm.createContext({imports: {gi: {
    versions: {},
    Gio: {AppInfo: {get_all: () => apps}, FileIcon},
    GLib: {base64_encode: bytes => Buffer.from(bytes).toString('base64')},
    Gtk: {init() {}, IconLookupFlags: {FORCE_SIZE: 1}, IconTheme: {get_default: () => ({
      lookup_by_gicon: () => ({load_icon: () => ({get_width: () => 64, get_height: () => 64,
        save_to_bufferv: () => [true, new Uint8Array(byteCount)]})}),
    })}},
  }}});
  vm.runInContext(fs.readFileSync(path.join(root, 'src-tauri/src/gnome-icons.js'), 'utf8'), context);
  const resolve = name => context.localAppIcon(name);
  assert.equal(resolve('Synthetic'), null);
  apps = [app('Synthetic')]; assert.match(resolve('Synthetic'), /^data:image\/png;base64,/);
  assert.equal(resolve('Other'), null);
  apps.push(app('Synthetic', {to_string: () => 'different-icon'})); assert.equal(resolve('Synthetic'), null);
  apps = [app('Synthetic', new FileIcon())]; assert.equal(resolve('Synthetic'), null);
  apps = [app('Synthetic')]; byteCount = 32769; assert.equal(resolve('Synthetic'), null);
});

function extension() {
  let app = {get_id: () => 'synthetic.desktop', get_name: () => 'Synthetic Browser'};
  const main = {sessionMode: {isLocked: false}, overview: {visible: false}};
  const display = {focus_window: {}};
  const exported = {export: (...args) => { exported.args = args; }, unexport: () => { exported.stopped = true; }};
  const context = vm.createContext({
    Gio: {DBusExportedObject: {wrapJSObject: () => exported}, DBus: {session: {}}},
    Shell: {WindowTracker: {get_default: () => ({get_window_app: () => app})}},
    Main: main, global: {display, get_pointer: () => [3100, 2100, 0]}, Extension: class {},
  });
  const code = fs.readFileSync(path.join(root, 'extensions/pupa-source@kuro0315.github.io/extension.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class', 'class');
  vm.runInContext(`${code}\nglobalThis.instance = new PupaSourceExtension();`, context);
  return {instance: context.instance, main, display, exported, setApp: value => { app = value; }};
}

test('GNOME extension exports only a current app name and cleans up its service', () => {
  const f = extension(); f.instance.enable();
  assert.equal(f.exported.args[1], '/jp/kuro0315/Pupa/SourceApp');
  assert.deepEqual(JSON.parse(f.instance.GetSource()), {name: 'Synthetic Browser'});
  f.instance.disable(); assert.equal(f.exported.stopped, true);
  f.instance.disable();
});

test('GNOME extension returns unknown for lock, overview, no focus, missing app and Pupa', () => {
  const f = extension();
  f.main.sessionMode.isLocked = true; assert.equal(f.instance.GetSource(), 'null');
  f.main.sessionMode.isLocked = false; f.main.overview.visible = true;
  assert.equal(f.instance.GetSource(), 'null');
  f.main.overview.visible = false; f.display.focus_window = null;
  assert.equal(f.instance.GetSource(), 'null');
  f.display.focus_window = {}; f.setApp(null); assert.equal(f.instance.GetSource(), 'null');
  f.setApp({get_id: () => 'jp.kuro0315.pupa.desktop'});
  assert.equal(f.instance.GetSource(), 'null');
});

test('placement reads the live compositor pointer even over a native Wayland app', () => {
  const f = extension();
  f.display.focus_window = null;
  f.main.overview.visible = true;
  assert.deepEqual(JSON.parse(f.instance.GetPointer()), {x: 3100, y: 2100});
  f.main.sessionMode.isLocked = true;
  assert.equal(f.instance.GetPointer(), 'null');
});

const hasGjs = fs.existsSync('/usr/bin/gjs') && fs.existsSync('/usr/bin/dbus-run-session');
test('actual GJS client reads synthetic D-Bus service and handles unavailable extension', {skip: !hasGjs}, () => {
  const result = execFileSync('dbus-run-session', ['--', process.execPath,
    path.join(__dirname, 'helpers/gnome-source-runner.cjs')], {encoding: 'utf8', timeout: 15000});
  assert.equal(result.trim(), 'ok');
});
