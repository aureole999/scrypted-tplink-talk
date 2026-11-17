import sdk, { DeviceProvider, FFmpegInput, Intercom, MediaObject, MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { startPcmaRtpForwarder } from './audio-forwarder';
import { audioSendModes, normalizeAudioSendMode } from './pcma-backchannel';
import { detectConnectionSettings, formatAudioStatistics, getIntercomMixinInterfaces, normalizeChannel, resolveConnectionSettings, withTimeout } from './settings-utils';
import { TalkSession } from './talk-session';
import { VigiApi, normalizeTalkMode } from './vigi-api';
import { VigiError } from './vigi-error';

class TpLinkTalkMixin extends SettingsMixinDeviceBase<VideoCamera & Settings> implements Intercom {
    private operation = Promise.resolve();
    private connectAborts = new Set<AbortController>();
    private disposed = false;
    private session = new TalkSession(this.console, {
        connect: VigiApi.connect,
        startForwarder: startPcmaRtpForwarder,
        getFFmpegPath: () => sdk.mediaManager.getFFmpegPath(),
        onStatistics: statistics => this.console.log(formatAudioStatistics(statistics)),
    });

    storageSettings = new StorageSettings(this, {
        host: {
            subgroup: 'Connection',
            title: 'Host',
            placeholder: 'Use camera IP',
            description: 'Optional override. Leave empty to use the mixed camera IP, host, address, or RTSP URL host.',
        },
        username: {
            subgroup: 'Connection',
            title: 'Username',
            placeholder: 'Use camera username',
            description: 'Optional override. VIGI two-way audio currently requires this to resolve to admin.',
        },
        password: {
            subgroup: 'Connection',
            title: 'Admin Password',
            type: 'password',
            placeholder: 'Use camera password',
            description: 'Optional override. Leave empty to use the mixed camera password.',
        },
        port: {
            subgroup: 'Connection',
            title: 'Port',
            type: 'number',
            defaultValue: 8800,
            range: [1, 65535],
            description: 'The VIGI stream service port.',
        },
        talkMode: {
            subgroup: 'Talkback',
            title: 'Talk Mode',
            choices: ['aec', 'half_duplex'],
            defaultValue: 'aec',
            description: 'aec enables acoustic echo cancellation. Use half_duplex for one-way-at-a-time talkback.',
        },
        audioSendMode: {
            subgroup: 'Talkback',
            title: 'Audio Sending',
            choices: [audioSendModes.paced64, audioSendModes.paced],
            defaultValue: audioSendModes.paced64,
            mapGet: normalizeAudioSendMode,
            mapPut: (_oldValue, value) => normalizeAudioSendMode(value),
            description: 'Choose paced 512-sample (64 ms, default) or 1024-sample (128 ms) frames. Independent of Talk Mode. Restart talkback after changing.',
        },
        channel: {
            subgroup: 'Connection',
            title: 'Channel',
            type: 'number',
            defaultValue: 0,
            range: [0, 256],
            description: 'Camera channel. Most standalone VIGI cameras use 0.',
        },
    });

    startIntercom(media: MediaObject): Promise<void> {
        if (this.disposed)
            return Promise.reject(new VigiError('The TP-Link Talk mixin has been released.', 'config'));
        // Scrypted/HomeKit can issue start and stop close together. Serialize
        // them so an older client or forwarder is never left running. The
        // abort controller lets a queued stop cancel a connect that is still
        // waiting for a silent camera.
        const controller = new AbortController();
        this.connectAborts.add(controller);
        const result = this.serialize(() => this.startIntercomInternal(media, controller.signal));
        result.finally(() => this.connectAborts.delete(controller)).catch(() => undefined);
        return result;
    }

    private serialize<T>(action: () => Promise<T>): Promise<T> {
        const result = this.operation.then(action, action);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }

    private async startIntercomInternal(media: MediaObject, signal: AbortSignal): Promise<void> {
        if (signal.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        // Release the old microphone/session before any potentially slow SDK
        // work. Cancelled queued starts must not invoke that work at all.
        await this.session.stop();
        if (signal.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        let ffmpegInput: FFmpegInput;
        try {
            // The SDK conversion itself cannot be cancelled, but stop must
            // not wait for it. Ignore its eventual result after abort.
            ffmpegInput = await withTimeout(
                sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput),
                10_000,
                'Timed out converting the Scrypted intercom media to an FFmpeg input.',
                signal,
            );
        }
        catch (e) {
            throw new VigiError(
                'Could not convert the Scrypted intercom media to an FFmpeg input: '
                + (e instanceof Error ? e.message : String(e)),
                'config',
            );
        }
        if (signal.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        const connection = await this.getConnectionSettings(signal);
        if (signal.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        if (connection.username !== 'admin')
            throw new VigiError('VIGI two-way audio currently requires the admin account.', 'config');

        const mode = normalizeTalkMode(this.storageSettings.values.talkMode);
        const audioSendMode = normalizeAudioSendMode(this.storageSettings.values.audioSendMode);
        const channel = normalizeChannel(this.storageSettings.values.channel);
        await this.session.start({
            ffmpegInput,
            connection,
            mode,
            audioSendMode,
            channel,
            signal,
        });
        this.console.log(`TP-Link Talk started: ${mode}, ${audioSendMode}.`);
    }

    stopIntercom(): Promise<void> {
        // Cancel a connect/talk request that is still waiting on the camera
        // before waiting for the serialized cleanup.
        for (const controller of this.connectAborts)
            controller.abort();
        this.connectAborts.clear();
        return this.serialize(() => this.session.stop());
    }

    async dispose(): Promise<void> {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const controller of this.connectAborts)
            controller.abort();
        this.connectAborts.clear();
        await this.serialize(() => this.session.stop());
    }

    async getMixinSettings(): Promise<Setting[]> {
        if (this.disposed)
            return [];
        const [settings, detected] = await Promise.all([
            this.storageSettings.getSettings(),
            this.getDetectedConnectionSettings().catch(() => undefined),
        ]);

        for (const setting of settings) {
            if (setting.key === 'host' && detected?.host) {
                setting.placeholder = detected.host;
                setting.description = `Optional override. Currently detected from the mixed camera as ${detected.host}.`;
            }
            else if (setting.key === 'username' && detected?.username) {
                setting.placeholder = detected.username;
                setting.description = `Optional override. Currently detected from the mixed camera as ${detected.username}. VIGI talkback requires admin.`;
            }
            else if (setting.key === 'password' && detected?.password) {
                setting.placeholder = 'Using mixed camera password';
                setting.description = 'Optional override. A password was detected from the mixed camera settings.';
            }
        }

        return settings;
    }

    async putMixinSetting(key: string, value: SettingValue): Promise<boolean | void> {
        if (this.disposed)
            return false;
        const result = await this.storageSettings.putSetting(key, value);
        // A connection change must not leave an active talk session on the
        // previous camera/port. The next start resolves the new settings.
        if (['host', 'username', 'password', 'port', 'channel'].includes(key))
            await this.stopIntercom();
        return result;
    }

    private async getConnectionSettings(signal?: AbortSignal) {
        const detected = await this.getDetectedConnectionSettings(signal);

        return resolveConnectionSettings({
            host: this.storageSettings.values.host,
            username: this.storageSettings.values.username,
            password: this.storageSettings.values.password,
            port: this.storageSettings.values.port,
        }, detected);
    }

    private async getDetectedConnectionSettings(signal?: AbortSignal) {
        // A parent camera plugin must not hang or break the talk mixin
        // startup/UI. Explicit connection overrides still work if detection
        // fails.
        try {
            return detectConnectionSettings(await withTimeout(this.mixinDevice.getSettings(), 5000, undefined, signal));
        }
        catch {
            return {};
        }
    }
}

class TpLinkTalkProvider extends ScryptedDeviceBase implements MixinProvider {
    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | undefined> {
        return getIntercomMixinInterfaces(type, interfaces);
    }

    async getMixin(mixinDevice: VideoCamera & Settings, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new TpLinkTalkMixin({
            mixinProviderNativeId: this.nativeId,
            group: 'TP-Link Talk',
            groupKey: 'tplink-talk',
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
        });
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await (mixinDevice as TpLinkTalkMixin).dispose();
    }
}

class TpLinkTalkPlugin extends ScryptedDeviceBase implements DeviceProvider {
    constructor(nativeId?: string) {
        super(nativeId);

        process.nextTick(() => {
            sdk.deviceManager.onDeviceDiscovered({
                nativeId: 'intercom',
                type: ScryptedDeviceType.Builtin,
                interfaces: [
                    ScryptedInterface.MixinProvider,
                ],
                name: 'TP-Link Talk',
            });
        });
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId === 'intercom')
            return new TpLinkTalkProvider('intercom');
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }
}

export default TpLinkTalkPlugin;
