import assert from 'node:assert/strict';
import test from 'node:test';
import {
    detectConnectionSettings,
    formatAudioStatistics,
    getHostFromUrl,
    getIntercomMixinInterfaces,
    normalizeChannel,
    resolveConnectionSettings,
    splitHostPort,
    withTimeout,
} from '../src/settings-utils';
import { VigiError } from '../src/vigi-error';

test('splitHostPort handles IPv4, IPv6, URLs and host-only values', () => {
    assert.deepEqual(splitHostPort('192.168.1.50'), { host: '192.168.1.50' });
    assert.deepEqual(splitHostPort('192.168.1.50:8800'), { host: '192.168.1.50', port: 8800 });
    assert.deepEqual(splitHostPort('[fe80::1]'), { host: 'fe80::1' });
    assert.deepEqual(splitHostPort('[fe80::1]:8800'), { host: 'fe80::1', port: 8800 });
    assert.deepEqual(splitHostPort('fe80::1'), { host: 'fe80::1' });
    assert.deepEqual(splitHostPort('https://192.168.1.50:8443/path'), { host: '192.168.1.50', port: 8443 });
    assert.deepEqual(splitHostPort('rtsp://[fe80::1]:554/stream1'), { host: 'fe80::1', port: 554 });
    assert.deepEqual(splitHostPort('camera:8800.5'), { host: 'camera' });
    assert.deepEqual(splitHostPort('camera:0'), { host: 'camera' });
    assert.deepEqual(splitHostPort('camera:65536'), { host: 'camera' });
    assert.deepEqual(splitHostPort(''), { host: '' });
    assert.deepEqual(splitHostPort('   '), { host: '' });
    assert.deepEqual(splitHostPort(':8800'), { host: ':8800' });
    assert.deepEqual(splitHostPort('https://[fe80::1'), { host: 'https://[fe80::1' });
    assert.deepEqual(splitHostPort('[fe80::1]:bad'), { host: 'fe80::1' });
    assert.deepEqual(splitHostPort('[fe80::1]extra'), { host: 'fe80::1' });
    assert.deepEqual(splitHostPort('camera.local:8800'), { host: 'camera.local', port: 8800 });
    assert.deepEqual(splitHostPort('2001:db8::1'), { host: '2001:db8::1' });
});

test('masked passwords and host ports are handled like the PTZ connection code', () => {
    for (const masked of ['********', ' ******** ', '\t********\n'])
        assert.equal(detectConnectionSettings([
            { key: 'password', value: masked },
            { key: 'username', value: 'admin' },
        ]).password, undefined);

    assert.deepEqual(detectConnectionSettings([
        { key: 'ip', value: '192.168.1.50:8443' },
        { key: 'password', value: 'secret' },
    ]), {
        host: '192.168.1.50',
        username: undefined,
        password: 'secret',
    });

    assert.deepEqual(resolveConnectionSettings({
        host: '192.168.1.50:8800',
        password: 'secret',
    }, {}), {
        host: '192.168.1.50',
        username: 'admin',
        password: 'secret',
        port: 8800,
    });

    // An explicit host override port wins over the configured/default port.
    assert.equal(resolveConnectionSettings({
        host: '192.168.1.50:9000',
        password: 'secret',
    }, {}).port, 9000);

    // A masked override must fall back to the detected password.
    assert.equal(resolveConnectionSettings({
        host: 'camera',
        password: '********',
    }, { password: 'detected' }).password, 'detected');
});

test('withTimeout resolves, rejects and times out', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 1000), 42);
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000), /boom/);
    await assert.rejects(withTimeout(new Promise(() => undefined), 10), error =>
        error instanceof VigiError && error.kind === 'config' && /Timed out/.test(error.message));
    await assert.rejects(withTimeout(new Promise(() => undefined), 10, 'custom timeout'), error =>
        error instanceof VigiError && error.kind === 'config' && /custom timeout/.test(error.message));
});

test('withTimeout handles abort, already-aborted signals and late rejection', async () => {
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void;
    const pending = withTimeout(new Promise((_resolve, reject) => rejectLate = reject), 10000, undefined, controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted/);
    rejectLate(new Error('late rejection'));
    await assert.rejects(withTimeout(Promise.resolve(42), 10000, undefined, controller.signal), /aborted/);

    const second = new AbortController();
    assert.equal(await withTimeout(Promise.resolve(42), 10000, undefined, second.signal), 42);
    second.abort(); // must not change an already-settled result
});

test('getHostFromUrl extracts IPv4, host names and unbracketed IPv6', () => {
    assert.equal(getHostFromUrl('rtsp://192.168.1.50:554/stream1'), '192.168.1.50');
    assert.equal(getHostFromUrl('rtsp://admin:password@camera.local/stream1'), 'camera.local');
    assert.equal(getHostFromUrl('rtsp://[fe80::1]:554/stream1'), 'fe80::1');
    assert.equal(getHostFromUrl('rtsp://[::1]/stream1'), '::1');
    assert.equal(getHostFromUrl('not a url'), undefined);
    assert.equal(getHostFromUrl(undefined), undefined);
});

test('a single urls string and array entries are both considered', () => {
    assert.equal(detectConnectionSettings([
        { key: 'urls', value: 'rtsp://192.168.1.52/stream2' },
        { key: 'password', value: 'secret' },
    ]).host, '192.168.1.52');

    assert.equal(detectConnectionSettings([
        { key: 'urls', value: ['', 'rtsp://192.168.1.53/stream2'] },
        { key: 'password', value: 'secret' },
    ]).host, '192.168.1.53');
});

test('detectConnectionSettings finds common Scrypted camera setting names', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'ip', value: '192.168.1.50' },
        { key: 'username', value: 'admin' },
        { key: 'password', value: 'secret' },
    ]), {
        host: '192.168.1.50',
        username: 'admin',
        password: 'secret',
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'hostname', value: 'camera.local' },
        { key: 'userName', value: 'admin' },
        { key: 'adminPassword', value: 'secret' },
    ]), {
        host: 'camera.local',
        username: 'admin',
        password: 'secret',
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'rtspUrl', value: 'rtsp://admin:secret@192.168.1.51/stream1' },
    ]), {
        host: '192.168.1.51',
        username: 'admin',
        password: 'secret',
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'urls', value: ['', 'rtsp://192.168.1.52/stream2'] },
    ]), {
        host: '192.168.1.52',
        username: undefined,
        password: undefined,
    });
});

test('detectConnectionSettings skips a malformed URL and extracts URL credentials', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'not a url' },
        { key: 'rtspUrl', value: 'rtsp://admin:secret@192.168.1.53/stream1' },
    ]), {
        host: '192.168.1.53',
        username: 'admin',
        password: 'secret',
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://user:p%40ss@camera.local/stream1' },
    ]), {
        host: 'camera.local',
        username: 'user',
        password: 'p@ss',
    });
});

test('connection detection handles URL-valued host fields, urls credentials and masks', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'address', value: 'https://192.168.1.54:9443/path' },
        { key: 'username', value: 'admin' },
        { key: 'password', value: '********' },
    ]), {
        host: '192.168.1.54',
        username: 'admin',
        password: undefined,
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'urls', value: ['', 'rtsp://operator:sec%2Bret@192.168.1.53:554/stream1'] },
    ]), {
        host: '192.168.1.53',
        username: 'operator',
        password: 'sec+ret',
    });
});

test('URL credentials are independent of the first parseable URL host', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'http://192.168.1.5' },
        { key: 'rtspUrl', value: 'rtsp://admin:secret@192.168.1.5/stream1' },
    ]), {
        host: '192.168.1.5',
        username: 'admin',
        password: 'secret',
    });
});

test('URL credentials never cross hosts, including when an explicit host is selected', () => {
    const settings = [
        { key: 'url', value: 'http://proxy.example/snapshot' },
        { key: 'rtspUrl', value: 'rtsp://admin:camera-secret@camera.example/stream1' },
    ];
    assert.deepEqual(detectConnectionSettings(settings), {
        host: 'camera.example', username: 'admin', password: 'camera-secret',
    });
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'http://proxy.example/snapshot' },
    ]), {
        host: 'proxy.example', username: undefined, password: undefined,
    });
    assert.deepEqual(detectConnectionSettings([{ key: 'host', value: 'CAMERA.example.:8443' }, ...settings]), {
        host: 'CAMERA.example.', username: 'admin', password: 'camera-secret',
    });
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://admin@camera-a/stream1' },
        { key: 'rtspUrl', value: 'rtsp://admin:wrong-secret@camera-b/stream1' },
    ]), {
        host: 'camera-a', username: 'admin', password: undefined,
    });
});

test('a complete URL credential pair wins over a partial candidate', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://user@camera/stream1' },
        { key: 'rtspUrl', value: 'rtsp://other:pass@camera/stream1' },
    ]), {
        host: 'camera',
        username: 'other',
        password: 'pass',
    });
});

test('partial credentials from different URLs are not mixed', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://user@camera/stream1' },
        { key: 'rtspUrl', value: 'rtsp://:pass@camera/stream1' },
    ]), {
        host: 'camera',
        username: 'user',
        password: undefined,
    });
});

test('an explicit username completes the primary URL before another account is considered', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'username', value: 'admin' },
        { key: 'url', value: 'rtsp://:admin-secret@camera.example/stream1' },
        { key: 'rtspUrl', value: 'rtsp://viewer:viewer-secret@camera.example/stream2' },
    ]), {
        host: 'camera.example', username: 'admin', password: 'admin-secret',
    });
});

test('an explicit username never borrows a password from a different URL account', () => {
    const settings = [
        { key: 'username', value: 'admin' },
        { key: 'password', value: '********' },
        { key: 'url', value: 'rtsp://viewer:viewer-secret@camera.example/stream1' },
    ];
    assert.deepEqual(detectConnectionSettings([
        ...settings,
        { key: 'rtspUrl', value: 'rtsp://admin:admin-secret@camera.example/stream2' },
    ]), {
        host: 'camera.example', username: 'admin', password: 'admin-secret',
    });
    assert.deepEqual(detectConnectionSettings(settings), {
        host: 'camera.example', username: 'admin', password: undefined,
    });
});

test('a complete explicit credential pair takes precedence over URL accounts', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'username', value: 'admin' },
        { key: 'password', value: 'admin-secret' },
        { key: 'url', value: 'rtsp://viewer:viewer-secret@camera.example/stream1' },
    ]), {
        host: 'camera.example', username: 'admin', password: 'admin-secret',
    });
});

test('equivalent IPv6 literals share URL credentials without changing the selected host', () => {
    for (const [explicit, urlHost, expectedHost] of [
        ['2001:db8:0:0:0:0:0:1', '2001:db8::1', '2001:db8:0:0:0:0:0:1'],
        ['2001:db8::1', '2001:db8:0:0:0:0:0:1', '2001:db8::1'],
        ['[2001:0DB8:0000:0000:0000:0000:0000:0001]:8443', '2001:db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0001'],
        ['::ffff:192.0.2.1', '::ffff:c000:201', '::ffff:192.0.2.1'],
    ] as const) {
        const detected = detectConnectionSettings([
            { key: 'host', value: explicit },
            { key: 'rtspUrl', value: `rtsp://admin:admin-secret@[${urlHost}]:554/stream1` },
        ]);
        assert.equal(detected.host, expectedHost, explicit);
        assert.equal(detected.username, 'admin', explicit);
        assert.equal(detected.password, 'admin-secret', explicit);
    }
    assert.deepEqual(detectConnectionSettings([
        { key: 'host', value: '2001:db8:0:0:0:0:0:2' },
        { key: 'rtspUrl', value: 'rtsp://admin:other-secret@[2001:db8::1]/stream1' },
    ]), {
        host: '2001:db8:0:0:0:0:0:2', username: undefined, password: undefined,
    });
});

test('parent credentials follow the RTSP camera endpoint, not a snapshot/proxy URL', () => {
    for (const stream of [
        'rtsp://admin:camera-secret@camera.example/stream1',
        'rtsp://camera.example/stream1',
        'rtsps://camera.example/stream1',
    ]) {
        const settings = [
            { key: 'url', value: 'https://proxy.example/snapshot' },
            { key: 'rtspUrl', value: stream },
            { key: 'username', value: 'admin' },
            { key: 'password', value: 'camera-secret' },
        ];
        const detected = detectConnectionSettings(settings);
        assert.deepEqual(detected, { host: 'camera.example', username: 'admin', password: 'camera-secret' });
        assert.equal(resolveConnectionSettings({}, detected).host, 'camera.example');
        assert.deepEqual(detectConnectionSettings([
            { key: 'ip', value: 'camera.example' }, ...settings,
        ]), detected, 'an explicit parent camera address is authoritative too');
    }
});

test('ambiguous URL endpoints cannot inherit unscoped parent credentials', () => {
    for (const urls of [
        ['rtsp://camera-a/stream1', 'rtsp://camera-b/stream2'],
        ['https://proxy-a/snapshot', 'https://proxy-b/snapshot'],
    ]) {
        const detected = detectConnectionSettings([
            { key: 'urls', value: urls },
            { key: 'username', value: 'admin' },
            { key: 'password', value: 'camera-secret' },
        ]);
        assert.equal(detected.username, undefined);
        assert.equal(detected.password, undefined);
        assert.throws(() => resolveConnectionSettings({}, detected), /password/);
    }
});

test('an explicit password completes the primary URL username', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'rtspUrl', value: 'rtsp://urluser:urlpass@camera/stream1' },
        { key: 'password', value: 'explicit' },
    ]), {
        host: 'camera',
        username: 'urluser',
        password: 'explicit',
    });
});

test('passwords preserve intentional leading and trailing spaces', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'host', value: 'camera' },
        { key: 'password', value: '  secret  ' },
    ]).password, '  secret  ');
    assert.equal(detectConnectionSettings([
        { key: 'password', value: '   ' },
    ]).password, undefined);
    assert.equal(resolveConnectionSettings({
        host: 'camera',
        password: ' a b ',
    }, {}).password, ' a b ');
});

test('detectConnectionSettings ignores blank and malformed values', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'ip', value: '   ' },
        { key: 'host', value: '' },
        { key: 'url', value: 'not a url' },
        { key: 'username', value: null },
    ]), {
        host: undefined,
        username: undefined,
        password: undefined,
    });
});

test('resolveConnectionSettings prefers overrides and applies defaults', () => {
    assert.deepEqual(resolveConnectionSettings({
        host: ' 10.0.0.2 ',
        username: 'admin',
        password: '  override  ',
        port: '9000',
    }, {
        host: '192.168.1.50',
        username: 'detected',
        password: 'detected',
    }), {
        host: '10.0.0.2',
        username: 'admin',
        password: '  override  ',
        port: 9000,
    });

    assert.deepEqual(resolveConnectionSettings({}, {
        host: '192.168.1.50',
        password: 'secret',
    }), {
        host: '192.168.1.50',
        username: 'admin',
        password: 'secret',
        port: 8800,
    });
});

test('RTSP userinfo decoding failures do not discard the host or the other field', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://ad%zzmin:p%2Bass@192.168.1.50:554/stream1' },
    ]), {
        host: '192.168.1.50',
        username: 'ad%zzmin',
        password: 'p+ass',
    });

    assert.deepEqual(detectConnectionSettings([
        { key: 'url', value: 'rtsp://admin:bad%zz@192.168.1.50/stream1' },
    ]), {
        host: '192.168.1.50',
        username: 'admin',
        password: 'bad%zz',
    });
});

test('a malformed urls value does not discard a valid host field', () => {
    assert.deepEqual(detectConnectionSettings([
        { key: 'ip', value: '192.168.1.51' },
        { key: 'urls', value: { not: 'an array' } },
        { key: 'password', value: 'secret' },
    ]), {
        host: '192.168.1.51',
        username: undefined,
        password: 'secret',
    });
});

test('resolveConnectionSettings defaults blank ports and rejects invalid ones', () => {
    for (const port of [undefined, '', null]) {
        assert.equal(resolveConnectionSettings({ host: 'camera', password: 'secret', port }, {}).port, 8800);
    }
    for (const port of ['abc', 0, -1, 65536, 1.5]) {
        assert.throws(() => resolveConnectionSettings({ host: 'camera', password: 'secret', port }, {}), error =>
            error instanceof VigiError && error.kind === 'config' && /port must be an integer/.test(error.message));
    }
    assert.equal(resolveConnectionSettings({ host: 'camera', password: 'secret', port: 1 }, {}).port, 1);
    assert.equal(resolveConnectionSettings({ host: 'camera', password: 'secret', port: 65535 }, {}).port, 65535);
});

test('resolveConnectionSettings requires a host and password', () => {
    assert.throws(() => resolveConnectionSettings({}, {}), error =>
        error instanceof VigiError && error.kind === 'config' && /host is not configured/.test(error.message));
    assert.throws(() => resolveConnectionSettings({ host: 'camera' }, {}), error =>
        error instanceof VigiError && error.kind === 'config' && /password is not configured/.test(error.message));
});

test('normalizeChannel defaults unset values and rejects invalid ones', () => {
    assert.equal(normalizeChannel(undefined), 0);
    assert.equal(normalizeChannel(null), 0);
    assert.equal(normalizeChannel(''), 0);
    assert.equal(normalizeChannel(0), 0);
    assert.equal(normalizeChannel('3'), 3);
    assert.equal(normalizeChannel(256), 256);
    for (const value of [-1, 257, 1.5, 'nope', NaN, Infinity])
        assert.throws(() => normalizeChannel(value), error =>
            error instanceof VigiError && error.kind === 'config' && /channel must be an integer from 0 to 256/.test(error.message));
});

test('getIntercomMixinInterfaces targets cameras and doorbells only', () => {
    assert.deepEqual(getIntercomMixinInterfaces('Camera', ['VideoCamera', 'Settings']), ['Intercom', 'Settings']);
    assert.deepEqual(getIntercomMixinInterfaces('Doorbell', ['VideoCamera', 'Settings']), ['Intercom', 'Settings']);
    assert.equal(getIntercomMixinInterfaces('Camera', ['VideoCamera']), undefined);
    assert.equal(getIntercomMixinInterfaces('Camera', ['Settings']), undefined);
    assert.equal(getIntercomMixinInterfaces('Light', ['VideoCamera', 'Settings']), undefined);
    assert.deepEqual(getIntercomMixinInterfaces('Camera', ['VideoCamera', 'Settings', 'Intercom']), ['Intercom', 'Settings']);
});

test('formatAudioStatistics reports sizes, intervals and drops without audio data', () => {
    assert.equal(formatAudioStatistics({
        mode: '512 samples / 64 ms',
        reason: 'stop',
        windowMilliseconds: 5000,
        rtpReceived: {
            packets: 250,
            audioMilliseconds: 5000,
            payloadSizes: [{ bytes: 160, audioMilliseconds: 20, count: 250 }],
            intervalMilliseconds: { minimum: 19.5, mean: 20, maximum: 20.5 },
        },
        pesWritten: {
            packets: 78,
            audioMilliseconds: 4992,
            payloadSizes: [{ bytes: 512, audioMilliseconds: 64, count: 78 }],
            intervalMilliseconds: { minimum: 63, mean: 64, maximum: 65 },
        },
        overloadDroppedSamples: 0,
    }), 'TP-Link Talk ended: RTP [160B/20ms x250]; sent [512B/64ms x78]; mean write interval 64ms; overload drops 0 samples.');

    assert.match(formatAudioStatistics({
        mode: '512 samples / 64 ms',
        reason: 'stop',
        windowMilliseconds: 1,
        rtpReceived: { packets: 0, audioMilliseconds: 0, payloadSizes: [] },
        pesWritten: { packets: 0, audioMilliseconds: 0, payloadSizes: [] },
        overloadDroppedSamples: 1024,
    }), /RTP \[none\]; sent \[none\]; overload drops 1024 samples\./);
});
