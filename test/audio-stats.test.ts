import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioPacketStatistics } from '../src/audio-stats';

test('empty statistics report no packets and no intervals', () => {
    const statistics = new AudioPacketStatistics();
    assert.equal(statistics.count, 0);
    assert.deepEqual(statistics.snapshot(), {
        packets: 0,
        audioMilliseconds: 0,
        payloadSizes: [],
        intervalMilliseconds: undefined,
    });
});

test('statistics group payload sizes, convert bytes to audio time and round intervals', () => {
    const statistics = new AudioPacketStatistics();
    statistics.record(160, 0);
    assert.equal(statistics.count, 1);
    statistics.record(160, 20);
    statistics.record(4, 40.12345);
    statistics.record(512, 104.12345);

    assert.deepEqual(statistics.snapshot(), {
        packets: 4,
        audioMilliseconds: 104.5,
        payloadSizes: [
            { bytes: 4, audioMilliseconds: 0.5, count: 1 },
            { bytes: 160, audioMilliseconds: 20, count: 2 },
            { bytes: 512, audioMilliseconds: 64, count: 1 },
        ],
        intervalMilliseconds: {
            minimum: 20,
            mean: 34.708,
            maximum: 64,
        },
    });
});

test('snapshot is a copy and does not reset accumulated statistics', () => {
    const statistics = new AudioPacketStatistics();
    statistics.record(160, 0);
    const first = statistics.snapshot();
    const second = statistics.snapshot();

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.payloadSizes, second.payloadSizes);

    statistics.record(320, 20);
    assert.equal(statistics.count, 2);
    assert.equal(statistics.snapshot().packets, 2);
});
