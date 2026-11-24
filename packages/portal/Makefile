.PHONY: build test lint dev deploy clean install

dev:
	bun run dev

build:
	bun run build

test:
	bun run test

lint:
	bun run lint

deploy:
	bun run deploy

clean:
	rm -rf dist/

install:
	bun install

.PHONY: format-graph
format-graph:
	bunx prettier@3.6.2 --write --no-semi --single-quote --trailing-comma none --print-width 110 'src/lib/graph*.ts' src/lib/localGraph.ts src/lib/parseJson.ts 'src/components/Graph*.tsx' src/pages/Graphs.tsx
