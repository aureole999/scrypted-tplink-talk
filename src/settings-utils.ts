import { isIPv6 } from 'net';
import type { AudioSendingStatistics } from './pcma-backchannel';
import { VigiError } from './vigi-error';

export interface CameraSettingLike {
    key?: string;
    value?: unknown;
}

export interface DetectedConnectionSettings {
    host?: string;
    username?: string;
    password?: string;
}

export interface ConnectionOverrides {
    host?: unknown;
    username?: unknown;
    password?: unknown;
    port?: unknown;
}

export interface ResolvedConnectionSettings {
    host: string;
    username: string;
    password: string;
    port: number;
}

function stringValue(value: unknown): string | undefined {
    if (value === undefined || value === null)
        return;
    const text = value.toString().trim();
    // Scrypted can expose a masked password placeholder for the mixed camera.
    return text && text !== '********' ? text : undefined;
}

function passwordValue(value: unknown): string | undefined {
    if (value === undefined || value === null)
        return;
    // Passwords are opaque: leading/trailing spaces may be intentional, so
    // preserve them. Only ignore whitespace-only values and the Scrypted mask
    // (including the mask with surrounding whitespace).
    const text = value.toString();
    return text.trim() && text.trim() !== '********' ? text : undefined;
}

function validPort(value: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function splitHostPort(value: string): { host: string; port?: number } {
    const trimmed = value.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const host = url.hostname.replace(/^\[|\]$/g, '');
            const parsedPort = url.port ? Number(url.port) : undefined;
            return { host, port: parsedPort !== undefined && validPort(parsedPort) ? parsedPort : undefined };
        }
        catch {
            // Fall through to raw parsing.
        }
    }
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']');
        if (end > 0) {
            const host = trimmed.substring(1, end);
            const portText = trimmed.substring(end + 1);
            if (portText.startsWith(':')) {
                const parsedPort = Number(portText.substring(1));
                if (validPort(parsedPort))
                    return { host, port: parsedPort };
            }
            return { host };
        }
    }

    const first = trimmed.indexOf(':');
    if (first > 0 && first === trimmed.lastIndexOf(':')) {
        const parsedPort = Number(trimmed.substring(first + 1));
        const host = trimmed.substring(0, first);
        if (validPort(parsedPort))
            return { host, port: parsedPort };
        return { host };
    }

    return { host: trimmed };
}

export function withTimeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    message = 'Timed out reading the mixed camera settings.',
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            action();
        };
        const onAbort = () => finish(() => reject(new VigiError('VIGI connection aborted.', 'config', { retryable: false })));
        const timer = setTimeout(() => finish(() => reject(new VigiError(message, 'config'))), milliseconds);
        timer.unref?.();
        // Observe late rejections even when timeout/abort wins the race.
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}

function decode(value: string): string {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}

function parseMediaUrl(value?: string): { host: string; protocol: string; username?: string; password?: string } | undefined {
    if (!value)
        return;

    try {
        const url = new URL(value);
        // URL.hostname keeps brackets around IPv6 literals; net.connect wants
        // the address without them.
        const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
            ? url.hostname.slice(1, -1)
            : url.hostname;
        if (!host)
            return;
        return {
            host,
            protocol: url.protocol,
            username: url.username ? decode(url.username) : undefined,
            password: url.password ? decode(url.password) : undefined,
        };
    }
    catch {
        return;
    }
}

export function getHostFromUrl(value?: string): string | undefined {
    return parseMediaUrl(value)?.host;
}

function normalizeHost(value: string): string {
    if (isIPv6(value)) {
        try {
            // URL parsing canonicalizes IPv6 locally; it does not resolve DNS.
            return new URL(`http://[${value}]/`).hostname;
        }
        catch {
            // Scoped IPv6 literals may be valid for net but not for URL.
        }
    }
    return value.toLowerCase().replace(/\.$/, '');
}

export function detectConnectionSettings(cameraSettings: CameraSettingLike[]): DetectedConnectionSettings {
    const getValue = (...keys: string[]) => {
        for (const key of keys) {
            const value = stringValue(cameraSettings.find(setting => setting.key === key)?.value);
            if (value)
                return value;
        }
    };

    // Try every URL candidate: an unrelated or malformed `url` must not mask
    // a valid `rtspUrl`.
    const urls = cameraSettings.find(setting => setting.key === 'urls')?.value;
    const candidates = [
        stringValue(cameraSettings.find(setting => setting.key === 'url')?.value),
        stringValue(cameraSettings.find(setting => setting.key === 'rtspUrl')?.value),
        stringValue(cameraSettings.find(setting => setting.key === 'rtspUrlOverride')?.value),
        ...(Array.isArray(urls) ? urls.map(stringValue) : [stringValue(urls)]),
    ];
    const parsedUrls = candidates.map(parseMediaUrl).filter((value): value is NonNullable<typeof value> => !!value);
    const explicitHost = getValue('ip', 'host', 'address', 'ipAddress', 'hostname');
    // Prefer the video camera over a snapshot/proxy URL. An explicit parent
    // address is authoritative; otherwise conflicting video endpoints cannot
    // safely be paired with unscoped parent username/password settings.
    const streams = parsedUrls.filter(url => url.protocol === 'rtsp:' || url.protocol === 'rtsps:');
    const endpoints = streams.length ? streams : parsedUrls;
    const host = explicitHost ? splitHostPort(explicitHost).host : endpoints[0]?.host;
    const normalizedHost = host ? normalizeHost(host) : undefined;
    const parentCredentialsScoped = !!explicitHost
        || (!!normalizedHost && endpoints.every(url => normalizeHost(url.host) === normalizedHost));
    const explicitUsername = parentCredentialsScoped ? getValue('username', 'userName') : undefined;
    const explicitPassword = parentCredentialsScoped
        ? passwordValue(cameraSettings.find(setting => setting.key === 'password')?.value)
            ?? passwordValue(cameraSettings.find(setting => setting.key === 'adminPassword')?.value)
        : undefined;

    // Borrow URL credentials only from the selected host, not a snapshot/proxy
    // host. Equivalent IPv6 spellings must compare equal without DNS lookups.
    let credentials = { username: explicitUsername, password: explicitPassword };
    let selectedPartial = false;
    for (const parsed of parsedUrls) {
        if (!normalizedHost || normalizeHost(parsed.host) !== normalizedHost)
            continue;
        // An explicit account must not inherit another account's URL password.
        if (explicitUsername && parsed.username && parsed.username !== explicitUsername)
            continue;
        const candidate = {
            username: explicitUsername || parsed.username,
            password: explicitPassword || parsed.password,
        };
        if (candidate.username && candidate.password) {
            // Apply explicit fields before testing completeness: a partial URL
            // plus an explicit field can already be the first complete pair.
            credentials = candidate;
            break;
        }
        if (!selectedPartial && (parsed.username || parsed.password)) {
            // Never combine a username from one URL with a password from
            // another; keep the first partial pair as a pair.
            credentials = candidate;
            selectedPartial = true;
        }
    }

    return {
        // A host setting may carry a port (for example 192.168.1.50:8800).
        // The talk port is the separate Port setting, so keep only the host.
        // Unlike the VIGI HTTPS plugins, the talk service listens on its own
        // port; an HTTPS/RTSP port on the mixed camera must not be inherited.
        host,
        username: credentials.username,
        password: credentials.password,
    };
}

export function resolveConnectionSettings(overrides: ConnectionOverrides, detected: DetectedConnectionSettings): ResolvedConnectionSettings {
    const overrideHost = stringValue(overrides.host);
    // An explicit host override may carry the talk port. A port detected from
    // the mixed camera's IP/RTSP settings is not inherited: talk uses its own
    // service port, unlike the VIGI HTTPS API.
    const parsedOverride = overrideHost ? splitHostPort(overrideHost) : undefined;
    const host = parsedOverride?.host ?? detected.host;
    const username = stringValue(overrides.username) || detected.username || 'admin';
    const password = passwordValue(overrides.password) || detected.password;
    let port = 8800;
    const rawPort = overrides.port;
    if (rawPort !== undefined && rawPort !== null && rawPort.toString().trim() !== '') {
        port = Number(rawPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new VigiError('The VIGI talk port must be an integer between 1 and 65535.', 'config');
    }
    port = parsedOverride?.port ?? port;

    if (!host)
        throw new VigiError('VIGI host is not configured and could not be detected from the camera settings.', 'config');
    if (!password)
        throw new VigiError('VIGI admin password is not configured and could not be detected from the camera settings.', 'config');

    return {
        host,
        username,
        password,
        port,
    };
}

export function normalizeChannel(value: unknown): number {
    if (value === undefined || value === null || value === '')
        return 0;
    const channel = Number(value);
    // Channels are 0..256. Reject a typo instead of
    // silently talking on channel 0.
    if (!Number.isInteger(channel) || channel < 0 || channel > 256)
        throw new VigiError(`VIGI channel must be an integer from 0 to 256 (got ${value}).`, 'config');
    return channel;
}

export function getIntercomMixinInterfaces(type: string, interfaces: string[]): string[] | undefined {
    if (type !== 'Doorbell' && type !== 'Camera')
        return;
    if (!interfaces.includes('VideoCamera') || !interfaces.includes('Settings'))
        return;

    return [
        'Intercom',
        'Settings',
    ];
}

export function formatAudioStatistics(statistics: AudioSendingStatistics): string {
    const sizes = (summary: AudioSendingStatistics['rtpReceived']) =>
        summary.payloadSizes.map(size => `${size.bytes}B/${size.audioMilliseconds}ms x${size.count}`).join(', ') || 'none';
    const interval = statistics.pesWritten.intervalMilliseconds?.mean;
    return `TP-Link Talk ended: RTP [${sizes(statistics.rtpReceived)}]; sent [${sizes(statistics.pesWritten)}]` +
        (interval === undefined ? '' : `; mean write interval ${interval}ms`) +
        `; overload drops ${statistics.overloadDroppedSamples} samples.`;
}
