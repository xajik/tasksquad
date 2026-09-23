.PHONY: build test test-compatibility test-keychain test-ui dev app app-check app-signed package install smoke workflow-check clean

VERSION ?= 0.1.0-dev
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
	TSQ_GO_ORACLE="$(CURDIR)/.build/reference/go-daemon" $(SWIFT) test

test-keychain:
	mkdir -p .build/reference
	cd ../daemon && CGO_ENABLED=0 go build -o ../macos/.build/reference/go-daemon ../macos/Tests/GoReference/main.go
	TSQ_GO_ORACLE="$(CURDIR)/.build/reference/go-daemon" TSQ_TEST_KEYCHAIN=1 $(SWIFT) test --filter KeychainIntegrationTests

test-ui:
	mkdir -p .build/ui-artifacts
	TSQ_UI_ARTIFACTS="$(CURDIR)/.build/ui-artifacts" $(SWIFT) test --filter NativeUITests

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

smoke:
	open "$(APP_DIR)/TaskSquad Native.app" --args --config "$(SMOKE_CONFIG)"

workflow-check:
	$(ACTIONLINT) ../../.github/workflows/macos-native.yml ../../.github/workflows/macos-native-preview.yml

clean:
	$(SWIFT) package clean
	rm -rf dist

.PHONY: ui-fixture-up ui-fixture-down
ui-fixture-up:
	python3 scripts/ui-fixture.py start

ui-fixture-down:
	python3 scripts/ui-fixture.py stop
