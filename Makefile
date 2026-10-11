.PHONY: test bump patch minor major

test:
	$(MAKE) -C packages test

# Bump every product's version, commit, tag the daemon release vX.Y.Z and push both:
# `make bump` (patch), `make bump minor`, `make bump major`; MSG="…" annotates the tag.
# Make treats --minor as one of its own flags, so the part is a word; scripts/bump.py --minor also works.
PART ?= $(or $(filter patch minor major,$(MAKECMDGOALS)),patch)
bump:
	@python3 scripts/bump.py --$(PART) $(if $(MSG),"--message=$(MSG)")

patch minor major:
	@:
