import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INTERFACE = `<node>
  <interface name="jp.kuro0315.Pupa.SourceApp">
    <method name="GetSource"><arg type="s" direction="out" name="source"/></method>
  </interface>
</node>`;

export default class PupaSourceExtension extends Extension {
    enable() {
        this._service = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._service.export(Gio.DBus.session, '/jp/kuro0315/Pupa/SourceApp');
    }

    GetSource() {
        // Do not remember the last focused app: a stale hint is misleading.
        if (Main.sessionMode.isLocked || Main.overview.visible || !global.display.focus_window)
            return 'null';
        const app = Shell.WindowTracker.get_default().get_window_app(global.display.focus_window);
        if (!app || app.get_id() === 'jp.kuro0315.pupa.desktop')
            return 'null';
        const name = app.get_name();
        return name ? JSON.stringify({name: name.slice(0, 240)}) : 'null';
    }

    disable() {
        this._service?.unexport();
        this._service = null;
    }
}
