# EO助手 DSH 插件

DeepSeek Harness 插件：在设置中生成二维码，手机扫码后把每台手机映射为一个 DSH 会话；文本与手机侧文件、语音、PPT 均以 AES-256-GCM 密文经 relay 转发，附件解密后归档到 `<workspace>/eo/`。

## 安装

```bash
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
```

重启 `dsh web`，打开 “设置 → EO助手连接”，生成二维码。首次需要在 profile 配置里填写 `relayUrl`：

```yaml
- id: eo-assistant
  config:
    relayUrl: https://your-relay.example.com
    assistantName: EO助手
    # provider/model 可选；不填使用 DSH 当前默认模型
    # workspaceDir 可选；默认当前工作目录
    # maxFileMB 可选；默认 50，实际受 relay MAX_BLOB_BYTES（默认 16MB）限制
```

## 能力

- 扫码绑定：桌面生成二维码 → 手机 claim → 桌面显示 6 位确认码 → 手机输入确认。
- 双向 E2EE 文本；每台手机一个 DSH Session `eo-<convId>`。
- 文件/语音/PPT：手机加密成独立 blob 上传，桌面下载、校验 SHA-256、保存到 `eo/<convId>/attachments/`，并把路径注入 DSH 会话。
- 名称/头像：桌面设置页修改后，relay 推 `profile` 通知，手机重新拉取头像；头像公开端点可读取，不要放敏感信息。
- 离线：relay 保存密文 backlog，重连后补收；重复 msgId 去重。

## 目录

```
<workspace>/eo/index.json
<workspace>/eo/<convId>/meta.json
<workspace>/eo/<convId>/messages.jsonl
<workspace>/eo/<convId>/attachments/
```

## 开发

```bash
npm install
npm run build:client   # esbuild -> lib/client.js，DSH 要求单文件 __ModuleLoader__ 包装
```

`lib/client.js` 已提交，安装时不需要构建；修改 `src/client/` 后必须重新构建并提交。

## 兼容性

- `engines.dsh`: `>=0.2.2-rc.2 <0.3.0`
- Node `>=24.9.0`
- 已在 DSH `0.2.2-rc.2` 验证阶段 1；阶段 2/3 的 relay 协议测试在 `eo-assistant` 仓库。

完整部署、验收与发布：见 [eo-assistant docs](https://github.com/ETQWFD/eo-assistant/tree/main/docs)。
