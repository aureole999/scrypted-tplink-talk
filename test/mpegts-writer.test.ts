import assert from 'node:assert/strict';
import test from 'node:test';
import { MpegTSWriter, StreamTypePCMATapo } from '../src/mpegts-writer';

function packets(data: Buffer): Buffer[] {
    assert.equal(data.length % 188, 0);
    return Array.from({ length: data.length / 188 }, (_, i) => {
        const packet = data.subarray(i * 188, (i + 1) * 188);
        assert.equal(packet[0], 0x47);
        return packet;
    });
}

function payload(packet: Buffer): Buffer {
    return packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
}

function decodePts(pes: Buffer): number {
    const p = pes.subarray(9, 14);
    assert.equal(p[0] & 0xf1, 0x21);
    assert.equal(p[2] & 1, 1);
    assert.equal(p[4] & 1, 1);
    return (p[0] >> 1 & 7) * 2 ** 30 + p[1] * 2 ** 22
        + (p[2] >> 1) * 2 ** 15 + p[3] * 2 ** 7 + (p[4] >> 1);
}

function writer() {
    const result = new MpegTSWriter();
    result.addPES(68, StreamTypePCMATapo);
    return result;
}

test('PAT and PMT have valid MPEG-2 CRC and 0xff PSI stuffing', () => {
    const mux = writer();
    mux.writePAT();
    mux.writePMT();
    for (const packet of packets(mux.resetBytes())) {
        const section = payload(packet).subarray(1);
        const length = 3 + ((section[1] & 15) * 256 + section[2]);
        // Polynomial long division over the complete section including its CRC.
        let remainder = 0xffffffff;
        for (const value of section.subarray(0, length)) {
            for (let bit = 7; bit >= 0; bit--) {
                const carry = (remainder >>> 31) ^ ((value >> bit) & 1);
                remainder <<= 1;
                if (carry)
                    remainder ^= 0x04c11db7;
            }
        }
        assert.equal(remainder >>> 0, 0);
        assert.ok(section.subarray(length).every(b => b === 0xff));
    }
});

for (const size of [1, 160, 169, 170, 171, 354, 355, 1024]) {
    test(`PES preserves ${size} PCMA samples and continuity across PES boundaries`, () => {
        const mux = writer();
        const audio = Buffer.from(Array.from({ length: size }, (_, i) => i & 255));
        let nextCounter = 0;
        for (let frame = 0; frame < 20; frame++) {
            mux.writePES(68, 192, audio);
            const ts = packets(mux.resetBytes());
            for (let i = 0; i < ts.length; i++) {
                assert.equal(ts[i][3] & 15, nextCounter);
                nextCounter = (nextCounter + 1) & 15;
                assert.equal(!!(ts[i][1] & 0x40), i === 0);
            }
            const pes = Buffer.concat(ts.map(payload));
            assert.equal(pes.readUInt16BE(4), size + 8);
            assert.equal(decodePts(pes), Math.floor(frame * size * 90000 / 8000));
            assert.deepEqual(pes.subarray(14), audio);
        }
    });
}

test('elementary stream timestamps and counters are independent per PID', () => {
    const mux = writer();
    mux.addPES(69, StreamTypePCMATapo);
    mux.writePES(68, 192, Buffer.alloc(1024));
    mux.resetBytes();
    mux.writePES(69, 193, Buffer.alloc(160));
    const ts = packets(mux.resetBytes());
    assert.equal(ts[0][3] & 15, 0);
    assert.equal(decodePts(Buffer.concat(ts.map(payload))), 0);
    mux.writePES(68, 192, Buffer.alloc(1024));
    assert.equal(decodePts(Buffer.concat(packets(mux.resetBytes()).map(payload))), 11520);
});
