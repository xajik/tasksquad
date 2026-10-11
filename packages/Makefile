.PHONY: test

test:
	$(MAKE) -C daemon test
	$(MAKE) -C portal test
	$(MAKE) -C worker test
	$(MAKE) -C mcp test
	@if [ "$$(uname -s)" = Darwin ]; then $(MAKE) -C macos test-compatibility; fi
