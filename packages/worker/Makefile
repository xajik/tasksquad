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
