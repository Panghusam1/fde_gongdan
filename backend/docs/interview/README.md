# 项目面试题库

本目录持续保存每个项目阶段可能出现的面试问题。它不是事后包装材料，而是设计、实现、验证和复盘的同步记录。

## 每个阶段必须记录什么

1. 30秒和2分钟项目介绍；
2. 本阶段真实完成的功能；
3. 关键架构图和数据流；
4. 每项重要决定的问题、备选方案、选择理由和代价；
5. 使用了哪些一手资料，各自在什么范围内权威；
6. 数据正确性和安全性怎样验证；
7. 遇到的真实问题、定位过程和修复方式；
8. 哪些内容尚未实现，不能在面试中夸大；
9. 高频问题、追问和可验证证据；
10. 本阶段可以放进简历的准确表述。
11. 问题与调整台账：原计划、异常现象、定位证据、根因、调整、复测结果和仍有边界。

## 当前材料

- [阶段一：业务、数据库与可信资料入口](stage-01-business-database-trusted-source.md)
- [阶段二：知识片段分类与人工审核](stage-02-knowledge-classification-and-review.md)
- [阶段三：知识片段来源链](stage-03-knowledge-provenance.md)
- [阶段四：结构切片与页内精确证据](stage-04-exact-boundary-chunking.md)
- [阶段五：产品级知识审核与自动审计](stage-05-product-scoped-review-audit.md)
- [阶段六：固定版本E5与检索对照实验](stage-06-e5-hybrid-retrieval.md)
- [阶段七：工单范围检索工具与全过程留痕](stage-07-work-order-scoped-search-tool.md)
- [阶段八：确定性风险门、现场观察和人工接管](stage-08-risk-gate-observations-and-handoff.md)
- [阶段九：两版证据方案、现场确认和协调助手](stage-09-two-proposal-confirmation-and-coordinator.md)
- [阶段十：真实协调助手过程评测](stage-10-real-agent-trajectory-evaluation.md)
- [阶段十一：40题检索、拒答和二次排序](stage-11-forty-case-retrieval-and-reranking.md)
- [阶段十二：高危输入独立阻断](stage-12-input-risk-guard.md)
- [阶段十三：无答案阈值留出测试](stage-13-answerability-holdout.md)
- [阶段十四：自动化测试与准确率提升体系](stage-14-automated-testing-and-accuracy.md)
- [阶段十五：从相似度失败到证据存在性判断](stage-15-answerability-judge.md)
- [阶段十六：证据门接入工单主链路](stage-16-evidence-gate-main-chain.md)
- [阶段十七：封存四分支验收、保留失败与单变量提准](stage-17-frozen-multibranch-evidence-validation.md)
- [阶段十八：未见数据推翻旧结论、两阶段判断与标签审计](stage-18-unseen-eval-two-stage-judgment.md)
- [阶段十九：第三批未见数据、多证据标签与真实能力门通过](stage-19-new-unseen-multi-evidence-pass.md)
- [阶段二十：十二条端到端未见工单为什么失败](stage-20-end-to-end-unseen-failure.md)
- [阶段二十一：数据库状态绑定与已暴露缺陷回归](stage-21-state-bound-coordinator-regression.md)
- [阶段二十二：全新未见端到端能力门11/12](stage-22-new-unseen-end-to-end-pass.md)
- [阶段二十三：来源感知证据与U301真实回归](stage-23-source-aware-evidence-regression.md)
- [阶段二十四：第六版组件怎样真正进入正式主链](stage-24-formal-source-aware-main-chain.md)
- [阶段二十五：三轮来源身份未见失败与架构转折](stage-25-source-identity-unseen-and-architecture-pivot.md)
- [阶段二十六：结构化来源约束与第四批首次未见通过](stage-26-structured-source-constraint-pass.md)
- [阶段二十七：可运行演示与项目最终交付](stage-27-project-demo-and-final-handoff.md)
- [阶段二十八：第三天联调、部署与准确率优化](stage-28-day3-integration-deployment-accuracy.md)
- [阶段二十九：展示站工作台与独立后端联调](stage-29-portfolio-workbench-integration.md)
- [阶段三十：多工单现场演示与页面产品化](stage-30-multi-work-order-demo-productization.md)
- [阶段三十一：工单级证据绑定与可读性修正](stage-31-contextual-evidence-preview.md)
- [阶段三十二：证据状态配图生产与真实性边界](stage-32-evidence-state-visual-production.md)
- [项目简历定稿](project-resume-final.md)

## 更新规则

- 每结束一个可独立验收的阶段，就新增或更新一份阶段文件；
- 项目功能发生变化时，同时更新相关答案，不能让面试材料落后于代码；
- “计划采用”和“已经实现”必须分开写；
- 公司案例、产品能力和技术行为优先引用发布方、维护方或研究团队的一手资料；
- 外部案例只证明其自身做法，不能冒充本项目已经实现的功能；
- 测试数量、数据规模和性能结果必须来自实际运行记录。
- 问题不能只写“已经解决”，必须保留失败现象、排查路径、被否决方案和调整前后数据；
- 如果实际结果推翻原设计，面试材料必须明确写出“原设计为什么错、用什么证据推翻”，不能只保留最后方案。
