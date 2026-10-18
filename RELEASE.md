# 发布前检查

## 清单

- [x] `README.md` 说人话，含安装、使用、数据来源、兼容性
- [x] `LICENSE`（MIT）
- [x] `CHANGELOG.md`
- [x] `package.json`：`version`、`license`、`engines`、`files`、`peerDependencies`
- [x] 四个源文件语法检查
- [x] host/sampler 单测（15 条）
- [x] jsdom 客户端挂载测试
- [ ] 在干净 profile 里安装一次，确认能起来
- [ ] 与另一插件（如皮肤插件）同时启用，确认互不影响
- [ ] 深色 / 浅色宿主各截一张图
- [ ] 检查 `speed-gauge-attempts.jsonl*` 是否被打进包里（不应包含运行时数据）

## 兼容性

| 项 | 要求 |
|---|---|
| Node.js | >= 20（用到 `zlib.zstdDecompressSync` 之外的现代语法即可） |
| DSH | 需要 `webServer` 服务与 `llm/stream` 钩子 |
| React | 18，由宿主提供，不重复打包 |
| 浏览器 | 支持 OffscreenCanvas + Worker（Electron/Chromium 均可） |

## 与其他插件共存

- 面板与按钮的所有类名以 `dsg-` 开头，只作用于自己创建的节点；
- 唯一写进宿主 DOM 的地方是标题栏按钮，插在"智能体团队/标准模式"那一排的末尾；
- 关闭面板时保留 canvas 与 Worker，只是 `display:none`，不影响其它插件；
- 自定义路由只有 `/api/dsh-speed-gauge/*` 四个，均做了回环地址校验。

## 打包

```bash
npm pack --dry-run
```

确认 `files` 里不含 `shots/`、`test/`、`*.jsonl*`、备份文件。
