SIMULATOR ?= iPhone 17 Pro
SIMULATOR_OS ?= 26.1
DERIVED_DATA ?= .build/DerivedData
TEST_FLAGS ?=
SIMULATOR_SIGNING = CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual

.PHONY: icons generate build test e2e clean evidence

icons:
	xcrun swift scripts/generate_icons.swift

generate: icons
	xcodegen generate --spec project.yml

build: generate
	xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad -destination 'platform=iOS Simulator,name=$(SIMULATOR),OS=$(SIMULATOR_OS)' -derivedDataPath $(DERIVED_DATA) -skipPackagePluginValidation $(SIMULATOR_SIGNING) build

test: generate
	xcodebuild -project TaskSquad.xcodeproj -scheme TaskSquad -destination 'platform=iOS Simulator,name=$(SIMULATOR),OS=$(SIMULATOR_OS)' -derivedDataPath $(DERIVED_DATA) -parallel-testing-enabled NO -collect-test-diagnostics never -skipPackagePluginValidation $(SIMULATOR_SIGNING) $(TEST_FLAGS) test

e2e: test

clean:
	rm -rf .build TaskSquad.xcodeproj

.PHONY: fixture e2e-contract
fixture: .build/fixture-env/bin/python
	.build/fixture-env/bin/python scripts/workspace_fixture.py

e2e-contract: .build/fixture-env/bin/python
	.build/fixture-env/bin/python scripts/run_contract_tests.py

.build/fixture-env/bin/python: scripts/requirements.txt
	python3 -m venv .build/fixture-env
	.build/fixture-env/bin/python -m pip install -r scripts/requirements.txt

evidence:
	python3 scripts/export_evidence.py "$(RESULT)"
