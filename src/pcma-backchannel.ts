import { performance } from 'perf_hooks';
import { Writable } from 'stream';
import { AudioPacketStatistics, AudioPacketSummary } from './audio-stats';
import { MpegTSWriter, StreamTypePCMATapo } from './mpegts-writer';

export const pcmaFrameSamples = 512;
export const pcmaFrameMilliseconds = pcmaFrameSamples * 1000 / 8000;
// PCMA is one byte per sample at 8 kHz. The application queue is 768 ms and
// the backchannel Writable queue is 256 ms, for roughly a one-second total
// bound. The Writable sits directly in front of net.Socket and propagates its
// backpressure, so a stalled camera cannot use Node's default high-water mark
// (64 KiB on current releases) to add several seconds of stale audio.
const maximumBufferedSamples = 6144;
export const backchannelHighWaterMark = 2048;
export const tailPlaybackGraceMilliseconds = 500;
const alawSilence = 0xD5;

export const audioSendModes = {
    paced: '1024 samples / 128 ms',
    paced64: '512 samples / 64 ms',
} as const;
export type AudioSendMode = typeof audioSendModes[keyof typeof audioSendModes];

export function normalizeAudioSendMode(value: unknown): AudioSendMode {
    // Legacy immediate and unknown settings safely use the default paced mode.
    return value === audioSendModes.paced ? audioSendModes.paced : audioSendModes.paced64;
}

interface Clock {
    now(): number;
    schedule(callback: () => void, milliseconds: number): unknown;
    cancel(timer: unknown): void;
}

const realClock: Clock = {
    now: () => performance.now(),
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as NodeJS.Timeout),
};

interface BackchannelOptions {
    mode?: AudioSendMode;
    clock?: Clock;
    onStatistics?: (statistics: AudioSendingStatistics) => void;
}

export interface AudioSendingStatistics {
    mode: AudioSendMode;
    reason: 'stop';
    windowMilliseconds: number;
    rtpReceived: AudioPacketSummary;
    pesWritten: AudioPacketSummary;
    overloadDroppedSamples: number;
}

// FFmpeg RTP boundaries are not camera audio frame boundaries.
export function pcmaRtpPayload(rtp: Buffer): Buffer | undefined {
    if (rtp.length < 12 || rtp[0] >> 6 !== 2 || (rtp[1] & 0x7f) !== 8)
        return;
    let offset = 12 + (rtp[0] & 15) * 4;
    if (offset > rtp.length)
        return;
    if (rtp[0] & 0x10) {
        if (offset + 4 > rtp.length)
            return;
        offset += 4 + rtp.readUInt16BE(offset + 2) * 4;
    }
    const padding = rtp[0] & 0x20 ? rtp[rtp.length - 1] : 0;
    if ((rtp[0] & 0x20) && !padding)
        return;
    const end = rtp.length - padding;
    if (offset >= end)
        return;
    return rtp.subarray(offset, end);
}

export class PcmaBackchannel {
    private pending = Buffer.alloc(0);
    private timer?: unknown;
    private stopWaiting?: () => void;
    private stopped = false;
    private flushing = false;
    private stopPromise?: Promise<void>;
    private nextSendAt = 0;
    private writer = new MpegTSWriter();
    private clock: Clock;
    private mode: AudioSendMode;
    private frameSamples: number;
    private frameMilliseconds: number;
    private rtpStatistics = new AudioPacketStatistics();
    private pesStatistics = new AudioPacketStatistics();
    private framesWritten = 0;
    private statisticsSince: number;
    private overloadDroppedSamples = 0;
    private onStatistics?: BackchannelOptions['onStatistics'];

    constructor(private output: Writable, options: BackchannelOptions = {}) {
        this.clock = options.clock || realClock;
        this.mode = normalizeAudioSendMode(options.mode);
        this.frameSamples = this.mode === audioSendModes.paced ? 1024 : 512;
        this.frameMilliseconds = this.frameSamples * 1000 / 8000;
        this.statisticsSince = this.clock.now();
        this.onStatistics = options.onStatistics;
        this.writer.addPES(68, StreamTypePCMATapo);
        this.writer.writePAT();
        this.writer.writePMT();
        output.write(this.writer.resetBytes());
        output.once('close', this.stop);
    }

    pushRtp(rtp: Buffer): void {
        if (this.stopped || this.flushing)
            return;
        if (this.output.destroyed || this.output.writableEnded) {
            this.finishStop();
            return;
        }
        const payload = pcmaRtpPayload(rtp);
        if (!payload)
            return;
        if (this.onStatistics)
            this.rtpStatistics.record(payload.length, this.clock.now());
        this.pending = Buffer.concat([this.pending, payload]);
        // UDP cannot be backpressured. Drop old whole audio frames on overload
        // rather than letting live talkback latency grow without a bound.
        if (this.pending.length > maximumBufferedSamples) {
            const drop = Math.ceil((this.pending.length - maximumBufferedSamples) / this.frameSamples) * this.frameSamples;
            this.pending = this.pending.subarray(drop);
            this.overloadDroppedSamples += drop;
        }
        this.pump();
    }

    stop = (flush = false): void | Promise<void> => {
        if (this.stopped)
            return;
        if (!flush) {
            this.finishStop();
            return;
        }
        if (!this.stopPromise)
            this.stopPromise = this.flushAndStop();
        return this.stopPromise;
    };

    private finishStop(): void {
        if (this.stopped)
            return;
        this.stopped = true;
        this.flushing = false;
        if (this.timer !== undefined)
            this.clock.cancel(this.timer);
        this.timer = undefined;
        this.stopWaiting?.();
        this.pending = Buffer.alloc(0);
        this.output.off('close', this.stop);
        this.reportStatistics();
    }

    private async flushAndStop(): Promise<void> {
        this.flushing = true;
        if (this.timer !== undefined) {
            this.clock.cancel(this.timer);
            this.timer = undefined;
        }

        try {
            if (!this.output.destroyed && !this.output.writableEnded) {
                // Do not use the statistics counters here: onStatistics is
                // optional, and the tail silence must still be sent when the
                // caller does not collect statistics.
                const hadAudio = this.framesWritten > 0 || this.pending.length > 0;
                const frames: Buffer[] = [];
                // Send the newest frame-sized window (or all pending audio if
                // smaller) padded with A-law silence. This keeps the last
                // 64/128 ms and intentionally drops older backlog: if the
                // socket was backpressured, that audio is already stale.
                const tailLength = Math.min(this.pending.length, this.frameSamples);
                if (tailLength) {
                    const frame = Buffer.alloc(this.frameSamples, alawSilence);
                    this.pending.copy(frame, 0, this.pending.length - tailLength, this.pending.length);
                    frames.push(frame);
                }
                this.pending = Buffer.alloc(0);
                if (hadAudio) {
                    // Three silence frames let the camera finish the tail
                    // instead of closing the decoder on the last speech sample.
                    for (let i = 0; i < 3; i++)
                        frames.push(Buffer.alloc(this.frameSamples, alawSilence));
                }
                let written = false;
                for (const frame of frames) {
                    await this.waitForDelay(Math.max(0, this.nextSendAt - this.clock.now()));
                    await this.waitForOutputFlush(200);
                    // A stalled socket must not turn shutdown into an
                    // unbounded queue or a burst of stale tail frames.
                    if (!this.canFlush() || this.output.writableLength)
                        break;
                    this.writeFrame(frame);
                    written = true;
                    this.nextSendAt = this.clock.now() + this.frameMilliseconds;
                }
                await this.waitForOutputFlush(200);
                // A successful write only means bytes reached the transport.
                // Let the last frame play, then wait the 500 ms grace period
                // before the caller closes the socket.
                if (written && !this.output.writableLength)
                    await this.waitForDelay(this.frameMilliseconds + tailPlaybackGraceMilliseconds);
                if (!this.stopped && !this.output.destroyed && !this.output.writableEnded)
                    this.output.end();
            }
        }
        finally {
            this.flushing = false;
            this.finishStop();
        }
    }

    private canFlush(): boolean {
        return !this.stopped && !this.output.destroyed && !this.output.writableEnded;
    }

    private waitForDelay(milliseconds: number): Promise<void> {
        if (!this.canFlush() || milliseconds <= 0)
            return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                this.clock.cancel(timer);
                if (this.timer === timer)
                    this.timer = undefined;
                if (this.stopWaiting === finish)
                    this.stopWaiting = undefined;
                resolve();
            };
            const timer = this.clock.schedule(finish, milliseconds);
            this.timer = timer;
            this.stopWaiting = finish;
        });
    }

    private async waitForOutputFlush(timeoutMilliseconds: number): Promise<void> {
        const deadline = this.clock.now() + timeoutMilliseconds;
        // `drain` need not fire for a write below the high-water mark. Poll a
        // bounded amount instead, and let close/stop cancel every wait.
        while (this.canFlush() && this.output.writableLength && this.clock.now() < deadline)
            await this.waitForDelay(Math.min(10, deadline - this.clock.now()));
    }

    private writeFrame(payload: Buffer): void {
        this.framesWritten++;
        if (this.onStatistics)
            this.pesStatistics.record(payload.length, this.clock.now());
        this.writer.writePES(68, 192, payload);
        this.output.write(this.writer.resetBytes());
    }

    private reportStatistics(): void {
        if (!this.onStatistics)
            return;
        const now = this.clock.now();
        const rtpReceived = this.rtpStatistics.snapshot();
        const pesWritten = this.pesStatistics.snapshot();
        if (!rtpReceived.packets && !pesWritten.packets)
            return;
        this.onStatistics({
            mode: this.mode,
            reason: 'stop',
            windowMilliseconds: Math.round(now - this.statisticsSince),
            rtpReceived,
            pesWritten,
            overloadDroppedSamples: this.overloadDroppedSamples,
        });
        this.statisticsSince = now;
        this.rtpStatistics = new AudioPacketStatistics();
        this.pesStatistics = new AudioPacketStatistics();
        this.overloadDroppedSamples = 0;
    }

    private pump(): void {
        if (this.stopped || this.flushing || this.timer !== undefined || this.pending.length < this.frameSamples)
            return;
        if (this.output.destroyed || this.output.writableEnded) {
            this.finishStop();
            return;
        }

        const now = this.clock.now();
        if (!this.nextSendAt)
            this.nextSendAt = now;

        // Keep an absolute schedule. Resetting the deadline to `now` after
        // every write adds the event-loop/write overhead to every interval,
        // so a 64 ms stream actually goes out every ~64.5 ms and latency
        // creeps up on long calls. Never send a catch-up burst: if the next
        // slot is already in the past after this frame, skip it.
        const delay = this.nextSendAt - now;
        if (delay > 0 || this.output.writableNeedDrain) {
            this.timer = this.clock.schedule(() => {
                this.timer = undefined;
                this.pump();
            }, delay > 0 ? delay : this.frameMilliseconds);
            return;
        }
        this.writeFrame(this.pending.subarray(0, this.frameSamples));
        this.pending = this.pending.subarray(this.frameSamples);
        this.nextSendAt += this.frameMilliseconds;
        // After a real stall, skip the missed slots instead of sending the
        // backlog as a burst. A sub-frame-late timer keeps the absolute
        // schedule; this only triggers when at least one whole slot was lost.
        if (this.nextSendAt <= now)
            this.nextSendAt = now + this.frameMilliseconds;
        this.pump();
    }
}
