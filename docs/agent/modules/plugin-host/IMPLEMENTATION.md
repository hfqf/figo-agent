# PluginHost 实施计划

## 目标

实现静态插件注册、能力索引和能力查询，让 AgentLoop 只依赖插件能力契约。

## 文件

- `src/plugin/plugin-host.ts`
- `src/plugin/builtin-plugins.ts`
- `tests/plugin/plugin-host.test.ts`

## 实施步骤

1. 定义 CapabilityType、PluginManifest、Plugin、Capability。
2. 实现 `PluginHost.register(plugin)`。
3. 实现 `PluginHost.setupAll(context)`。
4. 建立 CapabilityRegistry。
5. 实现 `getCapability(type, name)`。
6. 实现 `getCapabilities(type)`。
7. 注册 V1 内置插件：LLM、Policy、Tool、Skill、Reporter、Memory、Context。
8. 插件注册写入 `plugin.registered`。
9. 插件 ready 写入 `plugin.ready`。
10. 能力注册写入 `capability.registered`。

## 依赖

- TraceRecorder。
- StorageManager。
- ReadOnlyPolicy。
- ToolRegistry。

## 不做

- 不做动态插件加载。
- 不扫描插件目录。
- 不做插件市场。
- 不做热插拔。
