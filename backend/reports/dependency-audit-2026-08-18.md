# 生产依赖安全审查记录

- 执行日期：2026-08-18
- 命令：`npm audit --omit=dev --json`
- 结果：0项严重、4项高危、0项中危、0项低危
- 自动修复：当前报告均为`fixAvailable: false`

## 风险链

1. `@huggingface/transformers → onnxruntime-node → adm-zip`
   - 公告：[GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)
   - 内容：特制ZIP可触发约4GB内存分配，属于拒绝服务风险。
2. `@huggingface/transformers → sharp`
   - 公告：[GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
   - 内容：`sharp`继承底层图像处理库的多项漏洞。

## 当前暴露面

本阶段只执行固定模型的文字向量，不接收用户上传的ZIP或图片。模型仓库、精确版本和模型文件SHA-256均已固定并核对。这会缩小攻击入口，但不会修复依赖本身。

## 上线前要求

- 跟踪并升级到包含上游修复的运行时；或
- 更换嵌入推理运行时；或
- 将嵌入服务置于网络、文件、内存和CPU均受限的独立进程，并继续禁止不可信压缩包和图片进入该依赖链。

在完成其中至少一项并重新审查前，不把当前本地依赖状态描述为可直接生产上线。
