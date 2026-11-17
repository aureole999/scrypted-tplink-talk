import assert from 'node:assert/strict';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import path from 'path';
import test from 'node:test';
import { buildPcmaRtpArguments, maxForwarderLogLineBytes, startPcmaRtpForwarder } from '../src/audio-forwarder';

class FakeChild extends EventEmitter {
    stderr = new EventEmitter();
    killed = false;
    killCount = 0;
    lastSignal?: string;
    signals: string[] = [];

    spawn() {
        queueMicrotask(() => this.emit('spawn'));
        return this;
    }

    kill(signal?: string) {
        this.killCount++;
        this.killed = true;
        this.lastSignal = signal;
        if (signal)
            this.signals.push(signal);
        return true;
    }

    exit(code = 0) {
        this.emit('exit', code, null);
    }
}

function fakeConsole() {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
        logs,
        errors,
        console: {
            log: (...args: any[]) => logs.push(args.join(' ')),
            error: (...args: any[]) => errors.push(args.join(' ')),
        } as unknown as Console,
    };
}

function trackedSocketFactory() {
    const sockets: any[] = [];
    const factory = () => {
        const socket = dgram.createSocket('udp4') as any;
        socket.closedByForwarder = false;
        const close = socket.close.bind(socket);
        socket.close = (callback?: () => void) => {
            socket.closedByForwarder = true;
            return close(callback);
        };
        sockets.push(socket);
        return socket as dgram.Socket;
    };
    return { sockets, factory };
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            throw new Error('timed out waiting for condition');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

function sendUdp(port: number, payload: Buffer) {
    return new Promise<void>((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.send(payload, port, '127.0.0.1', error => {
            socket.close();
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}

test('buildPcmaRtpArguments forces 8 kHz mono A-law RTP without video', () => {
    const args = buildPcmaRtpArguments({ inputArguments: ['-i', 'input.mp4'] }, 12345);
    assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-loglevel', 'warning', '-nostats', '-i']);
    assert.ok(args.includes('input.mp4'));
    assert.ok(args.includes('-vn'));
    assert.ok(args.includes('-sn'));
    assert.ok(args.includes('-dn'));
    assert.equal(args[args.indexOf('-acodec') + 1], 'pcm_alaw');
    assert.equal(args[args.indexOf('-ar') + 1], '8000');
    assert.equal(args[args.indexOf('-ac') + 1], '1');
    assert.equal(args[args.indexOf('-f') + 1], 'rtp');
    assert.equal(args[args.indexOf('-payload_type') + 1], '8');
    assert.equal(args[args.length - 1], 'udp://127.0.0.1:12345?pkt_size=1200');
    assert.equal(args.filter(arg => arg === '-ar').length, 1);
});

test('buildPcmaRtpArguments falls back to a URL and rejects empty inputs or bad ports', () => {
    const fromUrl = buildPcmaRtpArguments({ url: 'rtsp://camera/stream1' }, 1);
    assert.deepEqual(fromUrl.slice(4, 6), ['-i', 'rtsp://camera/stream1']);
    const fromUrls = buildPcmaRtpArguments({ urls: ['', 'rtsp://camera/stream2'] }, 1);
    assert.deepEqual(fromUrls.slice(4, 6), ['-i', 'rtsp://camera/stream2']);
    assert.throws(() => buildPcmaRtpArguments({}, 1), /does not include inputArguments or a URL/);
    assert.throws(() => buildPcmaRtpArguments({ inputArguments: ['-i', 'pipe:0'] }, 1), /pipe inputs are not supported/);
    for (const port of [0, -1, 65536, 1.5, NaN])
        assert.throws(() => buildPcmaRtpArguments({ url: 'rtsp://camera' }, port), /Invalid RTP port/);
});

test('startPcmaRtpForwarder forwards UDP RTP and kills ffmpeg', async () => {
    const child = new FakeChild();
    const { sockets, factory } = trackedSocketFactory();
    const { console, logs } = fakeConsole();
    const received: Buffer[] = [];
    const spawnCalls: any[][] = [];

    const forwarder = await startPcmaRtpForwarder(console, {
        inputArguments: ['-i', 'input'],
        env: { TP_TEST: '1' },
    } as any, rtp => received.push(Buffer.from(rtp)), {
        getFFmpegPath: async () => '/fake/ffmpeg',
        createSocket: factory,
        spawn: ((...args: any[]) => {
            spawnCalls.push(args);
            return child.spawn();
        }) as any,
    });

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0][0], '/fake/ffmpeg');
    assert.deepEqual(spawnCalls[0][2].stdio, ['ignore', 'ignore', 'pipe']);
    assert.equal(spawnCalls[0][2].env.TP_TEST, '1');

    const address = sockets[0].address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    await sendUdp(address.port, Buffer.from('rtp-payload'));
    await waitFor(() => received.length === 1);
    assert.deepEqual(received[0], Buffer.from('rtp-payload'));

    child.stderr.emit('data', Buffer.from('rtsp://admin:secret@camera/stream password=hunter2\n'));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /rtsp:\/\/\*\*\*@camera\/stream/);
    assert.match(logs[0], /password=\*\*\*/);
    assert.doesNotMatch(logs[0], /secret|hunter2/);

    forwarder.kill();
    forwarder.kill();
    assert.equal(child.killCount, 1);
    assert.equal(child.lastSignal, 'SIGTERM');
    assert.equal(sockets[0].closedByForwarder, true);

    child.exit(0);
    await forwarder.killPromise;
});

test('uses FFmpegInput.ffmpegPath without asking the SDK', async () => {
    const child = new FakeChild();
    const { factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    let asked = false;
    const spawnCalls: any[][] = [];

    const forwarder = await startPcmaRtpForwarder(console, {
        inputArguments: ['-i', 'input'],
        ffmpegPath: '/custom/ffmpeg',
    } as any, () => undefined, {
        getFFmpegPath: async () => {
            asked = true;
            return '/sdk/ffmpeg';
        },
        createSocket: factory,
        spawn: ((...args: any[]) => {
            spawnCalls.push(args);
            return child.spawn();
        }) as any,
    });

    assert.equal(asked, false);
    assert.equal(spawnCalls[0][0], '/custom/ffmpeg');
    forwarder.kill();
    child.exit(0);
    await forwarder.killPromise;
});

test('a UDP error during ffmpeg lookup prevents spawning ffmpeg', async () => {
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    const spawnCalls: any[][] = [];
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => lookupStarted = resolve);
    let resolvePath!: (path: string) => void;
    const path = new Promise<string>(resolve => resolvePath = resolve);

    const promise = startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: () => {
            lookupStarted();
            return path;
        },
        createSocket: factory,
        spawn: ((...args: any[]) => {
            spawnCalls.push(args);
            return new FakeChild();
        }) as any,
    });

    await started;
    sockets[0].emit('error', new Error('udp failed'));
    resolvePath('ffmpeg');
    await assert.rejects(promise, /udp failed/);
    assert.equal(spawnCalls.length, 0);
    assert.equal(sockets[0].closedByForwarder, true);
});

test('kill escalates to SIGKILL when ffmpeg does not exit', async () => {
    const child = new FakeChild();
    const { factory } = trackedSocketFactory();
    const { console } = fakeConsole();

    const forwarder = await startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        createSocket: factory,
        spawn: (() => child.spawn()) as any,
        killTimeoutMilliseconds: 10,
    });

    forwarder.kill();
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    child.exit(0);
    await forwarder.killPromise;
});

test('startPcmaRtpForwarder rejects an input without arguments or a URL', async () => {
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    let spawned = false;

    await assert.rejects(startPcmaRtpForwarder(console, {} as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        createSocket: factory,
        spawn: (() => {
            spawned = true;
            return new FakeChild();
        }) as any,
    }), /does not include inputArguments or a URL/);

    assert.equal(spawned, false);
    assert.equal(sockets[0].closedByForwarder, true);
});

test('AbortSignal cancels an in-flight ffmpeg lookup', async () => {
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    const controller = new AbortController();
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => lookupStarted = resolve);
    let resolvePath!: (path: string) => void;
    const path = new Promise<string>(resolve => resolvePath = resolve);
    let spawned = false;

    const promise = startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: () => {
            lookupStarted();
            return path;
        },
        createSocket: factory,
        spawn: (() => {
            spawned = true;
            return new FakeChild();
        }) as any,
        signal: controller.signal,
    });

    await started;
    controller.abort();
    await assert.rejects(promise, /aborted/);
    assert.equal(spawned, false);
    assert.equal(sockets[0].closedByForwarder, true);
    resolvePath('ffmpeg'); // late resolution must be ignored
});

test('startPcmaRtpForwarder closes the UDP socket when ffmpeg lookup fails', async () => {
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();

    await assert.rejects(startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: async () => {
            throw new Error('no ffmpeg');
        },
        createSocket: factory,
        spawn: (() => new FakeChild()) as any,
    }), /no ffmpeg/);

    assert.equal(sockets[0].closedByForwarder, true);
});

test('a UDP socket error after bind stops ffmpeg and closes the socket', async () => {
    const child = new FakeChild();
    const { sockets, factory } = trackedSocketFactory();
    const { console, errors } = fakeConsole();

    const forwarder = await startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        createSocket: factory,
        spawn: (() => child.spawn()) as any,
        killTimeoutMilliseconds: 10,
    });

    sockets[0].emit('error', new Error('udp failed'));
    assert.equal(sockets[0].closedByForwarder, true);
    assert.match(errors[0], /udp failed/);
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);

    child.exit(0);
    await forwarder.killPromise;
});

test('startPcmaRtpForwarder rejects startup and closes the socket on spawn error', async () => {
    const child = new FakeChild();
    const { sockets, factory } = trackedSocketFactory();
    const { console, errors } = fakeConsole();

    const starting = startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        createSocket: factory,
        spawn: (() => {
            queueMicrotask(() => child.emit('error', new Error('spawn failed')));
            return child;
        }) as any,
    });

    await assert.rejects(starting, /spawn failed/);

    assert.equal(sockets[0].closedByForwarder, true);
    assert.match(errors[0], /spawn failed/);
});

test('a real missing ffmpeg executable rejects startup', async () => {
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    await assert.rejects(startPcmaRtpForwarder(console, {
        ffmpegPath: path.join(__dirname, 'missing-ffmpeg'),
        url: 'rtsp://camera/stream1',
    } as any, () => undefined, {
        getFFmpegPath: async () => 'unused',
        createSocket: factory,
    }), /ENOENT/);
    assert.equal(sockets[0].closedByForwarder, true);
});

test('abort while awaiting spawn terminates the child and closes the socket', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const { sockets, factory } = trackedSocketFactory();
    const { console } = fakeConsole();
    let spawned!: () => void;
    const enteredSpawn = new Promise<void>(resolve => spawned = resolve);
    const starting = startPcmaRtpForwarder(console, { url: 'rtsp://camera/stream1' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        createSocket: factory,
        signal: controller.signal,
        spawn: (() => {
            spawned();
            return child;
        }) as any,
    });
    await enteredSpawn;
    controller.abort();
    await assert.rejects(starting, /aborted/);
    assert.equal(child.lastSignal, 'SIGTERM');
    assert.equal(sockets[0].closedByForwarder, true);
    child.exit();
});

test('stderr redaction survives every byte boundary and flushes a final line', async () => {
    const child = new FakeChild();
    const { console, logs } = fakeConsole();
    const forwarder = await startPcmaRtpForwarder(console, { url: 'rtsp://camera' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        spawn: (() => child.spawn()) as any,
    });
    const line = Buffer.from('café rtsp://admin:synthetic-secret@camera/stream?token=token-secret\n');
    for (let split = 1; split < line.length; split++) {
        child.stderr.emit('data', line.subarray(0, split));
        assert.equal(logs.length, split - 1, 'partial lines must not be logged');
        child.stderr.emit('data', line.subarray(split));
        assert.equal(logs.length, split);
    }
    child.stderr.emit('data', Buffer.from('rtsp://admin:synthetic-secret@camera/stream'));
    child.stderr.emit('end');
    assert.ok(logs.every(value => !/synthetic-secret|token-secret/.test(value)));
    assert.match(logs[0], /café rtsp:\/\/\*\*\*@camera\/stream\?token=\*\*\*/);
    assert.equal(logs.length, line.length);
    forwarder.kill();
    child.exit();
    await forwarder.killPromise;
});

test('overlong stderr lines are dropped in full, not logged as credential fragments', async () => {
    const child = new FakeChild();
    const { console, logs } = fakeConsole();
    const forwarder = await startPcmaRtpForwarder(console, { url: 'rtsp://camera' } as any, () => undefined, {
        getFFmpegPath: async () => 'ffmpeg',
        spawn: (() => child.spawn()) as any,
    });
    child.stderr.emit('data', Buffer.from('rtsp://admin:'));
    child.stderr.emit('data', Buffer.alloc(maxForwarderLogLineBytes, 0x61));
    child.stderr.emit('data', Buffer.from('private-suffix@camera\nsafe next line\n'));
    assert.deepEqual(logs, ['[ffmpeg log line omitted: too long]', 'safe next line']);
    forwarder.kill();
    child.exit();
    await forwarder.killPromise;
});
