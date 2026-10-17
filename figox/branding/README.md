# Figo Agent 图标草案

状态：用户已确认第七版，工作台、聊天头像、连接/登录画面、首次设置页、浏览器页签及桌面图标资源已统一切换为该版。第六版保留作历史草案，未重新生成桌面安装包。验证见[品牌图标接入与验收](../../docs/agent/modules/ui/2026-10-17-品牌图标接入与验收.md)。

## 发布资源

统一资源位于 `code/assets/`：`figo-agent-logo.png` 为 512×512，`figo-agent-favicon.png` 为 64×64，`figo-agent.icns` 包含 macOS 16 至 1024 像素图层。原始设计图继续保留在本目录，不把全部设计草案打入应用。

在 macOS 执行 `npm --prefix code run assets:icons`，使用系统 sips/iconutil 从第七版原图重建发布资源；其他平台直接使用已生成资源，无需运行生成脚本。图片缩放及格式转换不改变已确认的图形。

原图：[figo-agent-icon-v1.png](./figo-agent-icon-v1.png)。使用内置 image_gen 生成，透明外部背景，青绿圆角底板，白色 F 与终端前进符号融合，珊瑚色光标作为点缀。保留原图，不覆盖现有图标。

设计目标：保留工作台的青绿色识别，建立独立于通用代码图标的品牌标记，减少细节以适配小尺寸。实际 16/32 像素识别度、深浅底显示及 macOS Dock 效果尚未验收；确认方案后再制作发布尺寸并接入。

## 第七版：Agent 面孔主导

原图：[figo-agent-icon-v7-agent-first.png](./figo-agent-icon-v7-agent-first.png)。使用内置 image_gen 基于第六版编辑。用户反馈第六版的 Agent 标识不够突出，当前白色长蛇身占据大部分视觉面积，面罩仅是小细节。

改为大尺寸智能助手面孔、醒目的双眼显示屏与短蛇尾，保留珊瑚色分叉舌头。设计意图为“先识别智能助手，再识别嗅探特征”，不添加额外技术符号。尚未进行小尺寸或用户辨识测试，不将设计意图等同于验证结论。

第七版已由用户确认；`code/assets/` 与图标生成脚本现使用第七版，README 及界面共享同一发布资源。原图与先前版本继续保留。

### 第七版编辑提示词

```text
Use case: logo-brand. Redesign the referenced snake-agent icon so the AI AGENT identity is MUCH MORE prominent than the snake. Preserve only the petrol teal squircle, warm-white / deep-teal / coral color scheme and transparent exterior. Change the character proportions radically: a LARGE unmistakable digital assistant head occupying about TWO THIRDS of the character, with a SHORT curved snake tail/body taking the remaining lower third. It should read first as an intelligent assistant, then as a snake sniffing. Main head: a bold softly rounded near-square white shell, slightly wider than tall, facing mostly forward with a subtle turn toward the right. Inside the shell, a large clean dark-petrol face screen occupying most of the head, with exactly TWO large luminous-looking but non-glowing white vertical capsule eyes, friendly and attentive. Broad white bezel. This head is the main centered focal point, not a tiny visor on a long snake. A small mouth slit at the right lower edge of the head extends a short clearly visible CORAL FORKED SNAKE TONGUE toward the right. The head is organically connected to ONE short thick white curved snake body tucked below it, gently sweeping toward the lower-left and tapering into a short tail. No long giant S, no multiple loops, no large coil competing with the face, no detached head. A single unified 'sniffing AI agent' mascot. Sophisticated and calm, not baby-like. Very simple large geometric shapes and excellent negative space. Almost-flat premium app logo, subtly rounded material edges, no texture. All content safely inside the tile with generous margin around tongue. Teal #008697, warm white #FFFDF8, deep petrol face screen, coral #F17766 tongue. No text, letters, F, stars, chips, brain, circuit diagrams, network lines, data packets, antenna, headphones, limbs, scales, fangs, eyebrows, extra eyes or tiny mechanical details. No watermark, no UI, no mockup board. Single finished square macOS-style icon, true transparent alpha outside the tile.
```

## 第六版：嗅探型 Agent

原图：[figo-agent-icon-v6-snake-agent.png](./figo-agent-icon-v6-snake-agent.png)。使用内置 image_gen 基于第五版编辑，保留简洁蛇身、珊瑚色分叉舌头、青绿底板及透明外部背景。

蛇头内融入一个深青色面罩与两条白色眼睛，作为数字助手的视觉线索；蛇身与吐信继续表达嗅探。整个标记仍是一个角色，不增加独立机器人、文字、连线或技术字段。Agent 的自主执行能力无法由图形直接证明，当前仅表达智能助手的品牌形象，辨识度与小尺寸效果仍需确认和验收。

### 第六版编辑提示词

```text
Use case: logo-brand. Edit the supplied minimal snake icon into a single cohesive SNAKE AGENT mascot logo. Preserve the beautiful simple broad warm-white flowing S-shaped snake body and tapered tail, coral forked tongue, teal macOS squircle, generous spacing, overall balanced silhouette, face-on icon framing and transparent alpha outside the tile. The meaningful change is the HEAD: integrate a minimal intelligent-assistant face into the snake's own head, not a separate robot. Make the head a softly rounded, compact, slightly right-facing three-quarter capsule, connected naturally to the existing snake neck. Within its white head silhouette place ONE simple deep-teal rounded visor inset containing exactly TWO short warm-white vertical capsule eyes. These two calm attentive eyes should give a clear digital-agent / helpful AI assistant personality. Keep enough white head outline around the visor. Retain the coral forked tongue extending from a tiny mouth at the lower-right snout edge, below the visor, so the snake sniffing concept stays immediately visible. The character is an observant intelligent software assistant with a snake body: curious, alert, friendly, capable; not a threatening reptile, not a toy, not a human-headed snake. Entire logo uses only the white body/head, one dark-teal visor, two white eye strokes and one coral forked tongue. No mechanical details, helmet accessories, seams, headphones, antenna, fangs, scales, eyebrows, extra eyes, arms or legs. No separate robot icon, no chip, no brain, no stars, no network paths, no trace nodes, no data packet, no letters, no words, no watermark. Foreground remains very simple with strong negative space and broad clean curves for small-size readability. Almost-flat premium contemporary app branding, extremely restrained depth only. Teal #008697, warm white #FFFDF8, dark petrol teal visor, coral #F17766 tongue. Deliver one standalone finished app icon, not a design board.
```

## 第五版：蛇吐信嗅探

原图：[figo-agent-icon-v5-snake.png](./figo-agent-icon-v5-snake.png)。使用内置 image_gen 编辑，沿用青绿底板与透明外部背景，移除捕获框及信息块。

白色弯曲蛇身、侧面蛇头与珊瑚色分叉舌头表达“嗅探”。不再附加字母、数据包、Trace 连线或协议字段；不使用獠牙及鳞片细节。该造型方向由用户指定，当前是待确认的视觉草案，小尺寸与实际应用图标验收尚未执行，先前版本均保留。

### 第五版编辑提示词

```text
Use case: logo-brand. Redesign the foreground of the supplied app icon into ONE simple snake sniffing with its forked tongue. Reference image is only for petrol teal rounded-square macOS tile, transparent outer background and restrained premium finish. Remove ALL existing capture brackets and message tile. NO letter F or any typography. New symbol: a bold warm-white snake silhouette, formed by a single relaxed flowing S-shaped body with a tapered tail at lower left and a gently rounded side-profile head facing right at upper right. The snake extends a clearly visible short coral-red forked tongue horizontally into the open space at the right. The tongue is the only coral accent, with a clean two-pronged Y tip. One small petrol-teal eye, a minimal mouth seam if necessary, no other facial details. Read as an alert, curious, calm snake sensing its surroundings, not attacking. Keep the body simple, broad and unbroken, with generous open gaps rather than tightly coiled loops. Logo-like custom silhouette, not a detailed animal illustration. Visually balanced centered symbol occupying around 60 percent of the teal tile, ample safe padding including tongue. Rounded confident geometric curves, strong small-size readability. Sophisticated friendly productivity-tool identity, almost-flat logo with extremely subtle material finish matching the tile. Teal #008697, warm off-white #FFFDF8, tongue coral #F17766. No fangs, no exposed open jaws, no threatening posture, no cobra hood, no scales, no spots, no limbs, no extra snakes, no realistic reptile texture, no cuteness accessories, no eyes with highlights, no circuits, no network nodes, no packet symbols, no magnifier, no glow, no text, no watermark. Face-on orthographic single app icon, not a mockup board. Preserve genuine transparent alpha outside the squircle tile.
```

## 第四版：只表达捕获记录

原图：[figo-agent-icon-v4-capture.png](./figo-agent-icon-v4-capture.png)。使用内置 image_gen 编辑，参考第三版的底板与配色，完全移除 F 字母。

两侧白色括号形成捕获范围，中间珊瑚色信息块代表被捕获的交互记录，内部仅保留两条宽白线。移除 Trace 节点、连线和字母，仅以“信息被框住”表达捕获，不要求用户理解技术协议。保留透明外部背景及先前版本。

本版仅为设计草案，不宣称用户已理解含义，也未完成小尺寸、浏览器页签及 Dock 验收。

### 第四版编辑提示词

```text
Use case: logo-brand. Redesign this app icon completely around one simple concept: capturing an interaction / packet capture. Reference image is for the petrol teal squircle, restrained material finish and warm coral palette ONLY. Remove the F entirely. NO letter, monogram, typography or terminal symbol anywhere. The foreground is one large, instantly understandable capture symbol: two bold off-white inward-facing square capture brackets, left and right, enclosing one centered coral rounded rectangular message/data tile. Each bracket is a simple vertical stroke with short inward horizontal ends, comfortably separated from the coral tile. The tile has just two broad short off-white horizontal bars, no tiny text. The enclosed coral message/data tile should look held and selected by the white brackets, visually communicating 'this interaction has been captured'. Only these three main shapes, minimal geometric forms, consistent friendly radii, exact optical balance. Brackets and coral tile together fill about 55 percent of the colored tile width. Ample uncluttered negative space. Strong icon-scale readability and recognizable simple silhouette; polished contemporary productivity app, not a technical diagram. Almost-flat face-on appearance with very restrained edge depth. Retain petrol teal #008697 tile, warm off-white symbol and coral #F17766 accent. Genuine transparent alpha outside the macOS rounded-square tile. No F, no G, no letters, no arrows, no network paths, no trace nodes, no connected circuits, no detailed protocol fields, no magnifier, no camera lens, no barcode, no shipping parcel box, no brain, no robot, no stars, no glow, no extra decorative marks, no watermark, no surrounding UI or presentation board. Output one standalone finished app icon.
```

## 第三版：F 与观察点

原图：[figo-agent-icon-v3-minimal.png](./figo-agent-icon-v3-minimal.png)。使用内置 image_gen 基于第一版编辑。移除终端切口、追踪连线、节点和数据包细节，仅保留连续白色 F 与一个珊瑚色圆点。

用户反馈：第二版太复杂，一般人看不懂。设计调整：品牌识别优先，抓包与 Trace 不再按字面绘制，仅以观察/记录指示点作为寓意，不要求用户理解协议或链路图。该寓意不是用户理解测试的结论；实际小尺寸和 Dock 验收仍未执行。

### 第三版编辑提示词

```text
Use case: logo-brand. Simplify the supplied Figo Agent app icon dramatically for a general nontechnical audience. One strong white F plus one coral circular dot, nothing else. Preserve the petrol teal squircle tile, overall face-on square framing, restrained premium surface finish and genuinely transparent outside background. Redraw the F as one continuous, bold, immediately recognizable uppercase F, with a broad vertical stem and two clean horizontal bars; gently rounded corners and subtly angled right terminals give an original contemporary identity. Remove the chevron-shaped split, all internal notches and disconnected white pieces. Keep the F optically centered slightly left to balance a single solid coral circle in the open lower-right space. The circle is a quiet observation/recording indicator, not an eye, camera, lens or button. No lines connect the dot to the F. White F and coral dot must be the only foreground elements. Very strong silhouette, abundant negative space, tiny-size legibility, clean logo geometry, softer almost-flat rendering than the reference, minimal tonal shading, no glow. Teal #008697, warm white #FFFDF8, coral #F17766. Absolutely no paths, trace nodes, network diagrams, circuit tracks, packet rectangles, request-response slots, arrows, labels, words, micro-details, robots, stars, sparkles, magnifier, watermark or surrounding mockup. Deliver one finished minimal app icon, not a comparison board. Preserve transparent alpha outside the tile.
```

## 第二版：加入抓包与 Trace

原图：[figo-agent-icon-v2-trace.png](./figo-agent-icon-v2-trace.png)。使用内置 image_gen 编辑第一版，保留 F、终端前进符号、青绿底板与透明外部背景。

- F 中横延伸的连线及节点：表达执行步骤之间的关联与追踪。
- 珊瑚色数据块：表达被捕获、可供检查的交互记录。
- 数据块内两条白线：设计寓意为请求与响应，不是实际协议字段。

视觉方向从“代码执行”扩展为“代码执行过程可观测”。不增加文字、放大镜或完整流程图。第二版增加了细节，实际小尺寸辨识度尚未验收；当前仅作方案比较，不宣称 16/32 像素已可用。

### 第二版编辑提示词

```text
Use case: logo-brand. Edit the supplied Figo Agent icon into a refined v2 incorporating packet capture and execution tracing. Preserve the established centered white F monogram, the forward-chevron negative space, petrol teal squircle tile, coral accent, face-on framing, generous padding and understated dimensional finish. Preserve actual transparent alpha outside the tile. Intent: a coding agent whose interactions are inspectable and traceable. Make a single cohesive brand mark, not a diagram or a collection of feature icons. Evolve the F's middle horizontal arm into the start of a short, very bold white trace path: it turns down once, passes through at most two clearly spaced circular checkpoint nodes, and terminates in the coral packet in the lower-right negative space next to the F stem. The trace must be visually integrated with the F, not wrapped around the entire monogram. Evolve the existing coral cursor square into a slightly wider compact data-packet tile with only two thick short off-white horizontal slots, suggesting a captured request and response. Keep the coral packet small enough that the F is still unquestionably the main silhouette. One connected route only, no branching network. Use very few large shapes, strong negative space, clean polished edge geometry and strokes thick enough for a small app icon. Teal #008697, warm off-white, coral #F17766. No labels, no words, no magnifier, no document sheet, no literal network hardware, no extra panels, no waveform, no fine circuit details, no microtext, no stars, no robot, no watermark. Output only the single finished square app icon, not a presentation sheet. Keep all design elements inside the tile.
```

## 第一版生成提示词

```text
Use case: logo-brand. Create one finished premium macOS application icon for Figo Agent, a coding agent and developer workbench. Deliver a single centered square app icon asset, not a presentation board or mockup. Concept: a bold, original geometric F monogram subtly fused with a terminal forward-chevron; a small warm coral cursor block at the lower right provides one restrained accent. Prioritize a readable F and a strong distinctive silhouette at 32 px. The F should be formed from only a few broad, meticulously aligned off-white shapes, with a small angular cut hinting at code execution and forward progress; avoid intricate disconnected pieces. Tile: rich petrol teal #008697 with very restrained dimensional edge treatment, softly rounded macOS squircle corners, almost-flat surface, clean contemporary developer-tool aesthetic. The F is warm white, the single cursor accent coral #F17766. Balanced optical centering and generous safe margins. Face-on orthographic view, no perspective. High-end precision, understated, confident, not cute. No robot, no brain, no stars, no sparkles, no circuit decoration, no text or words other than the F-shaped symbol, no drop shadow outside the tile, no extra icons, no surrounding UI, no device, no watermark. Make the area outside the rounded square genuinely transparent with alpha; retain the colored tile. Square composition at highest practical resolution.
```
