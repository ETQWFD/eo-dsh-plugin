# EO助手 DSH 插件

DeepSeek Harness 插件：在设置中生成二维码，手机扫码后把每台手机映射为一个 DSH 会话；消息以 AES-256-GCM 密文经 relay 转发，并在工作区 `eo/` 下归档。

## 安装

```bash
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
```

安装后重启 `dsh web`，在“设置 → EO助手连接”填写 relayUrl（插件配置项），再生成二维码。

## 配置

```yaml
- id: eo-assistant
  config:
    relayUrl: https://your-relay.example.com
    assistantName: EO助手
    # provider/model 可选；不填则使用 DSH 当前默认模型
```

## 开发

```bash
npm install
npm run build:client   # 生成 lib/client.js（DSH 客户端模块）
```

`lib/client.js` 已提交，安装时不需要构建。阶段 1 仅支持文本；文件/语音/PPT 见阶段 2。
