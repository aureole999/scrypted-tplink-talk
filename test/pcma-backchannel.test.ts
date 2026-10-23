import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'stream';
import { audioSendModes, AudioSendingStatistics, normalizeAudioSendMode, PcmaBackchannel, pcmaRtpPayload } from '../src/pcma-backchannel';

class FakeClock {
    time = 0;
    private tasks = new Map<object, { at: number; callback: () => void }>();
    now = () => this.time;
    schedule = (callback: () => void, milliseconds: number) => {
        const id = {};
        this.tasks.set(id, { at: this.time + milliseconds, callback });
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
        assert.equal(reports[0].overloadDroppedSamples, 8192);
        complete!();
        output.destroy();
    });
}

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
