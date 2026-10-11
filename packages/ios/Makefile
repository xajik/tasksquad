SIMULATOR ?= iPhone 17 Pro
SIMULATOR_OS ?= 26.1
DERIVED_DATA ?= .build/DerivedData

.PHONY: generate build test e2e clean

generate:
	xcodegen generate --spec project.yml

build: generate
	xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad -destination 'platform=iOS Simulator,name=$(SIMULATOR),OS=$(SIMULATOR_OS)' -derivedDataPath $(DERIVED_DATA) -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build

test: generate
	xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad -destination 'platform=iOS Simulator,name=$(SIMULATOR),OS=$(SIMULATOR_OS)' -derivedDataPath $(DERIVED_DATA) -parallel-testing-enabled NO -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO test

e2e: test

clean:
	rm -rf .build TaskSquad.xcodeproj
