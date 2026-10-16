# Trace Inspector 实施与验收入口

本次在原有 Turn 侧栏之外增加全屏只读检查器，流程地图的历史页面继续保留，不将其旧压缩图示当作 Pi 消息级实现。

入口：工作台顶部 Trace Inspector 图标，或分析侧栏中的对象跳转。左侧为统一事实表，右侧七个标签共享请求和摘要选择；上下文流优先展示文件 / SQLite、构建快照、摘要与保留消息、实际请求四个观察阶段。

- [实施说明](../../../docs/agent/modules/ui/trace-inspector/IMPLEMENTATION.md)
- [实际测试与截图索引](../../../docs/agent/modules/ui/trace-inspector/ACCEPTANCE.md)
- [桌面上下文流运行截图](../../../docs/agent/modules/ui/trace-inspector/assets/acceptance-2026-10-16/1440-context-flow.png)
- [移动端上下文流运行截图](../../../docs/agent/modules/ui/trace-inspector/assets/acceptance-2026-10-16/390-context-flow.png)

图中的数据来自隔离 SQLite 夹具，不代表真实模型容量或压缩收益。实际是否放行以验收记录为准；本次不重新生成整套历史 HTML 流程地图。
