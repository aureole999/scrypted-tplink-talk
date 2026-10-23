import sdk, { DeviceProvider, FFmpegInput, Intercom, MediaObject, MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { startPcmaRtpForwarder, AudioForwarder } from './audio-forwarder';
import { AudioSendMode, audioSendModes, PcmaBackchannel } from './pcma-backchannel';
import { VigiApi, TalkMode } from './vigi-api';

class TpLinkTalkMixin extends SettingsMixinDeviceBase<VideoCamera & Settings> implements Intercom {
    private client?: Promise<VigiApi>;
    private forwarder?: AudioForwarder;
    private backchannel?: PcmaBackchannel;

    storageSettings = new StorageSettings(this, {
        host: {
            title: 'Host',
            placeholder: 'Use camera IP',
            description: 'Optional override. Leave empty to use the mixed camera IP, host, address, or RTSP URL host.',
        },
        username: {
            title: 'Username',
            placeholder: 'Use camera username',
            description: 'Optional override. VIGI two-way audio currently requires this to resolve to admin.',
        },
        password: {
            title: 'Admin Password',
            type: 'password',
            placeholder: 'Use camera password',
            description: 'Optional override. Leave empty to use the mixed camera password.',
        },
        port: {
            title: 'Port',
            type: 'number',
            defaultValue: 8800,
            description: 'The VIGI stream service port.',
        },
        talkMode: {
            title: 'Talk Mode',
            choices: ['aec', 'half_duplex'],
            defaultValue: 'aec',
            description: 'aec enables acoustic echo cancellation. Use half_duplex for one-way-at-a-time talkback.',
        },
        audioSendMode: {
            title: 'Audio Sending',
            choices: [audioSendModes.paced, audioSendModes.vigi],
            defaultValue: audioSendModes.paced,
            description: 'Use paced 1024-sample frames, or original VIGI RTP frame sizes and immediate sending. Independent of Talk Mode. Restart talkback after changing.',
        },
        channel: {
            title: 'Channel',
            type: 'number',
            defaultValue: 0,
            description: 'Camera channel. Most standalone VIGI cameras use 0.',
        },
    });

    async startIntercom(media: MediaObject): Promise<void> {
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
        await this.stopIntercom();

        const { host, username, password, port } = await this.getConnectionSettings();
        if (username !== 'admin')
            throw new Error('VIGI two-way audio currently requires the admin account.');

        this.client = VigiApi.connect({
            host,
            port,
            username,
            password,
        });

        const client = await this.client;
        client.processMessages().catch(e => this.console.error('VIGI message processing stopped:', e));
        try {
            const mode = this.storageSettings.values.talkMode as TalkMode;
            const mpegts = await client.startMpegTsBackchannel(mode);
            const backchannel = this.backchannel = new PcmaBackchannel(mpegts, {
                mode: this.storageSettings.values.audioSendMode as AudioSendMode,
                onStatistics: statistics => this.console.log('TP-Link Talk audio stats:', JSON.stringify(statistics)),
            });
            mpegts.on('error', e => {
                this.console.error('TP-Link audio stream stopped:', e);
                backchannel.stop();
                client.close();
            });
            const forwarder = this.forwarder = await startPcmaRtpForwarder(this.console, ffmpegInput,
                rtp => backchannel.pushRtp(rtp));
            forwarder.killPromise.finally(() => {
                backchannel.stop();
                client.close();
            });
            client.stream.once('close', () => {
                backchannel.stop();
                forwarder.kill();
            });
            if (client.stream.destroyed)
                throw new Error('TP-Link talk connection closed during startup.');
        }
        catch (e) {
            await this.stopIntercom();
            throw e;
        }
    }

    async stopIntercom(): Promise<void> {
        this.backchannel?.stop();
        this.backchannel = undefined;
        const forwarder = this.forwarder;
        this.forwarder = undefined;
        forwarder?.kill();

        const clientPromise = this.client;
        this.client = undefined;
        const client = await clientPromise?.catch(() => undefined);
        client?.close();
    }

    async getMixinSettings(): Promise<Setting[]> {
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

    putMixinSetting(key: string, value: SettingValue): Promise<boolean | void> {
        return this.storageSettings.putSetting(key, value);
    }

    private async getConnectionSettings() {
        const detected = await this.getDetectedConnectionSettings();

        const host = this.storageSettings.values.host?.toString() || detected.host;
        const username = this.storageSettings.values.username?.toString() || detected.username || 'admin';
        const password = this.storageSettings.values.password?.toString() || detected.password;
        const portValue = this.storageSettings.values.port;
        const port = typeof portValue === 'number' ? portValue : parseInt(portValue?.toString() || '8800', 10);

        if (!host)
            throw new Error('VIGI host is not configured and could not be detected from the camera settings.');
        if (!password)
            throw new Error('VIGI admin password is not configured and could not be detected from the camera settings.');

        return {
            host,
            username,
            password,
            port: Number.isFinite(port) ? port : 8800,
        };
    }

    private async getDetectedConnectionSettings() {
        const cameraSettings = await this.mixinDevice.getSettings();
        const getValue = (...keys: string[]) => {
            for (const key of keys) {
                const value = cameraSettings.find(s => s.key === key)?.value?.toString();
                if (value)
                    return value;
            }
        };

        const rtspUrl = getValue('url', 'rtspUrl', 'rtspUrlOverride')
            || (cameraSettings.find(s => s.key === 'urls')?.value as string[] | undefined)?.find(url => !!url);

        return {
            host: getValue('ip', 'host', 'address') || getHostFromUrl(rtspUrl),
            username: getValue('username'),
            password: getValue('password'),
        };
    }
}

function getHostFromUrl(value?: string): string | undefined {
    if (!value)
        return;

    try {
        return new URL(value).hostname;
    }
    catch {
        return;
    }
}

class TpLinkTalkProvider extends ScryptedDeviceBase implements MixinProvider {
    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | undefined> {
        if (type !== ScryptedDeviceType.Doorbell && type !== ScryptedDeviceType.Camera)
            return;
        if (!interfaces.includes(ScryptedInterface.VideoCamera) || !interfaces.includes(ScryptedInterface.Settings))
            return;

        return [
            ScryptedInterface.Intercom,
            ScryptedInterface.Settings,
        ];
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
        await (mixinDevice as TpLinkTalkMixin).stopIntercom();
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
