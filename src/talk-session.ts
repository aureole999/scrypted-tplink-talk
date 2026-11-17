import type { FFmpegInput } from '@scrypted/sdk';
import { AudioForwarder, AudioForwarderDependencies } from './audio-forwarder';
import { AudioSendingStatistics, normalizeAudioSendMode, PcmaBackchannel } from './pcma-backchannel';
import { normalizeChannel, ResolvedConnectionSettings } from './settings-utils';
import { normalizeTalkMode, TalkMode, VigiApi } from './vigi-api';
import { VigiError, describeVigiError } from './vigi-error';

export interface TalkSessionDependencies {
    connect: (options: {
        host: string;
        port: number;
        username: string;
        password: string;
    }, signal?: AbortSignal) => Promise<VigiApi>;
    startForwarder: (console: Console, input: FFmpegInput, onRtp: (rtp: Buffer) => void, dependencies: AudioForwarderDependencies) => Promise<AudioForwarder>;
    getFFmpegPath: () => Promise<string>;
    onStatistics?: (statistics: AudioSendingStatistics) => void;
}

export interface TalkSessionStartOptions {
    ffmpegInput: FFmpegInput;
    connection: ResolvedConnectionSettings;
    mode: TalkMode | string;
    audioSendMode?: string;
    channel?: unknown;
    signal?: AbortSignal;
}

function waitForExit(promise: Promise<void>, milliseconds: number): Promise<void> {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        timer.unref?.();
        promise.then(finish, finish);
    });
}

function abortedError(): VigiError {
    return new VigiError('VIGI connection aborted.', 'config', { retryable: false });
}

function supersededError(): VigiError {
    return new VigiError('VIGI session was superseded by a newer start or stop.', 'config', { retryable: false });
}

/**
 * Owns one talk client/backchannel/forwarder session. The Scrypted mixin keeps
 * the settings/UI/serialization glue; this class is testable without the SDK.
 * The generation token and captured fields make direct start/stop calls safe;
 * the mixin still serializes them for ordering.
 */
export class TalkSession {
    private client?: VigiApi;
    private backchannel?: PcmaBackchannel;
    private forwarder?: AudioForwarder;
    private generation = 0;
    private startupAbort?: AbortController;
    private externalAbortCleanup?: () => void;
    private closing?: Promise<void>;

    constructor(private console: Console, private dependencies: TalkSessionDependencies) {
    }

    private trackClosing(action: () => Promise<void>): Promise<void> {
        const previous = this.closing;
        const closing = (async () => {
            try {
                if (previous)
                    await previous;
            }
            catch {
            }
            try {
                await action();
            }
            catch (e) {
                this.console.error('TP-Link session close failed:', describeVigiError(e));
            }
        })();
        this.closing = closing;
        closing.finally(() => {
            if (this.closing === closing)
                this.closing = undefined;
        }).catch(() => undefined);
        return closing;
    }

    async start(options: TalkSessionStartOptions): Promise<void> {
        const generation = ++this.generation;
        await this.stopInternal();
        if (this.generation !== generation)
            throw supersededError();
        if (options.signal?.aborted)
            throw abortedError();

        const startupAbort = this.startupAbort = new AbortController();
        const abortFromExternal = () => startupAbort.abort();
        options.signal?.addEventListener('abort', abortFromExternal, { once: true });
        this.externalAbortCleanup = () => options.signal?.removeEventListener('abort', abortFromExternal);
        if (options.signal?.aborted)
            startupAbort.abort();
        const signal = startupAbort.signal;

        try {
            const client = await this.dependencies.connect({
                host: options.connection.host,
                port: options.connection.port,
                username: options.connection.username,
                password: options.connection.password,
            }, signal);
            if (this.generation !== generation || signal.aborted) {
                await client.close();
                throw this.generation !== generation ? supersededError() : abortedError();
            }
            this.client = client;
            let intentionalClose = false;

            let sessionBackchannel: PcmaBackchannel | undefined;
            let sessionForwarder: AudioForwarder | undefined;
            // A read-loop/mpegts/close failure aborts a pending forwarder
            // startup as well as tearing down the current session.
            const failSession = (message: string, error: unknown) => {
                if (this.client !== client)
                    return;
                this.client = undefined;
                ++this.generation;
                startupAbort.abort();
                if (this.startupAbort === startupAbort)
                    this.startupAbort = undefined;
                this.externalAbortCleanup?.();
                this.externalAbortCleanup = undefined;
                if (sessionBackchannel === this.backchannel)
                    this.backchannel = undefined;
                if (sessionForwarder === this.forwarder)
                    this.forwarder = undefined;
                this.console.error(message, describeVigiError(error));
                sessionBackchannel?.stop();
                sessionForwarder?.kill();
                this.trackClosing(async () => {
                    await client.close();
                });
            };
            client.processMessages().catch(e => failSession('VIGI message processing stopped:', e));
            client.stream.once('close', () => {
                if (intentionalClose)
                    return;
                failSession('TP-Link talk connection closed:', new VigiError('VIGI stream closed.', 'transport'));
            });
            if (client.stream.destroyed)
                throw new VigiError('TP-Link talk connection closed during startup.', 'transport');

            const mode = normalizeTalkMode(options.mode);
            const channel = normalizeChannel(options.channel);
            const mpegts = await client.startMpegTsBackchannel(mode, channel);
            if (this.generation !== generation || signal.aborted) {
                intentionalClose = true;
                mpegts.destroy();
                await client.close();
                throw this.generation !== generation ? supersededError() : abortedError();
            }

            const audioSendMode = normalizeAudioSendMode(options.audioSendMode);
            const backchannel = sessionBackchannel = this.backchannel = new PcmaBackchannel(mpegts, {
                mode: audioSendMode,
                onStatistics: this.dependencies.onStatistics,
            });
            let forwarder!: AudioForwarder;
            mpegts.on('error', e => failSession('TP-Link audio stream stopped:', e));

            const startedForwarder = await this.dependencies.startForwarder(
                this.console,
                options.ffmpegInput,
                rtp => backchannel.pushRtp(rtp),
                {
                    getFFmpegPath: this.dependencies.getFFmpegPath,
                    signal,
                },
            );
            if (this.generation !== generation || signal.aborted) {
                intentionalClose = true;
                startedForwarder.kill();
                throw this.generation !== generation ? supersededError() : abortedError();
            }
            forwarder = sessionForwarder = this.forwarder = startedForwarder;

            forwarder.killPromise.finally(async () => {
                if (this.client !== client)
                    return;
                // Our own graceful close is not a camera failure, and a new
                // start must wait for this close before reconnecting.
                await this.trackClosing(async () => {
                    intentionalClose = true;
                    this.client = undefined;
                    if (this.backchannel === backchannel)
                        this.backchannel = undefined;
                    if (this.forwarder === forwarder)
                        this.forwarder = undefined;
                    try {
                        await backchannel.stop(true);
                    }
                    catch (e) {
                        this.console.error('TP-Link tail flush failed:', describeVigiError(e));
                    }
                    try {
                        await client.close(true);
                    }
                    catch (e) {
                        this.console.error('TP-Link talk close failed:', describeVigiError(e));
                    }
                });
            }).catch(e => this.console.error('TP-Link forwarder cleanup failed:', describeVigiError(e)));

            if (client.stream.destroyed)
                throw new VigiError('TP-Link talk connection closed during startup.', 'transport');

            // The startup linked signal has done its job. The active session
            // is stopped through stop()/close(), not by keeping this listener.
            if (this.startupAbort === startupAbort)
                this.startupAbort = undefined;
            this.externalAbortCleanup?.();
            this.externalAbortCleanup = undefined;
        }
        catch (e) {
            if (this.generation === generation)
                await this.stopInternal();
            throw e instanceof VigiError
                ? e
                : new VigiError(e instanceof Error ? e.message : String(e), 'transport', { retryable: false });
        }
    }

    async stop(): Promise<void> {
        ++this.generation;
        await this.stopInternal();
    }

    private async stopInternal(): Promise<void> {
        // A forwarder exit closes the old socket asynchronously; wait for
        // that shutdown so a new start cannot overlap the camera session.
        if (this.closing)
            await this.closing;

        // Abort any pending connect/talk/forwarder startup and unlink the
        // external signal before capturing the current session.
        const startupAbort = this.startupAbort;
        this.startupAbort = undefined;
        startupAbort?.abort();
        this.externalAbortCleanup?.();
        this.externalAbortCleanup = undefined;

        // Capture everything before the first await so a concurrent start
        // cannot replace a field that this stop then tears down.
        const client = this.client;
        this.client = undefined;
        const backchannel = this.backchannel;
        this.backchannel = undefined;
        const forwarder = this.forwarder;
        this.forwarder = undefined;

        // Stop capturing immediately; only the already-buffered tail is
        // allowed to play while the backchannel winds down.
        forwarder?.kill();
        try {
            await backchannel?.stop(true);
        }
        catch (e) {
            this.console.error('TP-Link tail flush failed:', describeVigiError(e));
        }

        if (forwarder)
            await waitForExit(forwarder.killPromise, 1500);

        try {
            await client?.close(true);
        }
        catch (e) {
            this.console.error('TP-Link talk close failed:', describeVigiError(e));
        }
    }
}
