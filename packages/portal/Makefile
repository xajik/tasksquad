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
	bunx prettier@3.6.2 --write --no-semi --single-quote --trailing-comma none --print-width 110 src/lib/graph.ts src/lib/graphLayout.ts src/lib/graphLayout.test.ts src/lib/graphProjection.ts src/lib/graphProjection.test.ts src/lib/graphAttention.ts src/lib/graphAttention.test.ts src/components/GraphInboxPanel.tsx src/pages/Graphs.tsx src/components/GraphCanvas.tsx
	bunx prettier@3.6.2 --write --no-semi --single-quote --trailing-comma none --print-width 110 src/components/GraphDashboardPanels.tsx src/lib/graphDashboard.ts src/lib/graphDashboard.test.ts
