.PHONY: build install clean build-all test dev app app-signed app-install test-native app-dmg app-check app-cask app-cask-check app-smoke release-check release-snapshot workflow-check

-include .env
export

VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.version=$(VERSION)"
GORELEASER ?= goreleaser
ACTIONLINT ?= actionlint
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

dev:
	@which air > /dev/null 2>&1 || go install github.com/air-verse/air@latest
	air

build:
	go build $(LDFLAGS) -o tsq .

build-debug:
	go build -tags debug $(LDFLAGS) -o tsq .

build-all:
	mkdir -p dist
	GOOS=darwin  GOARCH=arm64 go build $(LDFLAGS) -o dist/tsq-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build $(LDFLAGS) -o dist/tsq-darwin-amd64 .
	GOOS=linux   GOARCH=amd64 go build $(LDFLAGS) -o dist/tsq-linux-amd64  .

test:
	CGO_ENABLED=0 go test ./...

test-native:
	CGO_ENABLED=1 go test ./...

app-check:
	VERSION=$(VERSION) ./scripts/test-macos-app.sh

app-dmg:
	VERSION=$(VERSION) ./scripts/package-macos-app.sh

app-cask:
	VERSION=$(VERSION) ./scripts/generate-homebrew-cask.sh

app-cask-check: app-cask
	./scripts/test-homebrew-cask.sh

release-check:
	./scripts/check-release-secrets.sh

workflow-check:
	$(ACTIONLINT) ../../.github/workflows/ci.yml ../../.github/workflows/daemon.yml

release-snapshot:
	$(GORELEASER) check
	$(GORELEASER) release --snapshot --clean --skip=publish

# Isolated menu-bar fixture: no authentication, polling, tasks, or autostart.
app-smoke:
	mkdir -p dist/TaskSquad-Smoke.app/Contents/MacOS
	CGO_ENABLED=1 go build -o dist/TaskSquad-Smoke.app/Contents/MacOS/TaskSquad ./scripts/macos-smoke
	sed -e 's/ai.tasksquad.tsq/ai.tasksquad.smoke/' -e 's/__VERSION__/0.0.0/g' scripts/Info.plist.template > dist/TaskSquad-Smoke.app/Contents/Info.plist
	./dist/TaskSquad-Smoke.app/Contents/MacOS/TaskSquad

install: build
	mkdir -p "$(DESTDIR)$(BINDIR)"
	install -m 0755 tsq "$(DESTDIR)$(BINDIR)/tsq"
	@echo "Installed $(DESTDIR)$(BINDIR)/tsq"

# Builds an unsigned TaskSquad.app in dist/ for local smoke-testing (macOS only,
# requires Xcode command line tools for cgo). CI signs/notarizes a separate build.
app:
	VERSION=$(VERSION) ./scripts/generate-icon.sh
	VERSION=$(VERSION) ./scripts/build-macos-app.sh

# Signs, notarizes, staples, and packages dist/TaskSquad.app into a DMG using
# a Developer ID cert from your local (Xcode-managed) keychain. Requires
# SIGNING_IDENTITY and NOTARY_PROFILE — set them in packages/daemon/.env
# (gitignored). See scripts/sign-and-notarize-local.sh for one-time setup.
app-signed: app
	VERSION=$(VERSION) ./scripts/sign-and-notarize-local.sh

# Installs the unsigned dist/TaskSquad.app into /Applications for local use
# and clears the quarantine attribute so Gatekeeper doesn't block it (it's
# unsigned, so without this macOS refuses to open it at all). Local
# smoke-testing only — use app-signed for a distributable build.
app-install: app
	rm -rf /Applications/TaskSquad.app
	cp -R dist/TaskSquad.app /Applications/TaskSquad.app
	xattr -cr /Applications/TaskSquad.app
	@echo "Installed /Applications/TaskSquad.app (unsigned, quarantine cleared)"

clean:
	rm -f tsq
	rm -rf dist/
