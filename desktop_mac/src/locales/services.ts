import type { Catalog } from "../i18n.js";

export const servicesMessages = {
  // Updates and installation
  "svc.update.versionInvalid": { zh: "版本号格式不合法：{version}", en: "Invalid version number: {version}" },
  "svc.update.devMode": { zh: "开发模式下不做自动安装", en: "Automatic install is disabled in development mode" },
  "svc.update.translocated": {
    zh: "阿钉正从隔离位置运行（没有拖进「应用程序」就直接打开了），无法自动替换",
    en: "ADing is running from a quarantined location (it was opened without moving it to Applications), so it can't be replaced automatically"
  },
  "svc.update.fromVolume": { zh: "阿钉正从安装盘里运行，无法自动替换", en: "ADing is running from the installer disk, so it can't be replaced automatically" },
  "svc.update.noPermission": { zh: "没有权限替换 {bundle}", en: "No permission to replace {bundle}" },
  "svc.update.versionMismatch": {
    zh: "安装包里的版本是 {actual}，不是预期的 {expected}",
    en: "The installer contains version {actual}, not the expected {expected}"
  },
  "svc.update.unknown": { zh: "未知", en: "unknown" },
  "svc.update.unsigned": { zh: "未签名", en: "unsigned" },
  "svc.update.wrongIdentifier": { zh: "安装包的应用标识是 {identifier}，不是阿钉", en: "The installer's app identifier is {identifier}, not ADing" },
  "svc.update.teamMismatch": {
    zh: "安装包的签名团队 {next} 与当前 {current} 不一致",
    en: "The installer's signing team {next} doesn't match the current team {current}"
  },
  "svc.update.appCount": {
    zh: "安装包里应当恰好有一个 .app，实际 {count} 个",
    en: "The installer should contain exactly one .app, but it contains {count}"
  },
  "svc.update.checkFailed": { zh: "检查更新失败：{message}", en: "Couldn't check for updates: {message}" },
  "svc.update.downloadFailed": { zh: "下载更新失败：{message}", en: "Couldn't download the update: {message}" },
  "svc.update.serverStatus": { zh: "服务器返回 {status}", en: "Server returned {status}" },
  "svc.update.sizeAbnormal": { zh: "安装包大小异常", en: "Unexpected installer size" },
  "svc.update.checksumMismatch": {
    zh: "校验和不一致（期望 {expected}…，实际 {actual}…）",
    en: "Checksum mismatch (expected {expected}…, got {actual}…)"
  },
  "svc.update.badResponse": { zh: "更新服务返回格式不对", en: "The update service returned an invalid response" },
  "svc.update.badVersion": { zh: "更新服务返回的版本号不合法", en: "The update service returned an invalid version number" },
  "svc.update.badUrl": { zh: "更新服务返回的下载地址不合法", en: "The update service returned an invalid download URL" },
  "svc.update.httpsRequired": { zh: "安装包必须通过 https 下载", en: "The installer must be downloaded over HTTPS" },
  "svc.update.badChecksum": { zh: "更新服务返回的校验和不合法", en: "The update service returned an invalid checksum" },

  // Account
  // Both Chinese and English UIs show English here (user request)
  "svc.account.regionUnavailable": { zh: "不支持的地区", en: "Unavailable region" },
  "svc.account.network": { zh: "连不上阿钉服务器，请检查网络后重试", en: "Can't reach the ADing server. Check your network and try again." },
  "svc.account.server": { zh: "服务器暂时不可用，请稍后再试", en: "The server is temporarily unavailable. Please try again later." },
  "svc.account.usernameRequired": { zh: "请输入用户名", en: "Enter a username" },
  "svc.account.passwordRequired": { zh: "请输入密码", en: "Enter a password" },
  "svc.account.usernameTooLong": { zh: "用户名不能超过 64 个字符", en: "Username can't exceed 64 characters" },
  "svc.account.notSignedIn": { zh: "还没有登录", en: "Not signed in yet" },
  "svc.account.sessionChanged": { zh: "登录状态已变化", en: "Sign-in status has changed" },
  "svc.account.computerNotRegistered": { zh: "这台电脑还没有登记", en: "This computer isn't registered yet" },
  "svc.account.requestFailed": { zh: "请求没有成功，请稍后再试", en: "The request didn't succeed. Please try again later." },
  "svc.account.noHardwareUuid": { zh: "读不到这台电脑的硬件 UUID", en: "Couldn't read this computer's hardware UUID" },

  // Support
  "svc.support.subjectRequired": { zh: "请填写主题", en: "Enter a subject" },
  "svc.support.contentRequired": { zh: "请填写内容", en: "Enter a message" },
  "svc.support.imageFormat": { zh: "不支持的图片格式：{type}", en: "Unsupported image format: {type}" },
  "svc.support.unknownType": { zh: "未知", en: "unknown" },
  "svc.support.imageInvalid": { zh: "{name} 的图片数据无效", en: "Image data for {name} is invalid" },
  "svc.support.imageTooLarge": { zh: "{name} 不能超过 5 MB", en: "{name} can't exceed 5 MB" },
  "svc.support.timeRequired": { zh: "请选择发生时间", en: "Choose when it happened" },
  "svc.support.descriptionTooShort": { zh: "请至少用 5 个字描述问题", en: "Describe the problem in at least 5 characters" },
  "svc.support.descriptionTooLong": { zh: "问题描述不能超过 4000 个字", en: "The description can't exceed 4,000 characters" },
  "svc.support.tooManyImages": { zh: "最多可以添加 {max} 张图片", en: "You can add up to {max} images" },
  "svc.support.tooManyAttachments": { zh: "最多可以添加 {max} 个附件", en: "You can add up to {max} attachments" },
  "svc.support.attachmentsTooLarge": { zh: "附件总大小不能超过 15 MB", en: "Attachments can't exceed 15 MB in total" },
  "svc.support.imagesTooLarge": { zh: "截图总大小不能超过 15 MB", en: "Screenshots can't exceed 15 MB in total" },

  // Agent installation, sign-in, and detection
  "svc.agent.qoderSyncLabel": { zh: "同步账号", en: "Sync account" },
  "svc.agent.qoderSyncStatus": { zh: "模型未同步", en: "Model not synced" },
  "svc.agent.qoderSyncMessage": {
    zh: "请登录与 {label} 原应用相同的账号，完成后阿钉会自动重新检测所选模型。",
    en: "Sign in with the same account as the {label} app. ADing will then check the selected model again automatically."
  },
  "svc.agent.loginCancelled": { zh: "登录已取消", en: "Sign-in cancelled" },
  "svc.agent.loginInBrowser": {
    zh: "请在浏览器完成 {label} 登录，阿钉正在等待授权结果",
    en: "Finish signing in to {label} in your browser. ADing is waiting for authorization."
  },
  "svc.agent.loginPageFailed": { zh: "无法打开官方登录页面，请重试", en: "Couldn't open the official sign-in page. Please try again." },
  "svc.agent.cliNotInstalled": { zh: "{kind} CLI 尚未安装或不可执行", en: "{kind} CLI isn't installed or can't be run" },
  "svc.agent.noOutput": { zh: "没有返回说明", en: "No details returned" },
  "svc.agent.signedIn": { zh: "{name} 已登录", en: "{name} is signed in" },
  "svc.agent.signedOut": { zh: "{name} 未登录", en: "{name} is not signed in" },
  "svc.agent.removedBrokenShim": { zh: "已清理失效的 {name} 启动链接", en: "Removed a broken {name} launcher link" },
  "svc.agent.installNeedsConfirm": { zh: "安装会修改这台电脑，必须先由用户确认", en: "Installing changes this computer and must be confirmed by the user first" },
  "svc.agent.npmMissing": { zh: "没有找到 npm，需先安装 Node.js 后再安装 Agent", en: "npm wasn't found. Install Node.js before installing the Agent." },
  "svc.agent.installing": { zh: "正在安装 {name}", en: "Installing {name}" },
  "svc.agent.loginNeedsConfirm": { zh: "登录会打开厂商认证流程，必须先由用户确认", en: "Signing in opens the vendor's authentication flow and must be confirmed by the user first" },
  "svc.agent.loginStarting": { zh: "正在启动 {name} 登录", en: "Starting {name} sign-in" },
  "svc.agent.logoutTerminalOnly": {
    zh: "{name} 当前版本只支持在交互终端中输入 /logout",
    en: "This version of {name} only supports typing /logout in an interactive terminal"
  },
  "svc.agent.logoutNeedsConfirm": { zh: "退出登录会清除本机凭据，必须先由用户确认", en: "Signing out clears the credentials on this computer and must be confirmed by the user first" },
  "svc.agent.loggingOut": { zh: "正在退出 {name}", en: "Signing out of {name}" }
} as const satisfies Catalog;
