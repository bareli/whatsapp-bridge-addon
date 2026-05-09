# Changelog

## 0.1.1

- Fix s6-overlay `Permission denied` on the service `run` script. The
  executable bit was not preserved in the source tree from a Windows
  development host; Supervisor refused to start the bridge.

## 0.1.0

- Initial release.
- Single WhatsApp account, send text/media, receive incoming as WS events.
- amd64 and aarch64 builds.
