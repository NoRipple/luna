# TODO

- [ ] Live2D 形象切换持久化：将当前“仅本次运行生效”的模型切换结果写回配置（如 `.env` 或独立运行时配置文件），并在下次启动自动恢复。
- [ ] 可能的演进方向（感知/对话解耦）：
  1. 新增 A（PerceptionStateStore）作为单一事实源，持有 `version/updatedAt/stateSummary/stateChanged/recentEvents` 等状态。
  2. 视觉识别服务保留现有准入流程，输出“当前状态描述 + 是否变化”，只写入 A，不直接驱动对话。
  3. 增加感知 Agent 定时任务：仅当 A 状态变化或达到触发间隔时发起 AI 交互，响应进入 TTS。
  4. 保留主 Agent 唯一用户会话：用户命令触发时读取 A 的最新状态与近期变迁再回复，多轮压缩主要在主 Agent。
  5. 主/感知共用统一锁与队列，确保同一时刻仅一个流与 LLM 交互，避免冲突与重复播报。
  6. 两条流都维护并消费 A，实现状态同步；后续再评估持久化与更细粒度优先级策略。
- [ ] 可能的演进方向（候选方案 v2，2026-03-25）：
  1. 总体：在不破坏现有 Live2D/TTS/面板能力前提下，逐步解耦“感知写状态”和“对话消费状态”。
  2. A（状态存储）建议字段：`version`、`updatedAt`、`stateSummary`、`stateDetail`、`stateChanged`、`changeReason`、`confidence`、`recentEvents(<=5)`、`lastTriggerAt`。
  3. MainAgent：维持唯一用户会话；每次用户输入仅“临时注入”A的最新快照和最近变更，不把整段状态包写回长期会话。
  4. PerceptionAgent：独立短会话；仅在 `stateChanged=true` 或命中心跳窗口时触发，避免无变化重复回复。
  5. 调度：统一 Orchestrator（互斥锁+队列+超时+优先级），Main 优先，Perception 可丢弃过期任务。
  6. 语音：Main/Perception 共用现有 TTS 队列，增加 `taskId/source/version` 便于追踪与排障。
  7. 分阶段落地：先加 A 和结构化状态，再接调度，再拆双 Agent，最后补监控与回归测试。
