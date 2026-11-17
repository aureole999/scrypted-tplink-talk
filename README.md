# TP-Link Talk for Scrypted

Adds TP-Link VIGI two-way audio, also called talkback or intercom, to VIGI cameras that are already in Scrypted.

This plugin does not discover cameras, import cameras, or provide video streaming. Use Scrypted's ONVIF or RTSP plugin for video first. After the camera is working in Scrypted, enable this plugin as a mixin on that camera to add the `Intercom` interface.

There is no `Add Camera` button in this plugin. That is expected. The camera comes from ONVIF or RTSP; this plugin only adds the talk button.

## Requirements

- A TP-Link VIGI camera already added to Scrypted through ONVIF or RTSP.
- Working local video in Scrypted before this plugin is enabled.
- The camera's local `admin` account credentials.
- Local network access from Scrypted to the camera's VIGI stream service, normally port `8800`.

VIGI talkback is currently known to require the camera's `admin` account. A non-admin ONVIF or RTSP account may work for video, but it will usually not work for two-way audio.

## Installation

This fork uses the distinct package name `@aureole999/scrypted-tplink-talk` and display name **TP-Link Talk**. It is not currently published to npm. Searching for the original `@metalbiker/scrypted-vigi` installs the upstream plugin, without these fixes.

Build and deploy this fork using Scrypted's development tools:

```sh
git clone https://github.com/aureole999/scrypted-tplink-talk.git
cd scrypted-tplink-talk
npm ci
npm run build
npx scrypted login SCRYPTED_HOST:10443
npm run scrypted-deploy -- SCRYPTED_HOST:10443
```

Replace `SCRYPTED_HOST:10443` with your Scrypted server address. Deployment requires a Scrypted login. This installs a separate plugin; on the camera, disable the original VIGI mixin before enabling **TP-Link Talk** so only one plugin owns talkback. Video remains provided by the existing ONVIF/RTSP camera.

## Audio fixes in this fork

- Reassemble PCMA RTP into 512-sample audio frames at 8 kHz and send at 64 ms intervals by default. A 1024-sample / 128 ms option is also available and was used with the TP-Link VIGI C540-W 2.0 IPC, firmware 2.2.3 Build 260624 Rel.34757n, and the TP-Link VIGI C340-W 2.20 IPC, firmware 2.2.3 Build 260616 Rel.12538n. The 512/64 default is the lower-latency option and is the mode with the most direct speaker testing on the TL-IPC43AN-WB4.
- Keep an absolute send schedule rather than resetting the deadline after every write. This prevents a long talkback call from accumulating hundreds of milliseconds of delay and then dropping frames. If the event loop stalls, missed slots are skipped instead of sending a catch-up burst of queued audio.
- Preserve MPEG-TS continuity counters across PES boundaries; use the 90 kHz PTS clock, MPEG-2 PSI CRC, and valid stuffing.
- Use TCP_NODELAY, write each multipart message together, and propagate socket backpressure. Bound queued live audio to about one second; discard old whole frames if the connection stalls. The backchannel `Writable` in front of the socket has an explicit 2 KiB high-water mark so Node's default multi-second buffer cannot add stale audio behind the application queue.
- Stop microphone capture immediately, then pace the newest 64/128 ms of buffered audio and three silence frames when talkback stops. Allow the last frame to play plus a bounded 500 ms grace period before closing, so releasing the talk button does not clip the last syllable.
- Include the configured `Channel` in the talk request, so the mixin can target NVR/multi-channel talkback instead of always using channel 0. The channel range (`0` to `256`) is enforced; channel `0` is omitted from the request.
- Authenticate the Digest challenge and the authenticated request on the **same TCP connection**. Some camera firmwares bind the nonce to the connection.
- Fail a talk request with a clear timeout if the camera does not answer, instead of leaving the intercom hanging.
- Serialize `startIntercom`/`stopIntercom`, await the old socket close, and terminate the old ffmpeg process (SIGTERM, then SIGKILL) so closely spaced HomeKit calls cannot overlap talk sessions.
- Cancel pending media conversion, settings lookup, and encoder startup waits on stop; cancelled queued starts do not call the media manager. Encoder spawn failures reject startup rather than reporting a successful talk session.
- Offer **Audio Sending** choices: `512 samples / 64 ms` (default) or `1024 samples / 128 ms`. The former immediate-send option has been removed; legacy immediate settings now use paced 64 ms. Existing explicit 128 ms selections are preserved.
- Offer `aec` (default) and `half_duplex` in the camera's **Talk Mode** setting. Stop and restart talkback after changing the mode.

The framing and pacing defaults are based on direct speaker tests with a TP-Link TL-IPC43AN-WB4 V1.0, firmware 1.0.6 Build 200818 Rel.67021n. Both AEC and half-duplex were audible and clear with the test sender. The owner confirmed normal HomeKit talkback using paced 128 ms; direct script tests also produced recognizable speech at 64 ms. Sending 20 ms PES frames produced unintelligible, intermittent sound with TCP_NODELAY both enabled and disabled on this device. These observations do not establish the camera's internal failure mechanism.

The multipart upload headers (`X-If-Encrypt: 0`, `X-Session-Id`, `Content-Length`) and the tail-flush behaviour come from the working fork; `X-If-Encrypt: 0` is a fork interpretation. The 512/64 mode has not been speaker-tested on either VIGI model.

### Validation

`npm test` runs the unit, wire-format and mock-camera integration tests without a camera. They cover:

- `securityEncode` vectors for the 8800 Digest password.
- Digest parsing/response vectors, `qop=auth`, `qop` lists, missing `opaque`, and MD5-only validation.
- Same-connection Digest challenge/authentication (including nonce-to-connection binding), one retry after a rejected nonce, handshake/talk timeouts, and pending-request rejection on timeout/close.
- The exact talk JSON (`mode`, optional `channel`, `seq`, `type`), `-52411` busy/release handling, and other camera errors.
- One-buffer `audio/mp2t` parts with `X-If-Encrypt: 0`, `X-Session-Id`, `Content-Length` and the trailing CRLF.
- Expected PAT/PMT bytes, plus PES structure, MPEG-2 CRC, 90 kHz PTS (including wrap), per-PID continuity counters, PSI/adaptation stuffing, and stream-type `0x90`.
- PCMA frame reassembly at 512/64 and 1024/128, absolute pacing without catch-up bursts, bounded queues, whole-frame overload drops, and 512/1024 tail silence.
- The full API + backchannel path against a mock 8800 camera, including a `200` plus first multipart part in one TCP read, interleaved video/JSON parts, split multipart bodies, bounded JSON and discarded large video parts, and graceful closing delimiters.
- Bounded HTTP/multipart framing: 8 KiB lines, 32 KiB header blocks, 64 headers, and a 64 KiB HTTP challenge-body limit.
- The `TalkSession` lifecycle with an injected fake client/forwarder: start/stop order, abort, connect failure, read-loop/transport teardown, forwarder exit, and stop-during-startup invalidation.
- Typed VIGI errors (`kind`, camera `code`, HTTP status, retryable/sent) and readable log descriptions.
- ffmpeg argument construction (including URL fallback, `ffmpegPath` and `env`) and forwarder lifecycle/socket cleanup, SIGTERM/SIGKILL escalation, and credential redaction.
- Mixin-level cancellation/disposal with stalled SDK calls, real missing-executable failures, paced tail playback, and stderr redaction across every byte boundary. Overlong stderr lines are dropped in full.
- Connection detection with masked passwords, host/IPv6/port parsing, URL credentials, and a timeout around the parent camera's settings.

The talk lifecycle is isolated in `src/talk-session.ts` so it can be tested without the Scrypted SDK; the mixin is thin settings/UI/serialization glue. API failures use typed `VigiError` objects (`kind`, camera `code`, HTTP status, retryable/sent), and JSON/video parts are bounded or streamed away instead of being buffered without limit.

The talk input is expected to be a live Scrypted intercom stream (`inputArguments` or a URL). `pipe:0`/stdin inputs are rejected with a clear error. File inputs are not rejected, but they are not paced (no `-re`): ffmpeg consumes them as fast as it can and the bounded queue drops most of the message. Use a live source for talkback.

The tests do not replace a live speaker test. The camera can only confirm audibility, echo behaviour, and whether 512/64 or 1024/128 sounds better on a specific VIGI model.

This is a fork of [sanskardhanda/scrypted-vigi](https://github.com/sanskardhanda/scrypted-vigi); the original MIT license and attribution are retained.

## Recommended Setup

1. Add the VIGI camera to Scrypted using the ONVIF plugin or RTSP plugin.
2. Use the camera's `admin` username and password when adding it, if possible.
3. Confirm the camera live view works in Scrypted.
4. Open the camera in Scrypted.
5. Open `Extensions` or `Mixins`.
6. Enable `TP-Link Talk`.
7. Open the `TP-Link Talk` settings on that camera.
8. Leave `Host`, `Username`, and `Admin Password` blank if the detected values look correct.
9. Leave `Port` as `8800` unless your camera is behind a custom port mapping.
10. Leave `Channel` as `0` for most standalone VIGI cameras.

Blank settings are intentional. The mixin tries to read the IP address, username, and password from the ONVIF or RTSP camera that it is attached to. If the camera was added with the VIGI `admin` credentials, you usually do not need to enter anything again.

Auto-detection looks for common camera settings such as `ip`, `host`, `address`, `url`, `rtspUrl`, `username`, and `password`. It tries every URL candidate (so a malformed `url` does not mask a valid `rtspUrl`) and extracts `user:password@` credentials when separate settings are missing, but only from URLs matching the selected host. A snapshot/proxy URL cannot borrow another host's camera credentials; set the camera Host explicitly if needed. Different Scrypted camera plugins expose different setting names, so manual overrides are available when detection cannot find everything.

## Manual Settings

Fill in the mixin settings only when auto-detection is missing something or the existing camera uses a different account.

| Setting | When to use it |
| --- | --- |
| `Host` | The camera IP was not detected, or the detected host is wrong. |
| `Username` | The existing ONVIF/RTSP camera was added with a non-admin user. Set this to `admin`. |
| `Admin Password` | The existing ONVIF/RTSP camera password is missing, wrong, or belongs to a non-admin user. |
| `Port` | The VIGI stream service is not reachable on `8800`. |
| `Audio Sending` | Choose `512 samples / 64 ms` (default) or `1024 samples / 128 ms`. Independent of AEC/half-duplex. Stop and restart talkback after changing. |
| `Talk Mode` | Choose `aec` for echo cancellation or `half_duplex` for one-way-at-a-time talkback. Default: `aec`. |
| `Channel` | Multi-channel devices only. Most standalone cameras should stay on `0`; channel 0 is omitted from the talk request, non-zero values are sent. |

## HomeKit

This plugin adds talkback to the Scrypted camera. HomeKit still needs to expose that camera through the Scrypted HomeKit plugin.

If the camera is already in Apple Home before you enable this mixin:

1. Enable `TP-Link Talk` on the Scrypted camera.
2. Restart or reload the camera in Scrypted.
3. Restart or reload the Scrypted HomeKit plugin.
4. Check the camera tile in the Home app for the talk button.

If the Home app still does not show talkback, remove and re-add the HomeKit accessory or bridge that contains the camera. Apple Home can cache accessory capabilities, so newly added Scrypted interfaces are not always picked up on an existing pairing.

## Troubleshooting

### `TP-Link Talk` is not listed under Extensions

The target device must be a Scrypted `Camera` or `Doorbell` and must provide both `VideoCamera` and `Settings`. Add the camera through ONVIF or RTSP first, then reload TP-Link Talk.

### Talkback fails with an admin error

Use the camera's local `admin` account. VIGI talkback is currently expected to fail with non-admin users.

### Talkback fails with a host or password error

Open the mixin settings and manually set `Host`, `Username`, and `Admin Password`. Auto-detection depends on what the ONVIF or RTSP plugin exposes in its settings.

### Video works but talkback does not

Video and talkback use different camera endpoints. Confirm that Scrypted can reach the camera on port `8800` and check the Scrypted plugin logs for the exact VIGI error.

### Inspect actual RTP audio sizes and timing

Open the camera's **Console**. A successful talk session logs one start line and one compact summary after talkback stops, for example:

```text
TP-Link Talk started: aec, 512 samples / 64 ms.
TP-Link Talk ended: RTP [160B/20ms x250]; sent [512B/64ms x78]; mean write interval ~64ms; overload drops 0 samples.
```

The RTP section reports incoming audio payload sizes, audio durations and counts. The sent section reports the reassembled PES audio sizes and counts, plus their average write interval. For 8 kHz mono PCMA, 160 bytes = 20 ms, 512 bytes = 64 ms, 1024 bytes = 128 ms. Overload drops count samples discarded from the bounded queue while the connection was blocked.

These are local receive/write measurements, not measurements of when the speaker played sound. FFmpeg banners, command lines and progress output are suppressed; warnings and errors remain visible. No audio contents are logged, and complete stderr lines are assembled before redacting `user:password@` / token-like values. Lines exceeding 8 KiB are omitted rather than logging potentially sensitive fragments.

### Camera returns `-52411`

The camera reports that its talk channel is already in use. End other talk sessions in Apple Home, the TP-Link app, or another Scrypted mixin, then try again. Do not run both the original VIGI mixin and TP-Link Talk on the same camera at once.

### HomeKit pairing fails

HomeKit pairing, mDNS, and bridge issues are handled by Scrypted's HomeKit plugin. First confirm the VIGI mixin is enabled on the camera and its settings are correct, then troubleshoot HomeKit separately.
