// Fixed, bounded client for the optional Pupa GNOME Shell extension.
// The reply contains only a foreground app name, never clipboard/window text.
const Gio = imports.gi.Gio;
try {
    const args = ARGV[0] === '--' ? ARGV.slice(1) : ARGV;
    if (args[0] === 'icon') {
        const name = args[1] || '';
        print(JSON.stringify({name, icon: localAppIcon(name)}));
    } else {
    const reply = Gio.DBus.session.call_sync(
        'org.gnome.Shell', '/jp/kuro0315/Pupa/SourceApp',
        'jp.kuro0315.Pupa.SourceApp', 'GetSource', null, null,
        Gio.DBusCallFlags.NO_AUTO_START, 700, null);
    const source = JSON.parse(reply.deep_unpack()[0]);
    if (source && typeof source.name === 'string') {
        try { source.icon = localAppIcon(source.name); } catch (_) {}
    }
    print(JSON.stringify(source));
    }
} catch (_) {
    print('null');
}
