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

- Reassemble PCMA RTP into 1024-sample audio frames at 8 kHz, and send at 128 ms intervals instead of forwarding arbitrary RTP payload sizes immediately.
- Preserve MPEG-TS continuity counters across PES boundaries; use the 90 kHz PTS clock, MPEG-2 PSI CRC, and valid stuffing.
- Use TCP_NODELAY, write each multipart message together, and propagate socket backpressure. Bound queued live audio to about one second; discard old whole frames if the connection stalls.
- Offer `aec` (default) and `half_duplex` in the camera's **Talk Mode** setting. Stop and restart talkback after changing the mode.

The framing and pacing are based on direct speaker tests with a TP-Link TL-IPC43AN-WB4 V1.0, firmware 1.0.6 Build 200818 Rel.67021n. Both modes were audible and clear with the test sender. End-to-end HomeKit behavior still needs confirmation after installing this fork.

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

Auto-detection looks for common camera settings such as `ip`, `host`, `address`, `url`, `rtspUrl`, `username`, and `password`. Different Scrypted camera plugins expose different setting names, so manual overrides are available when detection cannot find everything.

## Manual Settings

Fill in the mixin settings only when auto-detection is missing something or the existing camera uses a different account.

| Setting | When to use it |
| --- | --- |
| `Host` | The camera IP was not detected, or the detected host is wrong. |
| `Username` | The existing ONVIF/RTSP camera was added with a non-admin user. Set this to `admin`. |
| `Admin Password` | The existing ONVIF/RTSP camera password is missing, wrong, or belongs to a non-admin user. |
| `Port` | The VIGI stream service is not reachable on `8800`. |
| `Talk Mode` | Choose `aec` for echo cancellation or `half_duplex` for one-way-at-a-time talkback. Default: `aec`. |
| `Channel` | Multi-channel devices only. Most standalone cameras should stay on `0`. |

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

### Camera returns `-52411`

The camera reports that its talk channel is already in use. End other talk sessions in Apple Home, the TP-Link app, or another Scrypted mixin, then try again. Do not run both the original VIGI mixin and TP-Link Talk on the same camera at once.

### HomeKit pairing fails

HomeKit pairing, mDNS, and bridge issues are handled by Scrypted's HomeKit plugin. First confirm the VIGI mixin is enabled on the camera and its settings are correct, then troubleshoot HomeKit separately.
