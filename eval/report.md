# Apolla Work 黄金场景评测报告

- 日期：(运行时)
- 模型：mock（确定性）
- 场景通过率：**10/10（100%）**
- 校验点通过：17/17
- 平均耗时：7ms

| 场景 | 名称 | 校验点 | 耗时 | 结果 |
|---|---|---|---|---|
| S1-finance-report | 财务数据 → 分析报告 | 2/2 | 28ms | ✅ |
| S2-data-clean-viz | CSV 清洗 → 汇总 | 2/2 | 19ms | ✅ |
| S3-html-page | 生成 HTML 页面产物 | 2/2 | 1ms | ✅ |
| S4-multi-file-summary | 多文件汇总 | 2/2 | 11ms | ✅ |
| S5-edit-file | 精确编辑已有文件 | 2/2 | 0ms | ✅ |
| S6-grep-search | 内容检索 | 2/2 | 7ms | ✅ |
| S7-skill-load | 技能加载（dataviz） | 1/1 | 0ms | ✅ |
| S8-plan-tracking | 计划跟踪 | 1/1 | 1ms | ✅ |
| S9-danger-blocked | 危险命令被拦截（auto 模式默认拒绝） | 1/1 | 0ms | ✅ |
| S10-steering | 路径安全（越界写入被拒） | 2/2 | 1ms | ✅ |

> mock 模型驱动的确定性评测：脚本经真实工具/Python 执行，校验点针对真实产物断言。
> 生产替换为工具调用型 LLM 后，脚本改为自然语言 prompt，校验点复用。
