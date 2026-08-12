# Portfolio

本项目是一个本地运行的投资组合看板，后端使用 Go + SQLite，前端使用原生 HTML/CSS/ES Modules。

## 最快启动（Windows）

在 PowerShell 中进入仓库目录：

```powershell
cd D:\learn\portfolio
Set-ExecutionPolicy -Scope Process Bypass
.\run.ps1 -OpenBrowser
```

然后访问：<http://127.0.0.1:8889/assets/index.html>

脚本会自动：

- 检查 Go 是否已安装；
- 执行 `go test ./...`；
- 停止同端口上由本项目启动的旧进程；
- 启动 Go 服务；
- 使用 `-OpenBrowser` 时打开浏览器。

如果只想快速启动、跳过测试：

```powershell
.\run.ps1 -OpenBrowser -SkipTests
```

如果 8889 端口被其他程序占用，可以换端口：

```powershell
.\run.ps1 -Port 8890 -OpenBrowser
```

服务会通过 `PORTFOLIO_PORT` 环境变量读取端口，范围为 1024–65535。

## 手动启动

```powershell
go test ./...
go run .
```

停止服务：在运行服务的 PowerShell 窗口按 `Ctrl+C`。

运行数据位于 `assets/portfolio.db`，日志位于 `server.log`。服务只监听本机回环地址。

## 可选：每日资产记录脚本

```powershell
python .\record-nav.py .\assets\data.json
```

该脚本需要一个与持仓格式兼容的 JSON 文件，并会请求外部行情、汇率和基金净值接口。
