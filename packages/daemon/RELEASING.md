# macOS app and CLI releases

TaskSquad.app is a macOS menu-bar app, requiring macOS 11 or newer. It is a
universal Intel/Apple Silicon bundle containing the cgo-enabled Go daemon.
The separate `tsq` CLI release uses `CGO_ENABLED=0` and has no menu bar.

## Installation and updates

Once a signed app release and its cask have been published:

```sh
brew tap xajik/tap
brew install --cask xajik/tap/tasksquad
open /Applications/TaskSquad.app
```

First launch opens the existing setup wizard in Terminal if
`~/.tasksquad/config.toml` is missing, then reopens the app after successful
setup. Existing users reuse their config and login. Install and authenticate
your agent CLI separately. The cask installs tmux; direct DMG users must install
tmux themselves. Finder startup includes Homebrew and common user tool paths;
use an absolute command path in config for tools installed elsewhere.

Quit TaskSquad, then update and reopen it:

```sh
brew update
brew upgrade --cask xajik/tap/tasksquad
open /Applications/TaskSquad.app
```

The CLI remains independently available:

```sh
brew install xajik/tap/tsq
brew upgrade xajik/tap/tsq
```

Both packages can be installed, but run one daemon at a time. New macOS builds
enforce this with a process-lifetime file lock. Quit older CLI versions before
opening the app, as older releases do not participate in that lock. The cask
does not install a `tsq` symlink over the formula's command; the app has its own
internal `tsq` alias for agent hooks. When switching an existing login-started
CLI installation to the app, toggle **Run on OS Boot** off and back on in the
app so the registration points to the app. Registration takes effect at the
next login and does not start another process immediately.

Alternatively download `TaskSquad-X.Y.Z.dmg` and its `.sha256` file from
[GitHub Releases](https://github.com/xajik/tasksquad/releases), verify with
`shasum -a 256 -c TaskSquad-X.Y.Z.dmg.sha256`, open the DMG, and drag TaskSquad
onto Applications. Eject the DMG and open the installed app.

## Release prerequisites

Configure these repository Actions secrets before tagging a release:

- `MACOS_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application
  certificate **and private key**, exported as a password-protected `.p12`.
- `MACOS_CERTIFICATE_PASSWORD`: the `.p12` export password.
- `MACOS_SIGNING_IDENTITY`: the Developer ID Application identity name.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`: Apple notarization
  API credentials; the last contains the full private `.p8` key text.
- `TAP_GITHUB_TOKEN`: token with Contents write access to `xajik/homebrew-tap`.

An **Apple Development** certificate cannot replace a **Developer ID
Application** certificate for public distribution. See Apple's
[notarization guide](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Secrets are checked by name without printing their values.

If any of the six signing/notarization secrets above are missing, the release
does **not** fail: it ships `dist/TaskSquad.app` ad-hoc signed and unnotarized
instead, uploaded to the GitHub release as usual. It deliberately skips the
Homebrew cask update for that build — the cask is the default `brew install`
path for most users, so an unnotarized app only goes out to people who
explicitly download the DMG from the release page and know to bypass
Gatekeeper (right-click → Open, or `xattr -d com.apple.quarantine
"/Applications/TaskSquad.app"`). `TAP_GITHUB_TOKEN` only matters once real
signing is configured.

## Release flow

Push a new stable `vX.Y.Z` tag containing the changes. The release workflow:

1. Publishes CLI archives/checksums and updates `Formula/tsq.rb` via GoReleaser.
2. Runs native tests, builds both macOS architectures, and checks the app bundle.
3. If signing secrets are configured: signs, requires an Accepted notarization
   result, staples, and checks Gatekeeper. Otherwise: ad-hoc signs instead
   (see above) and skips straight to packaging.
4. Packages a DMG and mounts/copies it into a temporary Applications directory
   to verify installation, executable version, and bundled `tsq` alias.
5. Uploads the DMG and its SHA-256 file to the same GitHub release.
6. If signed: generates and validates `Casks/tasksquad.rb` against the actual
   DMG checksum, then pushes it to the tap. The CLI formula is preserved. An older release
   retry does not downgrade the latest app cask.

Use **Release Daemon → Run workflow → tag** to retry the app portion for a
tag that includes this workflow and its scripts, without rerunning GoReleaser.
The selected tag's commit is always used. To fix a release whose code predates
these changes, create a new version rather than relabelling modified binaries
as an old tag. Runs are serialized so tap updates do not race each other.

GoReleaser is pinned to v1.26.2 to preserve the existing CLI formula generator.
Migrating its config and formula publication to v2 is a separate change.

## Local and CI validation

```sh
cd packages/daemon
make test
make test-native
make app app-dmg app-check app-cask-check VERSION=v0.0.0
make app-smoke
```

The smoke fixture uses the real tray and local control panel with a fake user,
zero agents, no login, no polling, and an in-memory autostart toggle. Check
Resume/Pause, Control Panel, Run on OS Boot, and Quit. It must never be released.

CI runs the native tests and packaging checks without signing secrets and
retains `TaskSquad-macos-unsigned` as a test artifact. These checks validate the
universal binary structure and execute the host architecture; testing on a real
Intel Mac and macOS 11 remains a separate compatibility check. Local unsigned
installers do not establish Gatekeeper acceptance. Use `make app-signed` with
`SIGNING_IDENTITY` and `NOTARY_PROFILE` in the local package `.env` for a signed
local build. Do not commit credentials.

The app cask follows the [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook).
