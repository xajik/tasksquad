# Default resource catalog

This directory is the reviewed, version-controlled source for generic global skills. Project-specific instructions must stay in the project and must not be promoted here.

`catalog.json` lists dependencies and the SHA-256 ETag convention already used by the Worker. Project resources override global defaults with the same kind and name. Sync repairs missing provider copies when their ETag is unchanged and keeps user-edited provider files intact.

Before an administrative catalog update, export the current default rows (including IDs, content, ETags, versions, and timestamps) to a private before snapshot. Compute each ETag as the lowercase SHA-256 of the exact UTF-8 file bytes. Apply only reviewed rows with stable IDs and increment versions only when content changes. Export an after snapshot, compare selected fields, verify project overrides, and retain both snapshots so the update can be reversed. Use the Worker package's Wrangler configuration to inspect D1; never commit production snapshots or credentials.

The markdown here is a proposed catalog. It is not evidence that the corresponding production database rows, installed provider files, or provider discovery have been updated.
