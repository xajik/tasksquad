.PHONY: build install clean build-all test dev

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

clean:
	rm -f tsq
	rm -rf dist/
