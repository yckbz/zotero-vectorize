# Zotero Vectorize skill

The [Zotero desktop plugin](../README.md) is the main application in this repository. The original skill is available in [`skill/zotero-vectorize/`](zotero-vectorize/SKILL.md) for building and maintaining a Zotero vector index from a command line or an agent.

The skill can detect Zotero paths, snapshot the database, build metadata and PDF passage embeddings, and verify its output. In the incremental workflow it reports missing records before applying an update. It treats Zotero as read-only and backs up the vector files before rewriting them.

## Validate and package

From the repository root, run:

```sh
python3 -m pip install pyyaml
python3 tools/quick_validate.py skill/zotero-vectorize
python3 tools/package_skill.py skill/zotero-vectorize dist
```

The packager creates `dist/zotero-vectorize.skill` for import into OpenClaw. The indexing scripts use `sentence-transformers`, `torch`, `PyMuPDF`, and `numpy`. See [the skill instructions](zotero-vectorize/SKILL.md) and [configuration reference](zotero-vectorize/references/config.md) for paths and runtime settings.

The desktop plugin can import or export the skill’s three [JSON index files](zotero-vectorize/references/data-format.md).
