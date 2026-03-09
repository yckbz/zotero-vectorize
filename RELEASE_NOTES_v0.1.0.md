# zotero-vectorize v0.1.0

Initial public release of `zotero-vectorize`, a cross-platform OpenClaw skill for building and maintaining a local semantic index over a Zotero library.

## Highlights

- Build **metadata embeddings** into `metadata_vectors.json`
- Build **PDF full-text chunk embeddings** into `fulltext_vectors.json`
- Maintain a local-first workflow over Zotero SQLite + attachment storage
- Check missing items before updating the vector store
- Apply **incremental updates** only after user confirmation
- Back up store files before rewrite and keep only:
  - latest backup
  - previous backup
- Verify final counts, chunk totals, and file sizes
- Package the skill into a `.skill` archive for OpenClaw distribution

## Included skill components

### Skill
- `skill/zotero-vectorize/SKILL.md`

### Scripts
- `detect_zotero_paths.py`
- `snapshot_zotero_db.py`
- `build_metadata_vectors.py`
- `build_fulltext_vectors.py`
- `check_incremental_updates.py`
- `apply_incremental_updates.py`
- `backup_with_retention.py`
- `verify_vector_store.py`
- `zotero_vectorize_lib.py`

### References
- configuration guide
- data format guide
- Windows notes
- macOS notes
- Linux notes
- troubleshooting guide

## Design principles

- **Cross-platform**: designed for Windows, macOS, and Linux
- **Local-first**: Zotero is treated as local, read-only input
- **Safe updates**: diff first, confirm first, backup first
- **Skill-compliant**: actual skill package remains clean and minimal
- **GitHub-friendly**: repository includes validation and packaging helpers

## Tested in this release

This release was validated with an isolated end-to-end test flow:

- path detection
- empty-store diff check
- full metadata build
- full full-text build
- isolated incremental update simulation
- backup retention verification
- skill validation and packaging

## Notes

- Default embedding model: `paraphrase-multilingual-MiniLM-L12-v2`
- Default metadata output: `metadata_vectors.json`
- Default full-text output: `fulltext_vectors.json`
- Default store metadata output: `vector_store_metadata.json`

## Known limitations / future work

- No OCR fallback yet for scanned PDFs
- No vector-database backend yet (JSON-first for portability and debugging)
- No built-in semantic search CLI yet
- Collection-scoped indexing and date-window updates can be added later

## Packaging

Validate the skill:

```bash
python3 tools/quick_validate.py skill/zotero-vectorize
```

Package the skill:

```bash
python3 tools/package_skill.py skill/zotero-vectorize dist
```

## Suggested release title

`zotero-vectorize v0.1.0 — initial public release`

## Suggested release tagline

Cross-platform Zotero metadata/full-text vectorization for OpenClaw, with safe incremental updates and skill packaging.
