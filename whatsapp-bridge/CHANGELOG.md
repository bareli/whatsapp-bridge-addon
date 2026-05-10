# Changelog

## 0.1.3

- Treat `bashio::config` literal `"null"` as empty for `puppeteer_executable`,
  `proxy_url`, and `api_token`. Previously the run script exported the
  literal `"null"` string, which leaked into puppeteer and made it
  reject the executable path with "Browser was not found at the
  configured executablePath (null)". The bridge then crashed in a
  restart loop.

## 0.1.2

- Align `ingress_port` with the Node service port (`8080`). Previously the
  ingress proxy was configured to talk to port `8099`, which the bridge did
  not listen on, so the add-on web UI returned 502 / "The app seems to not
  be ready". Single port now handles both ingress and the internal docker
  DNS API.

## 0.1.1

- Fix s6-overlay `Permission denied` on the service `run` script. The
  executable bit was not preserved in the source tree from a Windows
  development host; Supervisor refused to start the bridge.

## 0.1.0

- Initial release.
- Single WhatsApp account, send text/media, receive incoming as WS events.
- amd64 and aarch64 builds.
