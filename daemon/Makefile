BINARY = tsq
VERSION ?= dev

.PHONY: build release clean

build:
	GOOS=darwin  GOARCH=arm64 go build -o dist/$(BINARY)-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build -o dist/$(BINARY)-darwin-amd64 .
	GOOS=linux   GOARCH=amd64 go build -o dist/$(BINARY)-linux-amd64  .

release: build
	gh release create $(VERSION) dist/* --title $(VERSION)

clean:
	rm -rf dist/
