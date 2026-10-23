export interface AudioPacketSummary {
    packets: number;
    audioMilliseconds: number;
    payloadSizes: { bytes: number; audioMilliseconds: number; count: number }[];
    intervalMilliseconds?: { minimum: number; mean: number; maximum: number };
}

// Metadata only: never retain or log audio samples, RTP headers or credentials.
export class AudioPacketStatistics {
    private sizes = new Map<number, number>();
    private packets = 0;
    private samples = 0;
    private lastTime?: number;
    private intervalCount = 0;
    private intervalTotal = 0;
    private minimumInterval = Infinity;
    private maximumInterval = 0;

    record(bytes: number, time: number): void {
        this.sizes.set(bytes, (this.sizes.get(bytes) || 0) + 1);
        this.packets++;
        this.samples += bytes;
        if (this.lastTime !== undefined) {
            const interval = time - this.lastTime;
            this.intervalCount++;
            this.intervalTotal += interval;
            this.minimumInterval = Math.min(this.minimumInterval, interval);
            this.maximumInterval = Math.max(this.maximumInterval, interval);
        }
        this.lastTime = time;
    }

    snapshot(): AudioPacketSummary {
        const round = (value: number) => Math.round(value * 1000) / 1000;
        return {
            packets: this.packets,
            // 8 kHz mono PCMA has one byte per sample: 8 bytes per millisecond.
            audioMilliseconds: this.samples / 8,
            payloadSizes: [...this.sizes.entries()].sort(([a], [b]) => a - b).map(([bytes, count]) => ({
                bytes, audioMilliseconds: bytes / 8, count,
            })),
            intervalMilliseconds: this.intervalCount ? {
                minimum: round(this.minimumInterval),
                mean: round(this.intervalTotal / this.intervalCount),
                maximum: round(this.maximumInterval),
            } : undefined,
        };
    }
}
