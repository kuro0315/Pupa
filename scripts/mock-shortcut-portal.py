#!/usr/bin/env python3
"""Protocol fixture only: private CI bus, never a user session or real portal.

Implements the public xdg-desktop-portal ABI using actual D-Bus messages. The
fixture is deliberately independent of ashpd and the app's Rust implementation.
https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html
"""
import asyncio
import json
import os
import sys
from dbus_next import Message, MessageType, NameFlag, RequestNameReply, Variant
from dbus_next.aio import MessageBus

NAME = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
GLOBAL = 'org.freedesktop.portal.GlobalShortcuts'
REGISTRY = 'org.freedesktop.host.portal.Registry'
SESSION = 'org.freedesktop.portal.Session'
REQUEST = 'org.freedesktop.portal.Request'
TRIGGER = 'Ctrl+Shift+Space (mock portal)'


def plain(value):
    if isinstance(value, Variant):
        return {'signature': value.signature, 'value': plain(value.value)}
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value


def output(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class Portal:
    def __init__(self, bus, emit=output):
        self.bus = bus
        self.emit = emit
        self.mode = 'accepted'
        self.delay = 0.08
        self.hold = False
        self.held = {}
        self.hold_configure = False
        self.configuring = []
        self.registrations = {}
        self.sessions = {}
        self.requests = {}
        self.saved = []
        self.calls = []
        self.closed = []

    def log(self, event, **values):
        self.emit({'event': event, **plain(values)})

    def bindings(self, shortcuts):
        return [[item[0], {'description': Variant('s', item[1]['description'].value),
                           'trigger_description': Variant('s', TRIGGER)}] for item in shortcuts]

    def response(self, request, code, results):
        if request not in self.requests:
            return
        del self.requests[request]
        self.held.pop(request, None)
        self.log('response', path=request, code=code, results=results)
        self.bus.send(Message.new_signal(request, REQUEST, 'Response', 'ua{sv}', [code, results]))

    def request(self, message, options, code, results, delayed=True):
        sender = message.sender[1:].replace('.', '_')
        token = options['handle_token'].value
        path = f'{PATH}/request/{sender}/{token}'
        self.requests[path] = message.sender
        if delayed and self.hold:
            self.held[path] = (code, results)
        else:
            asyncio.get_running_loop().call_later(self.delay if delayed else 0.01, self.response, path, code, results)
        return Message.new_method_return(message, 'o', [path])

    def handle(self, message):
        if message.message_type != MessageType.METHOD_CALL:
            return None
        if not message.path.startswith(PATH):
            return None
        self.calls.append({'interface': message.interface, 'member': message.member,
                           'path': message.path, 'sender': message.sender, 'signature': message.signature,
                           'body': plain(message.body)})
        self.log('call', **self.calls[-1])
        try:
            if message.interface == 'org.freedesktop.DBus.Properties':
                interface = message.body[0]
                if self.mode == 'unavailable' and interface == GLOBAL:
                    return Message.new_error(message, 'org.freedesktop.DBus.Error.InvalidArgs', f'No such interface {GLOBAL}')
                version = Variant('u', 2 if interface == GLOBAL else 1)
                if message.member == 'Get':
                    return Message.new_method_return(message, 'v', [version])
                if message.member == 'GetAll':
                    return Message.new_method_return(message, 'a{sv}', [{'version': version}])
            if message.interface == REGISTRY and message.member == 'Register':
                assert message.signature == 'sa{sv}'
                assert message.body[0] == 'jp.kuro0315.pupa', 'wrong portal app identity'
                assert message.sender not in self.registrations, 'Register called twice on one connection'
                self.registrations[message.sender] = message.body[0]
                return Message.new_method_return(message)
            if message.interface == SESSION and message.member == 'Close':
                self.closed.append(message.path)
                self.sessions.pop(message.path, None)
                self.log('session-close', path=message.path)
                return Message.new_method_return(message)
            if message.interface == REQUEST and message.member == 'Close':
                self.requests.pop(message.path, None)
                return Message.new_method_return(message)
            if message.interface == GLOBAL:
                if self.mode == 'unavailable':
                    return Message.new_error(message, 'org.freedesktop.DBus.Error.UnknownMethod', 'GlobalShortcuts deliberately unavailable in mock')
                assert message.sender in self.registrations, 'Registry.Register must precede portal methods'
                if message.member == 'CreateSession':
                    assert message.signature == 'a{sv}'
                    options = message.body[0]
                    sender = message.sender[1:].replace('.', '_')
                    session = f"{PATH}/session/{sender}/{options['session_handle_token'].value}"
                    self.sessions[session] = {'owner': message.sender, 'bindings': [], 'bound': False}
                    return self.request(message, options, 0, {'session_handle': Variant('s', session)}, delayed=False)
                if message.member == 'BindShortcuts':
                    assert message.signature == 'oa(sa{sv})sa{sv}'
                    session, shortcuts, parent, options = message.body
                    assert self.sessions[session]['owner'] == message.sender
                    assert not self.sessions[session]['bound'], 'a session may be bound only once'
                    assert len(shortcuts) == 1 and shortcuts[0][0] == 'toggle-pupa'
                    assert shortcuts[0][1]['description'].signature == 's'
                    assert shortcuts[0][1]['preferred_trigger'].value == 'CTRL+SHIFT+space'
                    self.sessions[session]['bound'] = True
                    code = 1 if self.mode == 'cancelled' else 2 if self.mode == 'denied' else 0
                    shortcuts = self.bindings(shortcuts) if self.mode == 'accepted' else []
                    self.sessions[session]['bindings'] = shortcuts
                    if shortcuts:
                        self.saved = shortcuts
                    return self.request(message, options, code, {'shortcuts': Variant('a(sa{sv})', shortcuts)} if code == 0 else {})
                if message.member == 'ListShortcuts':
                    assert message.signature == 'oa{sv}'
                    session, options = message.body
                    current = self.sessions[session]
                    bindings = current['bindings'] if current['bound'] else self.saved
                    return self.request(message, options, 0, {'shortcuts': Variant('a(sa{sv})', bindings)}, delayed=False)
                if message.member == 'ConfigureShortcuts':
                    assert message.signature == 'osa{sv}'
                    if self.hold_configure:
                        self.configuring.append(message)
                        return True
                    return Message.new_method_return(message)
            return Message.new_error(message, 'org.freedesktop.DBus.Error.UnknownMethod', f'Unexpected fixture call: {message.interface}.{message.member}')
        except Exception as error:
            self.log('protocol-error', message=str(error))
            return Message.new_error(message, 'org.freedesktop.DBus.Error.InvalidArgs', str(error))

    async def command(self, command):
        operation = command['op']
        if operation == 'mode':
            assert command['value'] in ['accepted', 'cancelled', 'denied', 'empty', 'unavailable']
            self.mode = command['value']
            self.delay = command.get('delayMs', 80) / 1000
            self.hold = command.get('hold', False)
            self.hold_configure = command.get('holdConfigure', False)
            if command.get('clearSaved', False):
                self.saved = []
        elif operation == 'signal':
            session = command['session']
            member = command['member']
            if member in ['Activated', 'Deactivated']:
                self.bus.send(Message.new_signal(PATH, GLOBAL, member, 'osta{sv}', [session, command.get('action', 'toggle-pupa'), command.get('timestamp', 1), {}]))
            elif member == 'Closed':
                self.sessions.pop(session, None)
                self.bus.send(Message.new_signal(session, SESSION, 'Closed', 'a{sv}', [{}]))
            elif member == 'ShortcutsChanged':
                bindings = [] if command.get('empty') else self.saved
                if command.get('omitTrigger'):
                    bindings = [[item[0], {'description': item[1]['description']}] for item in bindings]
                self.bus.send(Message.new_signal(PATH, GLOBAL, member, 'oa(sa{sv})', [session, bindings]))
            else:
                raise ValueError('Unexpected signal')
            self.log('signal', **{key: value for key, value in command.items() if key not in ['id', 'op']})
        elif operation == 'respond':
            self.hold = False
            self.hold_configure = False
            for message in self.configuring:
                self.bus.send(Message.new_method_return(message))
            self.configuring.clear()
            for request, (code, results) in list(self.held.items()):
                self.response(request, code, results)
        elif operation == 'burst':
            count = command.get('count', 12)
            assert 1 <= count <= 30
            for index in range(count):
                for offset, member in enumerate(['Activated', 'Deactivated']):
                    self.bus.send(Message.new_signal(PATH, GLOBAL, member, 'osta{sv}', [command['session'], 'toggle-pupa', 100 + index * 2 + offset, {}]))
            self.log('burst', count=count, session=command['session'])
        elif operation == 'release':
            await self.bus.release_name(NAME)
            self.bus.disconnect()
            self.sessions.clear()
            self.registrations.clear()
            self.requests.clear()
            self.held.clear()
            self.configuring.clear()
        elif operation == 'acquire':
            self.bus = await MessageBus(bus_address=os.environ['DBUS_SESSION_BUS_ADDRESS']).connect()
            self.bus.add_message_handler(self.handle)
            reply = await self.bus.request_name(NAME, NameFlag.DO_NOT_QUEUE)
            assert reply == RequestNameReply.PRIMARY_OWNER
        elif operation != 'inspect':
            raise ValueError('Unexpected control operation')
        return {'mode': self.mode, 'uniqueName': getattr(self.bus, 'unique_name', None), 'sessions': plain(self.sessions), 'calls': self.calls,
                'closed': self.closed, 'pendingRequests': list(self.requests), 'heldRequests': list(self.held), 'heldConfigure': len(self.configuring)}


async def main():
    assert os.environ.get('CI') == 'true' and os.environ.get('PUPA_ISOLATED_DESKTOP') == '1'
    assert os.environ.get('PUPA_MOCK_PORTAL_TEST') == '1'
    address = os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')
    assert address.startswith('unix:path=/tmp/'), 'Only a private temporary test bus is permitted'
    bus = await MessageBus(bus_address=address).connect()
    portal = Portal(bus)
    bus.add_message_handler(portal.handle)
    assert await bus.request_name(NAME, NameFlag.DO_NOT_QUEUE) == RequestNameReply.PRIMARY_OWNER, 'Never replace a real portal'
    output({'event': 'ready', 'uniqueName': bus.unique_name})
    while line := await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline):
        command = json.loads(line)
        try:
            output({'id': command['id'], 'result': await portal.command(command)})
        except Exception as error:
            output({'id': command['id'], 'error': str(error)})
    portal.bus.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
