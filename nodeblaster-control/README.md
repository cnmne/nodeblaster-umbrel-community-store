# NodeBlaster Suite

Public Umbrel companion app for licensed NodeBlaster appliance features.

## Boundary

- Runs as UID/GID `1000:1000` without privileged mode, host networking, devices, Docker socket, or host filesystem mounts.
- A one-shot privileged helper verifies signed packages, installs the narrow host bridge, then exits.
- Appliance services remain inactive until a valid local Suite license is activated.
- The bridge uses `/data/host-bridge/bridge.sock` plus a private bearer token and exposes no network listener.
- Missing license or agent states remain visible instead of being presented as successful configuration.

## Local API

- `GET /api/health`
- `GET /api/status`
- `GET /api/license/status`
- `POST /api/license/activate`
- `GET /api/display-config`
- `PUT /api/display-config`
- `GET /api/diagnostics`

Customer activation follows the shared entitlement v2 contract. The app stores only the signed lease returned by the separately installed host agent; raw activation claims are not persisted.
