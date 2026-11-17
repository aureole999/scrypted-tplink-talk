import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'stream';
import { audioSendModes, AudioSendingStatistics, normalizeAudioSendMode, PcmaBackchannel, pcmaRtpPayload, tailPlaybackGraceMilliseconds } from '../src/pcma-backchannel';

class FakeClock {
    time = 0;
    protected lag = 0;
    private tasks = new Map<object, { at: number; callback: () => void }>();
    now = () => this.time;
    schedule = (callback: () => void, milliseconds: number) => {
        const id = {};
        this.tasks.set(id, { at: this.time + milliseconds + this.lag, callback });
        return id;
    };
    cancel = (id: unknown) => { this.tasks.delete(id as object); };
    advance(milliseconds: number) {
        const end = this.time + milliseconds;
        while (true) {
            const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end)
                break;
            this.time = Math.max(this.time, next[1].at);
            this.tasks.delete(next[0]);
            next[1].callback();
        }
        this.time = end;
    }
    advanceTo(time: number) {
        while (true) {
            const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > time)
                break;
            this.time = Math.max(this.time, next[1].at);
            this.tasks.delete(next[0]);
            next[1].callback();
        }
        this.time = time;
    }
}

// A real event loop fires timers a little after their deadline. The old
// pacing reset its deadline from the actual write time, so that lateness was
// added to every frame; this clock makes that behaviour observable.
class LaggyClock extends FakeClock {
    protected lag = 0.5;
}

async function flushWithClock(sender: PcmaBackchannel, clock: FakeClock): Promise<void> {
    const stopping = Promise.resolve(sender.stop(true));
    let settled = false;
    stopping.then(() => settled = true, () => settled = true);
    for (let i = 0; i < 40 && !settled; i++) {
        clock.advance(64);
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(settled, 'tail flush must finish within its bounded fake-clock budget');
    await stopping;
}

function rtp(payload: Buffer) {
    const header = Buffer.alloc(12);
    header.set([0x80, 8]);
    return Buffer.concat([header, payload]);
}

function audio(ts: Buffer): Buffer {
    const pes: Buffer[] = [];
    for (let i = 0; i < ts.length; i += 188) {
        const packet = ts.subarray(i, i + 188);
        pes.push(packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4));
    }
    return Buffer.concat(pes).subarray(14);
}

for (const [frameSamples, frameMs, mode] of [
    [512, 64, undefined], // omitted mode must use the new 64 ms default
    [1024, 128, audioSendModes.paced],
] as const) {
    test(`reassembles arbitrary RTP sizes into ${frameSamples}-sample PES at ${frameMs} ms intervals`, () => {
        const clock = new FakeClock();
        const writes: { at: number; data: Buffer }[] = [];
        const output = new Writable({ write(data, _, callback) {
            writes.push({ at: clock.now(), data: Buffer.from(data) }); callback();
        } });
        const sender = new PcmaBackchannel(output, { clock, mode });
        const samples = Buffer.from(Array.from({ length: frameSamples * 3 }, (_, i) => i % 251));
        for (let offset = 0; offset < samples.length; offset += 160)
            sender.pushRtp(rtp(samples.subarray(offset, offset + 160)));
        assert.equal(writes.length, 2); // tables and first complete frame
        clock.advance(frameMs - 1);
        assert.equal(writes.length, 2);
        clock.advance(frameMs + 1);
        assert.deepEqual(writes.slice(1).map(w => w.at), [0, frameMs, frameMs * 2]);
        assert.deepEqual(writes.slice(1).map(w => audio(w.data).length), [frameSamples, frameSamples, frameSamples]);
        assert.deepEqual(Buffer.concat(writes.slice(1).map(w => audio(w.data))), samples);
        sender.stop();
    });

    test(`${frameMs} ms timers do not burst after a stall and stop cancels queued audio`, () => {
        const clock = new FakeClock();
        const times: number[] = [];
        const output = new Writable({ write(_data, _, callback) { times.push(clock.now()); callback(); } });
        const sender = new PcmaBackchannel(output, { clock, mode });
        sender.pushRtp(rtp(Buffer.alloc(frameSamples * 4)));
        clock.time = 500;
        clock.advance(0);
        assert.deepEqual(times, [0, 0, 500]);
        clock.advance(frameMs - 1);
        assert.equal(times.length, 3);
        sender.stop();
        clock.advance(1000);
        sender.pushRtp(rtp(Buffer.alloc(frameSamples)));
        assert.equal(times.length, 3);
    });

    test(`${frameMs} ms queue remains bounded when the network is backpressured`, async () => {
        const clock = new FakeClock();
        const writes: Buffer[] = [];
        const reports: AudioSendingStatistics[] = [];
        let complete: (() => void) | undefined;
        const output = new Writable({ highWaterMark: 1, write(data, _, callback) {
            writes.push(Buffer.from(data)); complete = callback;
        } });
        const sender = new PcmaBackchannel(output, { clock, mode, onStatistics: stats => reports.push(stats) });
        sender.pushRtp(rtp(Buffer.concat([Buffer.alloc(8192, 0x11), Buffer.alloc(8192, 0x22)])));
        clock.advance(frameMs * 2);
        assert.equal(writes.length, 1);
        complete!();
        await new Promise<void>(resolve => setImmediate(resolve));
        clock.advance(frameMs);
        assert.equal(writes.length, 2);
        assert.deepEqual(audio(writes[1]), Buffer.alloc(frameSamples, 0x22));
        sender.stop();
        assert.equal(reports[0].overloadDroppedSamples, 10240);
        complete!();
        output.destroy();
    });
}

test('absolute pacing does not drift when timers fire late', () => {
    const clock = new LaggyClock();
    const writes: number[] = [];
    const output = new Writable({ write(_data, _, callback) { writes.push(clock.now()); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });

    // 160-byte RTP packets every 20 ms, exactly real-time, for 30 seconds.
    // The old reset-to-now pacing accumulated ~0.5 ms per frame, leaving
    // almost a second of queued audio by the end of the 30 seconds.
    for (let time = 20; time <= 30000; time += 20) {
        clock.advanceTo(time);
        sender.pushRtp(rtp(Buffer.alloc(160)));
    }

    const intervals = writes.slice(2).map((time, index) => time - writes[index + 1]);
    const mean = intervals.reduce((total, value) => total + value, 0) / intervals.length;
    assert.ok(Math.abs(mean - 64) < 0.1, `mean write interval was ${mean} ms, expected 64 ms`);
    assert.ok((sender as any).pending.length < 1024, 'pacing accumulated a growing backlog');
    sender.stop();
});

test('stop(true) flushes the last partial frame with A-law silence', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({
        write(data, _, callback) {
            writes.push(Buffer.from(data));
            callback();
        },
    });
    const sender = new PcmaBackchannel(output, { clock });
    const samples = Buffer.from(Array.from({ length: 160 }, (_, index) => index & 255));

    sender.pushRtp(rtp(samples));
    assert.equal(writes.length, 1); // PAT/PMT only; the frame is incomplete

    await flushWithClock(sender, clock);

    assert.equal(writes.length, 5, 'expected the tail plus three silence frames');
    const payload = audio(writes[1]);
    assert.equal(payload.length, 512);
    assert.deepEqual(payload.subarray(0, samples.length), samples);
    assert.ok(payload.subarray(samples.length).every(value => value === 0xd5));
    for (const write of writes.slice(2))
        assert.ok(audio(write).every(value => value === 0xd5));
    sender.stop();
});

test('RTP parser skips CSRC, extension and padding; rejects malformed packets', () => {
    const packet = Buffer.alloc(12 + 4 + 8 + 3 + 2);
    packet.set([0xb1, 8]); // padding, extension, one CSRC
    packet.writeUInt16BE(1, 18); // one extension word after four-byte header
    packet.set([0x11, 0x22, 0x33], 24);
    packet[packet.length - 1] = 2;
    assert.deepEqual(pcmaRtpPayload(packet), Buffer.from([0x11, 0x22, 0x33]));
    assert.equal(pcmaRtpPayload(Buffer.alloc(3)), undefined);
    assert.equal(pcmaRtpPayload(Buffer.from([0x90, 8, ...Buffer.alloc(10)])), undefined);
    packet[packet.length - 1] = 200;
    assert.equal(pcmaRtpPayload(packet), undefined);
    assert.equal(pcmaRtpPayload(Buffer.from([0x80, 0, ...Buffer.alloc(20)])), undefined);
});


test('removed immediate and unknown settings normalize to paced 64 ms', () => {
    assert.equal(normalizeAudioSendMode(undefined), audioSendModes.paced64);
    assert.equal(normalizeAudioSendMode('VIGI RTP / immediate'), audioSendModes.paced64);
    assert.equal(normalizeAudioSendMode('unknown'), audioSendModes.paced64);
    assert.equal(normalizeAudioSendMode(audioSendModes.paced64), audioSendModes.paced64);
    assert.equal(normalizeAudioSendMode(audioSendModes.paced), audioSendModes.paced);
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { mode: 'VIGI RTP / immediate' as typeof audioSendModes.paced });
    sender.pushRtp(rtp(Buffer.alloc(160)));
    assert.equal(writes.length, 1); // PAT/PMT only: legacy mode must not immediately send small RTP payloads
    sender.pushRtp(rtp(Buffer.alloc(352)));
    assert.equal(writes.length, 2);
    assert.equal(audio(writes[1]).length, 512);
    sender.stop();
});

test('RTP statistics report payload sizes, audio durations and actual arrival intervals', () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, onStatistics: statistics => reports.push(statistics),
    });
    sender.pushRtp(rtp(Buffer.alloc(160)));
    clock.advance(20);
    sender.pushRtp(rtp(Buffer.alloc(512)));
    clock.advance(64);
    sender.pushRtp(rtp(Buffer.alloc(1024)));
    assert.equal(reports.length, 0);
    clock.advance(4920);
    sender.pushRtp(rtp(Buffer.alloc(160)));
    assert.equal(reports.length, 0); // no periodic logging, even after five seconds
    sender.stop();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'stop');
    assert.equal(reports[0].windowMilliseconds, 5004);
    assert.deepEqual(reports[0].rtpReceived, {
        packets: 4,
        audioMilliseconds: 232,
        payloadSizes: [
            { bytes: 160, audioMilliseconds: 20, count: 2 },
            { bytes: 512, audioMilliseconds: 64, count: 1 },
            { bytes: 1024, audioMilliseconds: 128, count: 1 },
        ],
        intervalMilliseconds: { minimum: 20, mean: 1668, maximum: 4920 },
    });
    assert.deepEqual(reports[0].pesWritten.payloadSizes, [{ bytes: 512, audioMilliseconds: 64, count: 3 }]);
    sender.stop();
    sender.stop();
    assert.equal(reports.length, 1); // stop is idempotent
});

test('paced statistics distinguish incoming RTP sizes from outgoing PES aggregation', () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, mode: audioSendModes.paced, onStatistics: statistics => reports.push(statistics),
    });
    for (let i = 0; i < 3; i++)
        sender.pushRtp(rtp(Buffer.alloc(512)));
    clock.advance(128);
    sender.pushRtp(rtp(Buffer.alloc(512)));
    sender.stop();
    sender.stop();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'stop');
    assert.deepEqual(reports[0].rtpReceived.payloadSizes, [{ bytes: 512, audioMilliseconds: 64, count: 4 }]);
    assert.deepEqual(reports[0].pesWritten.payloadSizes, [{ bytes: 1024, audioMilliseconds: 128, count: 2 }]);
    assert.equal(reports[0].pesWritten.intervalMilliseconds?.mean, 128);
});

test('PAT and PMT are written once before the first audio frame', () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 2 * 188);
    assert.equal(writes[0][0], 0x47);
    assert.equal(writes[0][2], 0); // PAT PID 0
    assert.equal(writes[0][188 + 2], 18); // PMT PID 18

    sender.pushRtp(rtp(Buffer.alloc(512)));
    assert.equal(writes.length, 2);
    const audio = writes[1];
    assert.equal(audio.length, 3 * 188);
    assert.equal(audio[2], 68); // audio PID 68
    assert.equal((audio[1] & 0x1f) << 8 | audio[2], 68);
    sender.stop();
});

test('a late timer sends one frame and skips missed slots instead of bursting', () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const output = new Writable({ write(_data, _, callback) { times.push(clock.now()); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });

    sender.pushRtp(rtp(Buffer.alloc(512 * 4)));
    assert.deepEqual(times, [0, 0]); // PAT/PMT and the first frame

    // The 64 ms timer fires at 65 ms. With the old catch-up logic this sent
    // two frames back to back; the absolute schedule must skip the lost slot.
    clock.time = 65;
    clock.advance(0);
    assert.deepEqual(times, [0, 0, 65]);

    clock.advance(62);
    assert.deepEqual(times, [0, 0, 65]);
    clock.advance(1);
    assert.deepEqual(times, [0, 0, 65, 128]);
    sender.stop();
});

test('stop(true) sends tail silence even when statistics are disabled', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });

    for (let i = 0; i < 3; i++)
        sender.pushRtp(rtp(Buffer.alloc(512, i + 1)));
    clock.advance(64);
    clock.advance(64);
    assert.equal(writes.length, 4); // PAT/PMT and three audio frames

    await flushWithClock(sender, clock);
    assert.equal(writes.length, 7); // three silence frames
    assert.ok(audio(writes[4]).every(value => value === 0xd5));
    assert.ok(audio(writes[5]).every(value => value === 0xd5));
    assert.ok(audio(writes[6]).every(value => value === 0xd5));
});

test('stop(true) sends the newest frame-sized window and drops older backlog', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });
    const samples = Buffer.from(Array.from({ length: 512 * 2 + 100 }, (_, index) => index & 255));

    sender.pushRtp(rtp(samples));
    assert.equal(writes.length, 2); // PAT/PMT and the first full frame

    await flushWithClock(sender, clock);

    const tail = audio(writes[2]);
    assert.equal(tail.length, 512);
    assert.deepEqual(tail, samples.subarray(samples.length - 512));
    for (const write of writes.slice(3))
        assert.ok(audio(write).every(value => value === 0xd5));
    assert.equal(writes.length, 6); // tail + three silence frames

    const before = writes.length;
    await sender.stop(true);
    sender.stop();
    assert.equal(writes.length, before);
});

test('stop(true) pads a 1024-sample tail and sends three silence frames', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock, mode: audioSendModes.paced });
    const samples = Buffer.from(Array.from({ length: 1024 + 300 }, (_, index) => index & 255));

    sender.pushRtp(rtp(samples));
    assert.equal(writes.length, 2); // PAT/PMT and the first full 1024 frame
    await flushWithClock(sender, clock);

    assert.equal(writes.length, 6); // tail + three silence frames
    const tail = audio(writes[2]);
    assert.equal(tail.length, 1024);
    assert.deepEqual(tail.subarray(0, 300), samples.subarray(1024));
    assert.ok(tail.subarray(300).every(value => value === 0xd5));
    for (const write of writes.slice(3))
        assert.equal(audio(write).length, 1024);
});

test('stop() without flush cancels queued audio immediately', () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });

    sender.pushRtp(rtp(Buffer.alloc(160)));
    assert.equal(writes.length, 1);
    sender.stop();
    clock.advance(1000);
    sender.pushRtp(rtp(Buffer.alloc(512)));
    clock.advance(1000);
    assert.equal(writes.length, 1);
});

test('output close stops the sender and reports statistics once', async () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, onStatistics: statistics => reports.push(statistics),
    });

    sender.pushRtp(rtp(Buffer.alloc(160)));
    output.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'stop');
    assert.equal(reports[0].rtpReceived.packets, 1);
    sender.stop();
    assert.equal(reports.length, 1);
});

test('stop(true) resolves when the output is already destroyed', async () => {
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output);
    sender.pushRtp(rtp(Buffer.alloc(160)));
    output.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
    await sender.stop(true);
});

test('RTP parser rejects header, extension, padding and payload-type edge cases', () => {
    assert.equal(pcmaRtpPayload(Buffer.alloc(12)), undefined);

    const csrcOverflow = Buffer.alloc(20);
    csrcOverflow.set([0x8f, 8]);
    assert.equal(pcmaRtpPayload(csrcOverflow), undefined);

    const extensionOverflow = Buffer.alloc(20);
    extensionOverflow.set([0x90, 8]);
    extensionOverflow.writeUInt16BE(100, 14);
    assert.equal(pcmaRtpPayload(extensionOverflow), undefined);

    const zeroPadding = Buffer.alloc(20);
    zeroPadding.set([0xa0, 8]);
    zeroPadding[19] = 0;
    assert.equal(pcmaRtpPayload(zeroPadding), undefined);

    const paddingOverflow = Buffer.alloc(20);
    paddingOverflow.set([0xa0, 8]);
    paddingOverflow[19] = 100;
    assert.equal(pcmaRtpPayload(paddingOverflow), undefined);

    const wrongType = Buffer.alloc(20);
    wrongType.set([0x80, 0]);
    assert.equal(pcmaRtpPayload(wrongType), undefined);

    const wrongVersion = Buffer.alloc(20);
    wrongVersion.set([0x40, 8]);
    assert.equal(pcmaRtpPayload(wrongVersion), undefined);
});

test('overload drops whole frames and keeps the queue aligned', () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, onStatistics: statistics => reports.push(statistics),
    });

    sender.pushRtp(rtp(Buffer.alloc(7000, 0x33)));
    assert.ok((sender as any).pending.length <= 6144);
    sender.stop();
    const dropped = reports[0].overloadDroppedSamples;
    assert.equal(dropped, Math.ceil((7000 - 6144) / 512) * 512);
    assert.equal(dropped % 512, 0);
});

for (const [mode, frameSamples, frameMilliseconds] of [
    [audioSendModes.paced64, 512, 64],
    [audioSendModes.paced, 1024, 128],
] as const) {
    test(`${frameMilliseconds} ms tail frames remain paced and wait for playback before ending`, async () => {
        const clock = new FakeClock();
        const times: number[] = [];
        let endedAt: number | undefined;
        const output = new Writable({
            write(_data, _encoding, callback) { times.push(clock.now()); callback(); },
            final(callback) { endedAt = clock.now(); callback(); },
        });
        const sender = new PcmaBackchannel(output, { clock, mode });
        sender.pushRtp(rtp(Buffer.alloc(frameSamples + 100, 0x11)));
        const stopping = sender.stop(true);
        let settled = false;
        Promise.resolve(stopping).then(() => settled = true, () => settled = true);
        // Drive the async flush at 1 ms resolution, including its microtasks.
        for (let i = 0; i < frameMilliseconds * 6 + tailPlaybackGraceMilliseconds; i++) {
            clock.advance(1);
            await Promise.resolve();
        }
        assert.ok(settled, 'paced tail must finish within the bounded playback window');
        await stopping;
        assert.equal(times.length, 6); // tables, live frame, tail, three silence frames
        const audioTimes = times.slice(1);
        for (let i = 1; i < audioTimes.length; i++)
            assert.ok(audioTimes[i] - audioTimes[i - 1] >= frameMilliseconds, 'tail must not burst');
        assert.ok(endedAt! - audioTimes[audioTimes.length - 1] >= frameMilliseconds + tailPlaybackGraceMilliseconds);
    });
}

test('an immediate stop cancels an in-flight paced tail flush', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    const output = new Writable({ write(data, _encoding, callback) { writes.push(Buffer.from(data)); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });
    sender.pushRtp(rtp(Buffer.alloc(612)));
    const stopping = sender.stop(true);
    sender.stop();
    await stopping;
    clock.advance(10000);
    assert.equal(writes.length, 2);
    assert.equal(output.writableEnded, false, 'an immediate cancel must not end an unrelated output');
});

test('tail flush is bounded when output never drains', async () => {
    const clock = new FakeClock();
    const output = new Writable({ write(_data, _encoding, _callback) { /* stalled */ } });
    const sender = new PcmaBackchannel(output, { clock });
    sender.pushRtp(rtp(Buffer.alloc(100)));
    await flushWithClock(sender, clock);
    assert.equal(output.writableEnded, true);
    assert.ok(output.writableLength <= 376, 'no tail frames should queue behind a stalled write');
    output.destroy();
});
