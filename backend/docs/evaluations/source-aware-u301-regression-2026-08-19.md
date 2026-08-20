# U301来源身份补全回归

## 结果

真实千问回归通过：同一 U301 问题从首跑的 `not_answerable` 变为 `directly_answerable`，引用 NVE41300 第 395 页连续原文；数据库风险判断为 `proposal_allowed`，人工接管 0。

该结果只证明已暴露根因得到修复，不修改 R282 的 11/12 首跑成绩，也不作为新未见准确率。

## 根因链

数据库原本保存：资料编号 `NVE41300`、版本 `05`、语言 `zh-CN`、页码 395 和逐字原文。旧证据候选进入判断器时只保留片段编号、章节标题、页码和正文，因此模型不能证明“这段正文属于用户指定的 NVE41300”。

## 实现选择

没有修改旧封存代码，也没有把资料编号写进提示词常量。新增两层版本化适配：

1. 来源感知工单判断器根据检索命中编号回查数据库来源链；
2. 第六版两阶段判断器把资料编号、版本和语言作为独立候选字段发送给模型。

如果候选编号不存在、重复或没有唯一来源，适配器在联网前失败。模型仍不能自己声明来源身份。

## 成熟产品参考

- [Amazon Bedrock Citation API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Citation.html)把来源文档标识、精确位置和引用内容作为可追踪结构返回；
- [Azure AI Search RAG](https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview)提供来源追踪、结构化引用和执行元数据；
- [Amazon Bedrock知识库检索](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)在检索结果中返回资料位置、元数据和相关性分数。

这些案例证明“正文片段必须和来源身份一起流转”是成熟知识系统的通用做法；它们不证明本项目已达到这些云产品的生产成熟度。

## 测试证据

- R284：真实数据库来源身份进入可控判断器；
- R285：两阶段模型请求均保留独立来源字段；
- R287：联网前封存旧报告、单一改动、测试入口和数据库链路；
- R286：真实千问已暴露回归通过。

- 首跑报告：`reports/qwen-work-order-end-to-end-holdout-v3-first-run.json`；
- 回归封存：`reports/source-aware-u301-regression-prerun.json`；
- 回归结果：`reports/qwen-source-aware-u301-regression-first-run.json`，SHA-256 `a5bc4377ca575107392270f3e697c9571296b983a49cec19039e4cf0fbee60e8`。

