import { performance } from 'perf_hooks';
import { Writable } from 'stream';
import { AudioPacketStatistics, AudioPacketSummary } from './audio-stats';
import { MpegTSWriter, StreamTypePCMATapo } from './mpegts-writer';

export const pcmaFrameSamples = 512;
export const pcmaFrameMilliseconds = pcmaFrameSamples * 1000 / 8000;
const maximumBufferedSamples = 8192; // about one second at 8 kHz

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
    private stopped = false;
    private nextSendAt = 0;
    private writer = new MpegTSWriter();
    private clock: Clock;
    private mode: AudioSendMode;
    private frameSamples: number;
    private frameMilliseconds: number;
    private rtpStatistics = new AudioPacketStatistics();
    private pesStatistics = new AudioPacketStatistics();
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
        if (this.stopped)
            return;
        if (this.output.destroyed) {
            this.stop();
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

    stop = (): void => {
        if (this.stopped)
            return;
        this.stopped = true;
        if (this.timer !== undefined)
            this.clock.cancel(this.timer);
        this.timer = undefined;
        this.pending = Buffer.alloc(0);
        this.output.off('close', this.stop);
        this.reportStatistics();
    };

    private writeFrame(payload: Buffer): void {
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
        if (this.stopped || this.timer !== undefined || this.pending.length < this.frameSamples)
            return;
        if (this.output.destroyed) {
            this.stop();
            return;
        }
        const delay = this.nextSendAt - this.clock.now();
        if (delay > 0 || this.output.writableNeedDrain) {
            this.timer = this.clock.schedule(() => {
                this.timer = undefined;
                this.pump();
            }, delay > 0 ? delay : this.frameMilliseconds);
            return;
        }
        this.writeFrame(this.pending.subarray(0, this.frameSamples));
        this.pending = this.pending.subarray(this.frameSamples);
        // A delayed event loop must not cause a burst of catch-up frames.
        this.nextSendAt = this.clock.now() + this.frameMilliseconds;
        this.pump();
    }
}
