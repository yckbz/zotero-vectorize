# Zotero Vectorize

[简体中文](README.zh-CN.md)

Search your Zotero library by meaning, find the relevant passage in a PDF, and open the matching page in Zotero’s reader. Zotero Vectorize is a desktop plugin designed for local use. It can retrieve English papers from Chinese queries and Chinese papers from English queries.

## Install and search

1. Download `zotero-vectorize.xpi` from [GitHub Releases](https://github.com/yckbz/zotero-vectorize/releases). You can also [build the package from source](#build-from-source).
2. In Zotero, open **Tools → Plugins**, then choose **Install Add-on From File…** from the gear menu and select the XPI.
3. In **Zotero Settings → Zotero Vectorize**, select **Download / Verify Model** to set up the default multilingual MiniLM model. The initial model download requires an internet connection. Inference runs locally after the assets are installed.
4. Type in Zotero’s toolbar search box or open the command palette with **⌘K** on macOS or **Ctrl+K** on Windows or Linux. Choose **Hybrid**, **Metadata**, or **Fulltext**, and search the whole library or the current collection. Select a passage to jump to its PDF page.

Open **Semantically Similar Papers** in the item pane to browse related papers from your library.

Cross-language semantic search uses the selected embedding model. In Search Settings, you can enable plain-digit matching to find formatted digits such as `x₂` or `x²` with `x2`.

The package declares Zotero 7.0 as its minimum version. Desktop integration has been tested on Zotero 10.0.9 on macOS. Windows and Linux desktop validation is pending.

## Indexing

- Background indexing is enabled by default. Text becomes available for keyword search as the initial scan proceeds. When the embedding model is ready, the plugin can generate vectors and use them for semantic retrieval.
- The settings page shows **vectorized / indexed** counts for items and passages. For example, `0 / 100` passages means 100 passages are searchable as text and zero have vectors. Use **Index Missing / Changed** to start an incremental scan, such as after switching models.
- The PDF defaults are **1,024 characters per chunk**, **128 characters of overlap**, and **64 pages per attachment**. Set the page limit to **0** to index all pages. Run **Rebuild All** to apply changed chunking or page limits to already indexed PDFs.
- The first vector indexing pass can take time on large libraries. Afterward, incremental scans reuse unchanged records.

## Embedding engines

| Engine | Setup |
| --- | --- |
| **Local ONNX / WASM** (default) | Download a model from the plugin settings. The default is multilingual MiniLM L12. Inference runs in a local CPU worker. |
| **Ollama** | Start Ollama, choose an embedding model installed on the server, and test the connection in the plugin settings. The default server address is `http://localhost:11434`. |
| **OpenAI-compatible API** | Set the base URL, API key, and embedding model. The plugin sends the text being embedded to the configured endpoint. |

Vectors from different models use different embedding spaces. After switching models, run incremental indexing so the selected model can build its own vectors.

## Use Zotero Vectorize from an agent

In **Zotero Settings → Zotero Vectorize → Agent access (MCP)**, turn on **Enable local MCP**. Use **Copy Codex configuration** to add the server to your user-level `~/.codex/config.toml`, then restart Codex. The copied configuration contains the access token. Keep Zotero running while using the server.

MCP has been verified on Zotero 10.0.9 on macOS.

The endpoint at `http://127.0.0.1:23124/mcp` serves read-only requests from the same computer. `search_papers` searches the existing **My Library** index and returns metadata, candidate passages and PDF page links. It can restrict the search to a collection by its exact path. Items without PDFs still appear in hybrid and metadata searches. `read_pdf_pages` reads up to three consecutive pages directly from a specified attachment, including pages beyond the configured search indexing limit. Missing files and pages with no extractable text have explicit statuses.

The agent receives the returned metadata and text. Search queries use the embedding provider configured in the plugin.

## Data and JSON exchange

The plugin stores its index in `<Zotero Data Directory>/zotero-vectorize/vectorize.sqlite`. It reads Zotero metadata and PDF text and writes its own index separately from Zotero’s library database and attachments.

The skill uses the same JSON index format for command-line and agent workflows. To exchange indexes, use **Standard 3-File Vector JSON Import / Export** in the plugin settings and put the three files in the same folder.

- `metadata_vectors.json`
- `fulltext_vectors.json`
- `vector_store_metadata.json`

## Build from source

Install Node.js 22 or later and make Python 3 available as `python3`. From the repository root, run:

```sh
npm ci
npm run verify
```

This checks types, builds and validates the XPI, and runs the tests. The installable package is `dist/zotero-vectorize.xpi`. To package without running the full verification suite, use `npm run package`.

[MIT License](LICENSE)
