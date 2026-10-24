#!/usr/bin/env python3
"""No sockets or GUI: validate fixture messages with dbus-next's real marshaller."""
import sys
sys.dont_write_bytecode = True
import asyncio
import importlib.util
from pathlib import Path
import unittest
from dbus_next import Message, MessageType, Variant

spec = importlib.util.spec_from_file_location('mock_portal', Path(__file__).with_name('mock-shortcut-portal.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeBus:
    def __init__(self):
        self.sent = []

    def send(self, message):
        message.serial = len(self.sent) + 1
        message._marshall()  # Reject incorrect signatures/variant body shapes.
        self.sent.append(message)


class ProtocolFixtureTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bus = FakeBus()
        self.log = []
        self.portal = module.Portal(self.bus, self.log.append)
        self.portal.delay = 0
        self.serial = 0

    def call(self, member, signature='', body=None, interface=module.GLOBAL, path=module.PATH):
        self.serial += 1
        message = Message(destination=module.NAME, path=path, interface=interface, member=member,
                          signature=signature, body=body or [], sender=':1.42', serial=self.serial)
        message._marshall()
        result = self.portal.handle(message)
        if isinstance(result, Message):
            result._marshall()
        return result

    async def create(self):
        self.call('Register', 'sa{sv}', ['jp.kuro0315.pupa', {}], module.REGISTRY)
        result = self.call('CreateSession', 'a{sv}', [{'handle_token': Variant('s', 'request1'), 'session_handle_token': Variant('s', 'session1')}])
        await asyncio.sleep(0.02)
        self.assertEqual(result.body, [f'{module.PATH}/request/1_42/request1'])
        signal = self.bus.sent[-1]
        self.assertEqual(signal.signature, 'ua{sv}')
        self.assertEqual(signal.body[1]['session_handle'].signature, 's')
        return signal.body[1]['session_handle'].value

    def bind(self, session):
        return self.call('BindShortcuts', 'oa(sa{sv})sa{sv}', [session, [['toggle-pupa', {
            'description': Variant('s', 'Pupa を開く / 閉じる'),
            'preferred_trigger': Variant('s', 'CTRL+SHIFT+space')}]], '', {'handle_token': Variant('s', 'bind1')}])

    async def test_accepted_shapes_and_cleanup(self):
        session = await self.create()
        self.bind(session)
        await asyncio.sleep(0.02)
        signal = self.bus.sent[-1]
        self.assertEqual(signal.body[0], 0)
        self.assertEqual(signal.body[1]['shortcuts'].signature, 'a(sa{sv})')
        self.assertEqual(signal.body[1]['shortcuts'].value[0][1]['trigger_description'].value, module.TRIGGER)
        self.call('Close', interface=module.SESSION, path=session)
        self.assertNotIn(session, self.portal.sessions)
        self.assertIn(session, self.portal.closed)

    async def test_cancel_other_failure_and_empty_response_shapes(self):
        for mode, code in [('cancelled', 1), ('denied', 2), ('empty', 0)]:
            self.setUp()
            session = await self.create()
            self.portal.mode = mode
            self.bind(session)
            await asyncio.sleep(0.02)
            signal = self.bus.sent[-1]
            self.assertEqual(signal.body[0], code)
            if code == 0:
                self.assertEqual(signal.body[1]['shortcuts'].value, [])

    async def test_signal_wire_types(self):
        session = await self.create()
        for member in ['Activated', 'Deactivated', 'Closed', 'ShortcutsChanged']:
            await self.portal.command({'op': 'signal', 'member': member, 'session': session})
            expected = 'a{sv}' if member == 'Closed' else 'oa(sa{sv})' if member == 'ShortcutsChanged' else 'osta{sv}'
            self.assertEqual(self.bus.sent[-1].signature, expected)

    async def test_registry_order_and_single_bind_enforced(self):
        denied = self.call('CreateSession', 'a{sv}', [{}])
        self.assertEqual(denied.message_type, MessageType.ERROR)
        session = await self.create()
        self.bind(session)
        second = self.bind(session)
        self.assertEqual(second.message_type, MessageType.ERROR)

    async def test_held_bind_is_not_answered_until_explicit_control(self):
        session = await self.create()
        self.portal.hold = True
        before = len(self.bus.sent)
        self.bind(session)
        await asyncio.sleep(0.02)
        self.assertEqual(len(self.bus.sent), before)
        self.assertEqual(len(self.portal.held), 1)
        await self.portal.command({'op': 'respond'})
        self.assertEqual(len(self.bus.sent), before + 1)

    async def test_held_configuration_queues_ordered_real_signal_messages(self):
        session = await self.create()
        self.portal.hold_configure = True
        result = self.call('ConfigureShortcuts', 'osa{sv}', [session, '', {}])
        self.assertIs(result, True)
        await self.portal.command({'op': 'burst', 'session': session, 'count': 12})
        signals = [m.member for m in self.bus.sent if m.interface == module.GLOBAL]
        self.assertEqual(signals, ['Activated', 'Deactivated'] * 12)
        await self.portal.command({'op': 'respond'})
        self.assertEqual(self.bus.sent[-1].message_type, MessageType.METHOD_RETURN)
        self.assertEqual(len(self.portal.configuring), 0)

    async def test_changed_signal_can_omit_gnome_disabled_trigger(self):
        session = await self.create()
        self.bind(session)
        await asyncio.sleep(0.02)
        await self.portal.command({'op': 'signal', 'member': 'ShortcutsChanged', 'session': session, 'omitTrigger': True})
        message = self.bus.sent[-1]
        self.assertEqual(message.body[1][0][0], 'toggle-pupa')
        self.assertNotIn('trigger_description', message.body[1][0][1])

    async def test_unavailable_interface_has_real_dbus_error(self):
        self.portal.mode = 'unavailable'
        result = self.call('Get', 'ss', [module.GLOBAL, 'version'], 'org.freedesktop.DBus.Properties')
        self.assertEqual(result.error_name, 'org.freedesktop.DBus.Error.InvalidArgs')
        self.assertIn(module.GLOBAL, result.body[0])


if __name__ == '__main__':
    unittest.main()
