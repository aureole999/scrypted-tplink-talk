export type VigiErrorKind =
    | 'transport'
    | 'protocol'
    | 'camera'
    | 'config'
    | 'auth';

export interface VigiErrorDetails {
    code?: number;
    status?: number;
    /** False when a response was already received; retrying could duplicate an action. */
    retryable?: boolean;
    /** True when the request body may have reached the camera. */
    sent?: boolean;
}

export class VigiError extends Error {
    readonly kind: VigiErrorKind;
    readonly code?: number;
    readonly status?: number;
    readonly retryable?: boolean;
    readonly sent?: boolean;

    constructor(message: string, kind: VigiErrorKind, details: VigiErrorDetails = {}) {
        super(message);
        this.name = 'VigiError';
        this.kind = kind;
        this.code = details.code;
        this.status = details.status;
        this.retryable = details.retryable;
        this.sent = details.sent;
    }

    get authLike(): boolean {
        // Only -40401 is confirmed as an auth/session code. -40211 and -52202
        // are unconfirmed guesses for session expiry, but no hardware report
        // has established them yet. Treating an unconfirmed code as auth would
        // trigger extra logins and could contribute to an account lockout, so
        // unknown codes are surfaced as ordinary camera errors instead.
        return this.kind === 'auth'
            || this.status === 401
            || this.status === 403
            || (this.kind === 'camera' && this.code === -40401);
    }
}

export function isVigiError(error: unknown): error is VigiError {
    return error instanceof VigiError;
}

const cameraErrorMessages: Record<number, string> = {
    [-52411]: 'The camera talk channel is already in use. End the other talk session and try again.',
    [-40401]: 'The camera rejected the login or session. Check the admin password.',
};

export function describeVigiError(error: unknown): string {
    if (isVigiError(error)) {
        if (error.kind === 'camera' && error.code !== undefined) {
            const known = cameraErrorMessages[error.code];
            if (known)
                return `${known} (${error.code})`;
        }
        return error.message;
    }

    if (error instanceof Error)
        return error.message;

    return String(error);
}
