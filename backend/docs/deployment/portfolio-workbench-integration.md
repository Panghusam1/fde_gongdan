# 展示站工作台接入与发布说明

## 当前结论

项目已经完成“本地真实联调”：原展示站增加独立多工单运营台，浏览器真实请求独立 Node.js 后端；后端提供13条项目评测/演示工单目录，其中五条受控场景每次从零执行迁移、业务工具和数据库留痕。它还不是“公网后端已上线”或“生产部署”。

| 层级 | 当前状态 | 准确口径 |
|---|---|---|
| 展示站页面 | 已实现并可静态导出 | 可以放入原作品集 |
| 独立演示接口 | 已实现并通过本地跨进程联调 | 只开放五个预设场景，不接受任意维修问题 |
| 展示站私有发布 | 可发布 | 未配置公网后端时按钮会明确禁用 |
| 公网可运行演示 | 未完成 | 需要一个 HTTPS 后端地址 |
| 生产系统 | 未完成 | 仍缺正式 PostgreSQL、鉴权、限流、监控、备份和真实业务数据 |

## 架构和数据流

```text
作品集静态页面
  ├─ GET /api/work-orders
  │   └─ 读取12条冻结评测工单 + 1条来源不匹配演示记录
  └─ 用户选择五条白名单场景之一
      └─ POST /api/demo
          └─ 独立 Node.js 演示服务
              ├─ 校验网页来源和场景白名单
              ├─ 调用 runProjectDemoScenario
              ├─ 从零创建 PGlite 数据库并执行迁移
              ├─ 跑权限、工单、检索、证据、风险、方案或人工接管
              └─ 返回所选场景的终态、模型调用和七类数据库计数
```

页面不保存模型密钥，不在浏览器伪造结果，也不允许用户提交任意维修问题。连接失败时直接显示“后端不可用”，不能回退成假成功。

## 为什么使用独立后端

原作品集采用 Next.js `output: "export"`，构建后只有 HTML、CSS 和 JavaScript。Next.js 官方文档明确说明，静态导出没有运行时服务，依赖请求内容的动态接口、代理和其他服务端能力不可用。因此没有把演示接口硬塞进展示站路由，而是保留静态作品集，把工单执行放到独立服务。

备选方案：

1. 浏览器内写死结果：开发最快，但无法证明数据库和主链真实运行，否决。
2. 改造整个作品集为服务端站点：可以承载接口，但扩大原站部署面和故障范围，本阶段没有必要。
3. 静态展示站加独立后端：前端发布方式不变，业务代码、密钥和数据库仍留在服务端，本项目选择该方案。

这种分离方式不是本项目自创。Spotify 的 Release Manager Dashboard 使用 React/TypeScript 前端，并建立独立后端统一约十个系统的数据；Shopify 的 Hydrogen 也通过 Storefront API 支撑定制前端，并在 Linkpop、Shopify Supply 等内部产品中验证。外部案例只证明“前端展示与后端能力分离”是成熟方法，不证明本项目具备 Spotify 或 Shopify 的规模与可靠性。

## 本地运行

后端：

```powershell
cd projects\04-atv320-workorder-agent
$env:ATV320_DEMO_PORT = '8788'
$env:ATV320_ALLOWED_ORIGINS = 'http://localhost:3000'
npm.cmd run serve:demo
```

前端：

```powershell
cd website
Copy-Item .env.example .env.local
npm.cmd run dev
```

打开 `/projects/atv320-workorder-agent/workbench`。

## 公网发布前必须补齐

1. 选择支持 Node.js 和该项目资源体积的后端托管环境；
2. 部署后得到 HTTPS 地址；
3. 后端 `ATV320_ALLOWED_ORIGINS` 只允许正式展示站域名；
4. 展示站构建前把 `NEXT_PUBLIC_ATV320_API_URL` 设置为该 HTTPS 地址；
5. 重新构建和发布展示站；
6. 从公网分别验证正常闭环、高危输入、证据不足、未授权厂区、来源不匹配、非法来源、非法场景和超时；
7. 若从“受控演示”升级为用户自由输入，必须另做鉴权、限流、请求大小限制、成本上限、滥用防护和正式数据隔离，不能直接开放现有接口。

## 一手资料

- Next.js 官方静态导出说明：https://nextjs.org/docs/app/guides/static-exports
- Next.js 官方前后端接口说明：https://nextjs.org/docs/app/guides/backend-for-frontend
- Spotify 工程团队的 Release Manager Dashboard：https://engineering.atspotify.com/2026/2/how-we-release-the-spotify-app-part-2
- Shopify 工程团队的 Hydrogen 实践：https://shopify.engineering/how-we-built-hydrogen

这些资料分别由框架维护方和案例实施企业发布；它们对各自框架能力和内部业务实践是一手资料。最终选型仍由本项目的静态导出约束、安全边界和演示目标决定。
