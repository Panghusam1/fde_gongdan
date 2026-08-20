# ATV320 变频器智能工单系统

这是一个面向设备生产、维修与组装厂商的本地可运行项目。系统围绕“确认厂区与设备—创建草稿工单—检索官方资料—判断证据与风险—生成处置方案或转人工—全过程留痕”展开。

仓库包含两个独立部分：

- `backend`：TypeScript、PGlite、pgvector、E5 检索与单协调助手工单主链路。
- `frontend`：Next.js 工单运营台，包含覆盖六个阶段的工单队列和五类受控现场演示。

## 本地启动

环境要求：Node.js 24 或更高版本；如需重新提取官方 PDF 页面，还需要 Python 3。

先启动后端：

```powershell
cd backend
npm.cmd install
npm.cmd run serve:demo
```

再开一个终端启动前端：

```powershell
cd frontend
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run dev
```

浏览器打开 `http://localhost:3000/`。默认后端地址是 `http://127.0.0.1:8788`。

## 验证

```powershell
cd backend
npm.cmd test

cd ../frontend
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

## 数据说明

- 官方资料的编号、版本、语言、网址、文件摘要和页码均保留来源链。
- 工单与厂区数据是项目评测和演示数据，不冒充客户生产记录。
- 原始厂商 PDF 不进入 Git 仓库；`backend/data/raw` 中仅保留目录占位。需要重新提取时，应从项目文档记录的官方来源下载，并核对 SHA-256。
- 真实百炼密钥只放本地环境变量。仓库仅提供空值示例文件。

项目架构、测试记录、准确率迭代、部署边界和面试问答详见 `backend/docs`。
