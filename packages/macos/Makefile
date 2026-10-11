.PHONY: build test test-compatibility test-keychain test-ui dev app app-check app-signed package install install-cli cli smoke workflow-check clean

# Bumped by `make bump` at the repo root; release workflows pass VERSION explicitly.
VERSION ?= 0.4.3
# Empty = universal when Rosetta is available, else native arm64 only.
ARCHS ?=
export ARCHS
SWIFT ?= swift
ACTIONLINT ?= go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
APP_DIR ?= $(HOME)/Applications
SMOKE_CONFIG ?= $(CURDIR)/Tests/TaskSquadCoreTests/Fixtures/full.toml

build:
	$(SWIFT) build

test:
	$(SWIFT) test

test-compatibility:
	mkdir -p .build/reference
	cd ../daemon && CGO_ENABLED=0 go build -o ../macos/.build/reference/go-daemon ../macos/Tests/GoReference/main.go
	cd ../daemon && CGO_ENABLED=0 go build -o ../macos/.build/reference/tsq .
	TSQ_GO_ORACLE="$(CURDIR)/.build/reference/go-daemon" TSQ_GO_TSQ="$(CURDIR)/.build/reference/tsq" $(SWIFT) test

test-keychain:
	mkdir -p .build/reference
	cd ../daemon && CGO_ENABLED=0 go build -o ../macos/.build/reference/go-daemon ../macos/Tests/GoReference/main.go
	TSQ_GO_ORACLE="$(CURDIR)/.build/reference/go-daemon" TSQ_TEST_KEYCHAIN=1 $(SWIFT) test --filter KeychainIntegrationTests

test-ui:
	mkdir -p .build/ui-artifacts
	TSQ_UI_ARTIFACTS="$(CURDIR)/.build/ui-artifacts" $(SWIFT) test --filter 'NativeUITests|CustomerWorkspaceTests'

.PHONY: preview-customer
preview-customer: build
	mkdir -p .build/CustomerPreview.app/Contents/MacOS .build/CustomerPreview.app/Contents/Resources
	cp .build/debug/TaskSquad .build/CustomerPreview.app/Contents/MacOS/TaskSquad
	cp scripts/customer-preview.plist .build/CustomerPreview.app/Contents/Info.plist
	for bundle in .build/debug/*.bundle; do case $$bundle in *Tests.bundle) ;; *) ditto $$bundle .build/CustomerPreview.app/Contents/Resources/$$(basename $$bundle);; esac; done
	codesign --force --sign - .build/CustomerPreview.app
	open .build/CustomerPreview.app --args --preview-customer

dev: build
	.build/debug/TaskSquad

app:
	VERSION="$(VERSION)" ./scripts/build-app.sh

app-check: app
	./scripts/check-app.sh

app-signed: app-check
	./scripts/sign-app.sh

package:
	./scripts/check-app.sh
	VERSION="$(VERSION)" ./scripts/package-app.sh

install: app-check
	APP_DIR="$(APP_DIR)" ./scripts/install-app.sh

# Standalone tsq tarball (CLI + headless daemon), like the Go release archives.
cli:
	VERSION="$(VERSION)" ./scripts/build-cli.sh

# Puts the installed app's tsq on PATH; never replaces a tsq that isn't a link to an app.
CLI_LINK ?= $(HOME)/.local/bin/tsq
install-cli:
	@target="$(APP_DIR)/TaskSquad Native.app/Contents/MacOS/tsq"; test -x "$$target" || { echo "Install the app first (make install)"; exit 1; }; \
	mkdir -p "$$(dirname "$(CLI_LINK)")"; \
	if [ -e "$(CLI_LINK)" ] && [ ! -L "$(CLI_LINK)" ]; then echo "$(CLI_LINK) exists and is not a link; leaving it (Go tsq?)"; exit 1; fi; \
	ln -sfn "$$target" "$(CLI_LINK)" && echo "$(CLI_LINK) -> $$target"

smoke:
	open "$(APP_DIR)/TaskSquad Native.app" --args --config "$(SMOKE_CONFIG)"

workflow-check:
	$(ACTIONLINT) ../../.github/workflows/macos-native.yml ../../.github/workflows/macos-native-preview.yml ../../.github/workflows/macos-native-stable.yml

clean:
	$(SWIFT) package clean
	rm -rf dist

.PHONY: ui-fixture-up ui-fixture-down
ui-fixture-up:
	python3 scripts/ui-fixture.py start

ui-fixture-down:
	python3 scripts/ui-fixture.py stop
