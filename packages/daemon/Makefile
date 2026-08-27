.PHONY: build install clean build-all test dev app app-signed app-install

-include .env
export

VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

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

install: build
	cp tsq /usr/local/bin/tsq

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
