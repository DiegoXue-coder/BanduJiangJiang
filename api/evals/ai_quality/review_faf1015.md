# `faf1015` AI 当前阅读依据改动只读复核

复核对象：已提交的 `faf1015 fix: ground reader AI answers in visible text`。本报告只基于该提交内容，不把工作区后续未提交修改算入结论，也没有修改任何生产文件。

## Findings

### [P1] 苏格拉底模式会丢弃已构造的当前正文上下文

位置：`api/main.py:2523-2528`、`api/main.py:2631-2643`（均以 `faf1015` 为准）。

`_prepare_ask` 已通过 `_build_book_context` 构造包含 `pageText`、书名、章节、稳定位置和记忆的 `context_block`，并拼成 `user_message`；但 `_build_ask_messages` 的 `socratic` 分支完全不使用 `user_message`。第一轮有划线时只发送原始 selection，第一轮无划线及后续轮次只发送 question/history。

因此用户在阅读页未划线、切换到“苏格拉底”后提问时，移动端虽然成功提取并上传当前可视正文，后端也可能在完成事件返回 `evidenceType=current_context`，模型实际却没有收到当前正文。这会让机器元数据与真实模型输入不一致，也意味着本轮 T1 对苏格拉底入口没有生效。

建议后续由生产线修复并增加确定性测试：至少证明“苏格拉底 + 无划线 + pageText”最终 messages 含当前正文；有划线时继续保持 selection 为主要依据。该问题本轮仅报告，未修改生产代码。

### [P2] `evidenceType` 表示“可用输入依据”，不是“模型实际采用的依据”

位置：`api/main.py:2678-2681`、`api/main.py:2762-2765`（以 `faf1015` 为准）。

接口直接返回 `_build_book_context` 根据非空字段推导出的类型，没有观测模型是否真正使用该内容。普通讲解模式下它可作为“后端提供了哪类上下文”的稳定元数据，但字段名容易被客户端或评测误读为“回答已经以该证据为依据”；在上述苏格拉底缺陷下尤其会产生错误信号。

建议语义上命名为 `availableEvidenceType`，或同时返回 `availableEvidenceType` 与经过独立验证后才可声称的回答依据。评测 adapter 同时兼容 `evidenceType` 和 `availableEvidenceType`，但评分时只把它当作后端上下文元数据，不把它当成回答真实性证明。

状态更新：该问题已在本复核进行期间由后续提交 `f59eb25` 改名为 `availableEvidenceType` 并补充兼容测试；P2 对当前 `main` 已解决，P1 仍存在。

## 已确认符合预期

- 标准阅读把当前分页 `curPageBlocks` 经 `standardBlocksToContext` 转成正文；图片被排除，标题、正文和表格文本被保留，没有发送整章。
- EPUB 路径遍历 rendition 当前 contents 的可视文本节点，过滤脚本/样式节点，并在 1.2 秒未返回时以空 `pageText` 降级打开聊天面板。request id 检查可忽略超时后的迟到结果及旧请求结果。
- 有 selection 时，后端先放“用户明确划选（主要依据）”，当前页标为补充依据；普通 `simple` 模式最终 messages 会使用完整 `user_message`。
- `/ask` 新增 JSON 字段、`/ask/stream` 完成事件新增字段，原有 `answer`、`delta`、`done` 保持不变；旧客户端忽略新增字段即可继续消费。

## 未验证风险

- `faf1015` 的离线测试覆盖正文清洗和后端上下文拼装，但没有在真实 Android/iOS EPUB WebView 中验证不同 column/spread/iframe 排版下 `getClientRects()` 得到的文字是否恰好对应用户肉眼可见页面。
- 1.2 秒降级逻辑代码成立，但没有设备级慢机/大书计时数据；降级后会明确形成 `insufficient_context`，不会阻塞提问。
- 本复核没有调用真实模型或生产接口，不能据此判断回答质量已经提升。
