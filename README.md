# faith-chat — Chat with Christian

一个公开的信仰交流页面：陌生人可以进入公共交流室聊天，也可以私信"基督徒"进行一对一的信仰交流。

用来验证 Nexconn（融云）Chat API + SDK 的真实集成流程 —— 从服务端签名颁发 token，到浏览器端连接、进入公共聊天室（Open Channel）、发起私信（Direct Channel），是一次完整的端到端打通。

## 架构

- 前端：纯 JS + Vite 构建，使用 `@nexconn/chat` / `@nexconn/engine` 直接调用聊天 SDK（未使用 `@nexconn/chatui`，因为 Open Channel 不在其官方能力矩阵内）。
- 后端：Cloudflare Pages Functions（`functions/api/token.js`），负责用 App Secret 对请求签名并向 Nexconn 服务端换取 access token —— App Secret 永远不会出现在浏览器里。
- 两种身份：
  - **访客**：输入昵称即可进入，自动获得一个 `guest_xxxx` 的临时身份。
  - **基督徒本人**：输入访问口令（`CHRISTIAN_PASSCODE`）登录为固定身份 `christian`，可以看到所有访客私信并逐一回复。

## 本地开发

```bash
npm install
npx wrangler pages dev -- npm run dev
```

`.dev.vars`（已加入 .gitignore，不会被提交）中已经放好本地测试用的 App Key / App Secret / 访问口令。

## 部署

部署到 Cloudflare Pages：构建命令 `npm run build`，输出目录 `dist`。需要在 Cloudflare Pages 的环境变量（Secrets）中配置：

- `NEXCONN_APP_KEY`
- `NEXCONN_APP_SECRET`
- `CHRISTIAN_PASSCODE`
- `CHRISTIAN_USER_ID`（可选，默认 `christian`）
