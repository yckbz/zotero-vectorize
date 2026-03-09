# zotero-vectorize

A cross-platform, local-first OpenClaw skill for building and maintaining a semantic index over a Zotero library.

It creates **two complementary vector stores**:

- `metadata_vectors.json` — embeddings for Zotero item metadata (title, abstract, authors, tags, DOI, URL, etc.)
- `fulltext_vectors.json` — chunk embeddings extracted from PDF attachments in the Zotero storage directory

It also supports **incremental updates** with a safety-first workflow:

1. detect missing items
2. report the diff
3. wait for user confirmation
4. back up the store
5. append the missing vectors
6. retain only the latest and previous backup per file

## Why this exists

There are Zotero-related skills and there are generic embedding / RAG skills, but there is still a gap for a reusable OpenClaw skill that combines:

- local Zotero SQLite + storage access
- metadata embeddings
- PDF full-text chunk embeddings
- incremental update workflow
- backup retention rules
- cross-platform support for Windows, macOS, and Linux

`zotero-vectorize` is designed to fill that gap.

## Repository layout

```text
zotero-vectorize/
├── README.md
├── LICENSE
├── .gitignore
├── .github/workflows/
├── dist/
├── tools/
│   ├── quick_validate.py
│   └── package_skill.py
└── skill/
    └── zotero-vectorize/
        ├── SKILL.md
        ├── scripts/
        └── references/
```

The actual skill lives under:

```text
skill/zotero-vectorize/
```

This keeps the skill package itself clean and aligned with OpenClaw skill conventions, while the repository root can still contain GitHub-friendly files such as this README, LICENSE, CI workflow, and packaging helpers.

## What the skill does

The skill provides:

- path detection for Zotero data directory, database, storage directory, and output directory
- SQLite snapshot creation before read-heavy operations
- full build for metadata vectors
- full build for PDF full-text vectors
- incremental diff checking
- incremental append after user confirmation
- store verification (counts, sizes, metadata)
- backup retention with only the latest and previous backup kept

## Output files

The store uses explicit filenames:

- `metadata_vectors.json`
- `fulltext_vectors.json`
- `vector_store_metadata.json`
- `README.md`

## Cross-platform design

The skill is designed for:

- **Windows**
- **macOS**
- **Linux**

It supports:

- platform defaults for Zotero paths
- environment variable overrides
- explicit CLI flags for all critical paths

See:

- `skill/zotero-vectorize/references/windows.md`
- `skill/zotero-vectorize/references/macos.md`
- `skill/zotero-vectorize/references/linux.md`

## Dependencies

Typical Python dependencies:

- `sentence-transformers`
- `torch`
- `PyMuPDF`
- `numpy`

## Quick start

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd zotero-vectorize
```

### 2. Package the skill

```bash
python3 tools/package_skill.py skill/zotero-vectorize dist
```

This creates:

```text
dist/zotero-vectorize.skill
```

### 3. Import / install into OpenClaw

Install the generated `.skill` file using your preferred OpenClaw / ClawHub workflow.

### 4. Typical usage flow inside OpenClaw

- detect paths
- snapshot Zotero DB
- build metadata vectors
- build full-text vectors
- check incremental updates
- apply incremental updates only after user confirmation
- verify counts and file sizes

## Packaging and validation

This repo includes self-contained tooling so contributors do not need a local OpenClaw source checkout just to validate/package the skill.

### Validate

```bash
python3 tools/quick_validate.py skill/zotero-vectorize
```

### Package

```bash
python3 tools/package_skill.py skill/zotero-vectorize dist
```

## Safety model

This skill is intentionally conservative:

- Zotero is treated as **read-only input**
- the skill snapshots the database before reads
- updates are not applied before reporting the missing items
- store files are backed up before rewrite
- only the latest and previous backup are retained

## Current status

This repository contains a tested first release candidate:

- skill structure validated
- full build tested in an isolated output directory
- incremental update workflow tested
- backup retention behavior tested
- packaging tested

## Suggested roadmap

Future improvements may include:

- OCR fallback for scanned PDFs
- semantic search CLI helpers
- optional vector-database backend (Faiss / LanceDB / Qdrant / Chroma)
- collection-scoped indexing
- date-window incremental modes

## License

MIT
