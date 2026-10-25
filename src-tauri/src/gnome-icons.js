// Local desktop metadata only. Never download artwork or execute desktop files.
function localAppIcon(name) {
    try {
        imports.gi.versions.Gtk = '3.0';
        const Gtk = imports.gi.Gtk;
        const Gio = imports.gi.Gio;
        const GLib = imports.gi.GLib;
        const matches = Gio.AppInfo.get_all().filter(app =>
            app.get_display_name() === name || app.get_name() === name);
        // Ambiguous display names must not pick an unrelated application's logo.
        const icons = matches.map(app => app.get_icon()).filter(Boolean);
        if (!icons.length || new Set(icons.map(icon => icon.to_string())).size !== 1)
            return null;
        const icon = icons[0];
        if (icon instanceof Gio.FileIcon && !icon.get_file().is_native())
            return null;
        Gtk.init(null);
        const info = Gtk.IconTheme.get_default().lookup_by_gicon(icon, 64, Gtk.IconLookupFlags.FORCE_SIZE);
        if (!info)
            return null;
        const pixbuf = info.load_icon();
        if (pixbuf.get_width() > 256 || pixbuf.get_height() > 256)
            return null;
        const [ok, bytes] = pixbuf.save_to_bufferv('png', [], []);
        return ok && bytes.length <= 32768 ? `data:image/png;base64,${GLib.base64_encode(bytes)}` : null;
    } catch (_) {
        return null;
    }
}
