# Contributing

This project adds TP-Link VIGI two-way audio to cameras that are already in Scrypted through ONVIF or RTSP.

## Scope

Good contributions are usually in one of these areas:

- VIGI talkback compatibility fixes.
- Scrypted mixin behavior.
- Setup, troubleshooting, and HomeKit documentation.
- Tests for VIGI authentication, streaming, or audio forwarding behavior.

Please open an issue before adding new camera features or new Scrypted interfaces. This keeps the plugin focused and avoids shipping untested camera API behavior.

## Local Setup

```sh
npm ci
npm run tsc
npm test
```

For live testing, install the plugin in Scrypted, add the camera through ONVIF or RTSP first, then enable the `TP-Link Talk` mixin on that camera.

## Bug Reports

Include:

- Camera model and firmware version.
- Scrypted version and install method.
- Plugin version.
- Whether the camera was added through ONVIF or RTSP.
- Whether the account used for the camera is the local `admin` account.
- Relevant Scrypted plugin logs with passwords and tokens removed.

## Pull Requests

Before opening a pull request:

- Keep changes scoped to one problem.
- Do not change `package.json` version unless the pull request is specifically for a release.
- Do not commit build output, `node_modules`, logs, or `.tgz` files.
- Run `npm run tsc` and `npm test`.

If a change depends on behavior from a specific camera model or firmware, include that detail in the pull request.
