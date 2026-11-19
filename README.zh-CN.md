# Zotero Vectorize

[English](README.md)

在 Zotero 中按语义搜索文献，找到 PDF 中的相关段落，再直接打开对应页面。Zotero Vectorize 是一款以本地运行为主的桌面插件，支持中文查英文文献、英文查中文文献。

## 安装与第一次搜索

1. 从 [GitHub Releases](https://github.com/yckbz/zotero-vectorize/releases) 下载 `zotero-vectorize.xpi`，也可以[从源码构建](#从源码构建)。
2. 在 Zotero 打开**工具 → 插件**，点齿轮图标，选择**从文件安装插件…**，选中下载的 XPI。
3. 打开 **Zotero 设置 → Zotero Vectorize**，点击**下载 / 校验本地模型**，安装默认的多语言 MiniLM 模型。首次下载需要联网，文件准备好后推理在本机运行。
4. 在 Zotero 顶部搜索框输入查询，或用 macOS 的 **⌘K**、Windows 或 Linux 的 **Ctrl+K** 打开命令面板。可选择**混合**、**元数据**或**全文段落**，并在全部文献和当前分类之间切换。选择结果中的段落即可打开对应的 PDF 页面。

在文献详情面板打开**语义相似文献**，可以查看库中与当前条目相关的文献。

跨语言语义检索使用所选的嵌入模型。在插件搜索设置中可开启**允许普通数字匹配上下标数字**，例如用 `x2` 查找 `x₂` 或 `x²`。

插件声明的最低版本为 Zotero 7.0。

## 索引

- 插件默认在后台建立索引。首次扫描时，已提取的文本可以先用于关键词检索。嵌入模型就绪后，插件可以生成向量并用于语义检索。
- 设置页按**已向量化 / 已索引**显示文献和分块数量。例如，分块显示 `0 / 100` 表示 100 个分块已可用文本检索，向量数为 0。切换模型后，可以点**立即增量索引**启动补建。
- PDF 默认**切片长度 1024 字符、重叠 128 字符、每份附件最多 64 页**。页数设为 **0** 可索引全部页面。调整切片或页数上限后，使用**全量重建索引**将新设置应用到已索引的 PDF。
- 大文献库首次建立向量索引需要时间。后续增量扫描会复用未变化的记录。

## 向量化引擎

| 引擎 | 设置方法 |
| --- | --- |
| **本地 ONNX / WASM**（默认） | 在插件设置中下载模型。默认使用多语言 MiniLM L12，推理在本机的 CPU Worker 中运行。 |
| **Ollama** | 启动 Ollama，选择服务端已安装的嵌入模型，并在插件设置中测试连接。默认服务地址为 `http://localhost:11434`。 |
| **OpenAI 兼容 API** | 填写 API 地址、密钥和嵌入模型。插件会将待向量化的文本发到所配置的服务。 |

不同模型的向量属于不同的嵌入空间。切换模型后，运行增量索引，让新模型为文献和分块生成对应的向量。

## 在 Agent 中使用 Zotero Vectorize

在 **Zotero 设置 → Zotero Vectorize → Agent 接入（MCP）** 中启用本机 MCP。点击**复制 Codex 配置**，将内容添加到用户级的 `~/.codex/config.toml`，然后重启 Codex。复制的配置包含访问令牌。使用期间请保持 Zotero 运行。

MCP 已在 macOS 的 Zotero 10.0.9 上验证。

`http://127.0.0.1:23124/mcp` 接收本机只读请求。`search_papers` 使用「我的文库」已有索引，返回题录、候选段落及 PDF 页链接，也可按准确的分类路径限定搜索范围。只有题录的条目仍可通过混合或元数据模式搜到。`read_pdf_pages` 从指定附件读取最多三页连续正文，可以读取超出搜索索引页数上限的页面。附件文件缺失或页面没有可提取文字时，会返回明确状态。

Agent 会收到工具返回的题录和正文。搜索查询使用插件当前配置的嵌入服务。

## 数据与 JSON 交换

插件索引保存在 `<Zotero 数据目录>/zotero-vectorize/vectorize.sqlite`。插件读取 Zotero 题录和 PDF 正文，将自己的索引与 Zotero 文献库数据库和附件分开存储。

skill 在命令行和代理工作流中使用同一套 JSON 索引格式。需要交换索引时，在插件设置中使用**标准向量 JSON 兼容导入与导出**，并将以下三个文件放在同一目录。

- `metadata_vectors.json`
- `fulltext_vectors.json`
- `vector_store_metadata.json`

## 从源码构建

安装 Node.js 22 或更新版本，并确保可以通过 `python3` 运行 Python 3。在仓库根目录执行：

```sh
npm ci
npm run verify
```

此命令会检查 TypeScript、构建并校验 XPI、运行测试。安装包位于 `dist/zotero-vectorize.xpi`。只构建安装包时，运行 `npm run package`。

[MIT 许可证](LICENSE)
