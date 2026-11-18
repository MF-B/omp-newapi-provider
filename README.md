# omp-newapi-provider

为 [oh-my-pi](https://github.com/can1357/oh-my-pi) 动态发现 New API 网关和 Codex 上游的模型。插件按模型选择推理协议，并使用 OMP 管理凭据和缓存。渠道提供的明确参数和价格优先，缺失时参考 OMP 内置目录。

## 安装与使用

```sh
omp plugin install omp-newapi-provider
```

创建 `~/.omp/agent/omp-newapi-provider.json`，例如：

```json
{
  "services": [
    {
      "id": "my-gateway",
      "baseUrl": "https://gateway.example.com",
      "adapter": "newapi",
      "apiKey": "MY_GATEWAY_API_KEY"
    }
  ]
}
```

`apiKey` 是环境变量名。先在启动 OMP 的环境中设置该变量，再重启 OMP。原生 Codex 上游使用 `"adapter": "codex"`。

- `/newapi-refresh [provider]` 强制刷新模型列表。
- `/newapi-diagnostics [provider[/model]]` 查看发现结果和参数来源。

## 开发

源码在 `src/`，测试在 `test/`。使用 Node.js 22.18 或更新版本运行 `npm ci`、`npm test` 和 `npm run typecheck`。

在仓库目录运行 `omp plugin link "$PWD"` 可加载本地源码。
