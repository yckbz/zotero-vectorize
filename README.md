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

- Background indexing is enabled by default. A library scan indexes metadata first while preparing PDF passages in the background. Full-text embedding follows metadata embedding. Each stage publishes its results as it progresses.
- The settings page shows **vectorized / indexed** counts for items and passages. For example, `0 / 100` passages means 100 passages are searchable as text and zero have vectors. Use **Index Missing / Changed** to start an incremental scan.
- The PDF defaults are **1,024 characters per chunk**, **128 characters of overlap**, and **64 pages per attachment**. Set the page limit to **0** to index all pages. Run **Rebuild All** to apply changed chunking or page limits to already indexed PDFs.
- The first vector indexing pass can take time on large libraries. Afterward, incremental scans reuse unchanged records.

## Embedding engines

| Engine | Setup |
| --- | --- |
| **Local ONNX / WASM** (default) | Download a model from the plugin settings. The default is multilingual MiniLM L12. Inference runs in a local CPU worker. |
| **Ollama** | Start Ollama, choose an embedding model installed on the server, and test the connection in the plugin settings. The default server address is `http://localhost:11434`. |
| **OpenAI-compatible API** | Set the base URL, API key, and embedding model. The plugin sends the text being embedded to the configured endpoint. |

Click **Apply Model Settings** to switch models. Choose whether to keep the previous vectors. Returning to a saved model loads its vectors and checks for library changes. **Vector Indexes** lists coverage for each saved model and lets you delete its vectors.

## Sync vector indexes through Zotero

Set up WebDAV attachment sync for My Library on desktop devices signed in to the same Zotero account. In **Zotero Settings → Zotero Vectorize → Sync vector indexes through Zotero**, choose **Publish this device’s index** on one device and **Receive the shared index** on the others. Sync is off by default. Use **Check sync now** to see its status.

The publisher uploads changed index parts through Zotero, then updates a manifest attachment. Devices with a verified copy reuse unchanged parts across publications. First-time setup transfers the full shared index for the current model, up to 1 GiB before WebDAV compression. The default part size limit is 32 MiB. Choose 8, 16, 32, 64, 128, or 256 MiB in **Advanced settings**. A smaller limit reduces the size of each file that needs retransmitting and increases the number of attachments and WebDAV checks.

Finish any pending publication with the previous plugin before upgrading. Upgrade all participating devices together. The first publication in the new format uploads the full shared index once.

ONNX and Ollama models require a matching revision. For OpenAI-compatible models, configure the same Base URL, model, and output dimensions on each device and enter an API key separately on every device. When dimensions are set to `0`, the plugin checks the dimensions actually returned by the service. The attachment contains an endpoint fingerprint for matching. Credentials, paths, and connection settings stay on each device.

Receivers switch to a new index after all its parts arrive and pass validation. During an interruption, the latest validated shared index, local indexes, and manual local indexing remain available. A receiver with a usable shared index suspends automatic indexing for My Library. Group libraries continue to use local indexes. Opening a shared passage verifies the PDF version before jumping to its page.

## Use Zotero Vectorize from an agent

In **Zotero Settings → Zotero Vectorize → Agent access (MCP)**, turn on **Enable local MCP**. Use **Copy Codex configuration** to add the server to your user-level `~/.codex/config.toml`, then restart Codex. The copied configuration contains the access token. Keep Zotero running while using the server.

MCP has been verified on Zotero 10.0.9 on macOS.

The endpoint at `http://127.0.0.1:23124/mcp` serves read-only requests from the same computer. `search_papers` searches the existing **My Library** index and returns metadata, candidate passages and PDF page links. It can restrict the search to a collection by its exact path. Items without PDFs still appear in hybrid and metadata searches. `read_pdf_pages` reads up to three consecutive pages directly from a specified attachment, including pages beyond the configured search indexing limit. Missing files and pages with no extractable text have explicit statuses.

The agent receives the returned metadata and text. Search queries use the embedding provider configured in the plugin.

## Index export and restore

The plugin stores its index in `<Zotero Data Directory>/zotero-vectorize/vectorize.sqlite`. It reads Zotero metadata and PDF text and writes its own index separately from Zotero’s library database and attachments.

Under **Vector Indexes**, select **Native SQLite Index** to export or restore a complete snapshot of the plugin index for the same Zotero library. It contains all saved model vectors, PDF passages, and indexing checkpoints. **Three-File Vector JSON** transfers one model index at a time for use with the skill. Keep these files together.

- `metadata_vectors.json`
- `fulltext_vectors.json`
- `vector_store_metadata.json`

When a legacy plugin index is in the same Zotero data directory, the plugin migrates it on startup. You can also import a closed legacy SQLite database from **Import Index → Native SQLite Index**. Legacy vectors are saved under their recorded model. If you know the active configuration matches the original model files and settings or the original API endpoint and version, choose **Reuse for Active Model** in the legacy index row, then let the plugin check for changes.

## Build from source

Install Node.js 22 or later and Python 3. Use `python` on Windows and `python3` on macOS and Linux. From the repository root, run:

```sh
npm ci
npm run verify
```

This checks types, builds and validates the XPI, and runs the tests. The installable package is `dist/zotero-vectorize.xpi`. To package without running the full verification suite, use `npm run package`.

For a two-device sync test with a small library, build `dist/zotero-vectorize-sync-test.xpi` with `npm run package -- --sync-test-small-parts`. This build uses 1 MiB parts.

[MIT License](LICENSE)
