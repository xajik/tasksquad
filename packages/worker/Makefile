.PHONY: build test dev deploy clean install migrate migrate-local new-migration

dev:
	bun run dev

build:
	bun run build

test:
	bun run test

deploy:
	bun run deploy

clean:
	rm -rf dist/

install:
	bun install

# Apply all pending migrations to production D1
migrate:
	bunx wrangler d1 migrations apply tasksquad-db --remote

# Apply all pending migrations to local D1 (for local dev / wrangler dev)
migrate-local:
	bunx wrangler d1 migrations apply tasksquad-db --local

# Create a new numbered migration file
# Usage: make new-migration name=add_something
new-migration:
	@test -n "$(name)" || (echo "Usage: make new-migration name=<snake_case_description>" && exit 1)
	bunx wrangler d1 migrations create tasksquad-db $(name)

.PHONY: check
check:
	bunx tsc --project tsconfig.check.json --noEmit

.PHONY: format-graph
format-graph:
	bunx prettier@3.6.2 --write --no-semi --single-quote --trailing-comma none --print-width 110 src/graph/*.ts src/routes/graphs.ts

# Real local Worker + portal + isolated CLI test agents (never production data).
GRAPH_AGENTS ?= claude
.PHONY: graph-local
graph-local:
	node scripts/local-graph.mjs --agents "$(GRAPH_AGENTS)"

.PHONY: format-local-graph
format-local-graph:
	bunx prettier@3.6.2 --write --no-semi --single-quote --trailing-comma none --print-width 110 scripts/local-graph.mjs

.PHONY: graph-local-check
graph-local-check:
	node --check scripts/local-graph.mjs
	node --check ../daemon/scripts/local-graph-daemon/claude.mjs

.PHONY: graph-local-daemon
graph-local-daemon:
	$(MAKE) -C ../daemon build-local-graph
	node scripts/local-graph.mjs --agents daemon
