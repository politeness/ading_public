/**
 * The website's Terms of Service (terms.html) and Privacy Policy (privacy.html), generated and deployed together with the landing page.
 * App Store listing requires a privacy policy URL; the mobile login page links to the terms, which in turn link to the privacy policy.
 *
 * Terms of Service:
 *
 * App Store Review Guideline 1.2 requires apps where users can send content to each other to have user-accepted terms stating
 * zero tolerance for objectionable content and abusive users, plus reporting and blocking, with the developer acting on reports within 24 hours.
 * The mobile login page links to this page.
 * We use our own terms instead of Apple's standard EULA, so the minimum terms Apple requires must be appended at the end.
 *
 * Chinese and English are on the same page, English under #en. Change both languages together and update the effective date.
 * The privacy policy must match the data actually collected and stored: when the backend adds fields, analytics or third-party services, update it here.
 */

const EFFECTIVE = { zh: "2026 年 10 月 1 日", en: "October 1, 2026" };
const CONTACT = "politeness1983@sina.com";

const ZH = [
  ["一、协议范围", [
    "阿钉（ADing，以下称「本服务」）由个人开发者赵彬彬（BINBIN ZHAO，以下称「我们」）提供，包括阿钉电脑版、阿钉手机版和配套的云端服务。",
    "注册、登录或使用本服务，即表示你已阅读并同意本协议。不同意的，请不要使用本服务。"
  ]],
  ["二、账号", [
    "你需要年满 16 周岁，或达到你所在地法律规定的可以独立同意本协议的年龄，才能注册和使用联机功能。",
    "请提供真实信息并妥善保管账号和密码。以你的账号进行的操作，由你负责。发现账号被盗用，请尽快联系我们。",
    "不登录账号时，电脑版以单机方式运行，数据只保存在你的电脑上。"
  ]],
  ["三、服务说明", [
    "阿钉调用的是你自己在电脑上安装、并已登录的第三方 AI 工具（例如 Codex、Claude Code、Qoder）。这些工具的使用受各自提供方的条款约束，费用和额度也由它们收取和计算。",
    "手机版本身不运行 AI，它把你的消息交给登录同一账号、正开着的电脑版阿钉去执行。电脑离线时，消息会在电脑下次上线后处理。",
    "AI 生成的内容和执行的操作可能不准确、不完整，甚至造成数据改动。请在重要操作前自行核对，并做好备份。你对让 AI 执行的操作及其结果负责。"
  ]],
  ["四、用户内容和行为规范", [
    "你可以通过本服务和好友互发消息，也可以把任务交给自己的 AI。你发送和上传的内容由你负责。",
    "禁止利用本服务发布、传播以下内容，或从事以下行为：骚扰、辱骂、威胁他人；仇恨、歧视内容；色情内容，以及任何涉及未成年人的性内容；暴力、恐怖内容；诈骗、垃圾信息；侵犯他人知识产权、隐私或其他合法权益；违反你所在地或中华人民共和国法律法规的内容；试图入侵、干扰本服务或他人电脑。",
    "我们对违规内容和滥用行为零容忍。"
  ]],
  ["五、举报、拉黑和处理", [
    "在和对方的聊天中，可以通过「…」菜单举报或拉黑对方。拉黑后对方不能再给你发消息，也不能再添加你；你可以在「我 → 已拉黑的人」里解除。",
    "我们会在收到举报后 24 小时内处理。经核实违规的，我们会删除相关内容，并视情节暂停或永久停用违规账号。",
    `也可以发邮件到 ${CONTACT} 举报。`
  ]],
  ["六、自愿打赏", [
    "阿钉所有功能免费。手机版提供五档可重复购买的消耗型打赏，通过 Apple 的 App 内购买完成，由 Apple 向你的 Apple 账户收费。打赏不自动续费，不解锁功能，也不产生订阅权益。",
    "退款由 Apple 按其政策处理。打赏是自愿的赞助，不附带额外权益。"
  ]],
  ["七、个人信息", [
    "我们只为提供本服务收集必要的信息，例如账号、好友关系、会话和消息内容，不用于广告或跟踪。具体做法见《隐私政策》（privacy.html）。"
  ]],
  ["八、知识产权", [
    "本服务的软件、界面和标识归我们所有。你保留你发送的内容和 AI 为你生成的内容的权利，并授权我们在提供本服务所必需的范围内存储、传输和显示这些内容。"
  ]],
  ["九、免责和责任限制", [
    "本服务按现状提供。在法律允许的范围内，我们不对服务不中断、无错误，或 AI 输出的准确性作出保证；对因使用或无法使用本服务造成的间接损失不承担责任。",
    "以上限制不影响你所在地法律赋予消费者、且不能通过约定排除的权利。"
  ]],
  ["十、终止", [
    "你可以随时停止使用本服务。你违反本协议的，我们可以暂停或终止你的账号。"
  ]],
  ["十一、关于 Apple", [
    "如果你通过 Apple App Store 获取阿钉手机版，还适用以下条款：",
    "本协议仅在你和我们之间订立，Apple 不是本协议的一方，不对手机版及其内容负责。",
    "你对手机版的使用许可，限于在你拥有或控制的 Apple 设备上、按 App Store 使用规则使用，不可转让。",
    "Apple 没有义务为手机版提供任何维护和支持服务。",
    "手机版不符合任何适用的保证时，你可以通知 Apple，Apple 会将手机版的购买价款（如有）退还给你；在法律允许的最大范围内，Apple 对手机版不承担其他保证义务。",
    "与手机版有关的任何索赔（包括产品责任、不符合法律法规要求、消费者保护、隐私等方面的索赔），由我们而不是 Apple 负责处理。",
    "第三方主张手机版或你对它的使用侵犯其知识产权的，由我们而不是 Apple 负责调查、抗辩、和解和解决。",
    "你声明并保证：你不在受美国政府禁运或被其列为「支持恐怖主义」的国家或地区，也不在美国政府的任何禁止或限制交易方名单上。",
    "Apple 及其子公司是本协议的第三方受益人。你接受本协议后，Apple 有权作为第三方受益人对你执行本协议。"
  ]],
  ["十二、适用法律和争议解决", [
    "本协议适用中华人民共和国法律（不含冲突法规则）。争议先友好协商；协商不成的，提交我们住所地有管辖权的人民法院解决。这不影响你所在地强制性法律赋予你的权利。"
  ]],
  ["十三、协议变更和联系方式", [
    "我们可能更新本协议，重大变更会在 App 内或官网提示。变更后继续使用本服务，视为同意新的协议。",
    `联系我们：${CONTACT}`
  ]]
];

const EN = [
  ["1. Scope", [
    "ADing (the \"Service\") is provided by independent developer BINBIN ZHAO (\"we\", \"us\") and includes ADing for Mac, ADing for iPhone and the related cloud service.",
    "By signing up for, signing in to or using the Service, you agree to these Terms. If you don't agree, don't use the Service."
  ]],
  ["2. Your account", [
    "You must be at least 16, or old enough under the laws where you live to agree to these Terms yourself, to sign up and use online features.",
    "Give accurate information and keep your account and password safe. You're responsible for everything done with your account. Contact us promptly if it's compromised.",
    "Without an account, ADing for Mac runs standalone and keeps your data only on your computer."
  ]],
  ["3. The Service", [
    "ADing works with third-party AI tools that you install and sign in to on your own computer (such as Codex, Claude Code and Qoder). Their use is governed by their providers' terms, and their providers set their own fees and quotas.",
    "ADing for iPhone doesn't run AI itself. It hands your messages to ADing for Mac, running and signed in to the same account. If the computer is offline, messages are handled when it comes back online.",
    "AI output and actions may be inaccurate or incomplete, and may change your data. Check before important operations and keep backups. You're responsible for the actions you ask AI to take and their results."
  ]],
  ["4. Your content and conduct", [
    "You can message your friends through the Service and give tasks to your own AI. You're responsible for what you send and upload.",
    "You may not use the Service to post, share or engage in: harassment, abuse or threats; hateful or discriminatory content; sexual content, and any sexual content involving minors; violent or terrorist content; fraud or spam; infringement of others' intellectual property, privacy or other rights; content that breaks the laws where you live or the laws of the People's Republic of China; or attempts to break into or disrupt the Service or anyone's computer.",
    "We have zero tolerance for objectionable content and abusive users."
  ]],
  ["5. Reporting, blocking and enforcement", [
    "In a chat, use the \"…\" menu to report or block the other person. Once blocked, they can't message you or add you again. You can unblock them in Me → Blocked.",
    "We act on reports within 24 hours. When a violation is confirmed, we remove the content and suspend or permanently disable the offending account, depending on severity.",
    `You can also report by email to ${CONTACT}.`
  ]],
  ["6. Voluntary tips", [
    "Every ADing feature is free. ADing for iPhone offers five repeatable consumable tips as In-App Purchases charged to your Apple Account by Apple. Tips do not renew automatically, unlock features or provide subscription benefits.",
    "Refunds are handled by Apple under its policies. Tips are voluntary support and don't unlock anything extra."
  ]],
  ["7. Personal information", [
    "We collect only what we need to run the Service, such as your account, friends, conversations and messages, and never use it for advertising or tracking. See our Privacy Policy (privacy.html) for details."
  ]],
  ["8. Intellectual property", [
    "We own the software, design and marks of the Service. You keep your rights in what you send and what AI generates for you, and you allow us to store, transmit and display it as needed to provide the Service."
  ]],
  ["9. Disclaimers and limitation of liability", [
    "The Service is provided as is. To the extent permitted by law, we don't promise that it will be uninterrupted or error-free, or that AI output is accurate, and we aren't liable for indirect losses from using or being unable to use it.",
    "Nothing here limits consumer rights that the laws where you live don't allow to be excluded."
  ]],
  ["10. Termination", [
    "You can stop using the Service at any time. We may suspend or terminate your account if you break these Terms."
  ]],
  ["11. Apple", [
    "If you got ADing for iPhone from the Apple App Store, these terms also apply:",
    "These Terms are between you and us only, not Apple. Apple isn't responsible for the app or its content.",
    "Your license to the app is non-transferable and limited to using it on Apple devices you own or control, as allowed by the App Store Usage Rules.",
    "Apple has no obligation to provide any maintenance or support for the app.",
    "If the app fails to conform to any applicable warranty, you may notify Apple, and Apple will refund the purchase price (if any). To the maximum extent permitted by law, Apple has no other warranty obligation for the app.",
    "We, not Apple, are responsible for addressing any claims relating to the app, including product liability claims, claims that it fails to meet legal or regulatory requirements, and consumer protection or privacy claims.",
    "If a third party claims that the app or your use of it infringes their intellectual property, we, not Apple, are responsible for the investigation, defense, settlement and discharge of that claim.",
    "You represent that you aren't located in a country subject to a U.S. Government embargo or designated as \"terrorist supporting\", and that you aren't on any U.S. Government list of prohibited or restricted parties.",
    "Apple and its subsidiaries are third-party beneficiaries of these Terms, and once you accept them, Apple has the right to enforce them against you as a third-party beneficiary."
  ]],
  ["12. Governing law and disputes", [
    "These Terms are governed by the laws of the People's Republic of China, without regard to conflict-of-law rules. We'll first try to resolve disputes amicably; otherwise they go to the competent court where we are domiciled. This doesn't affect rights you have under mandatory laws where you live."
  ]],
  ["13. Changes and contact", [
    "We may update these Terms and will point out material changes in the app or on our website. Continuing to use the Service after a change means you accept the new Terms.",
    `Contact: ${CONTACT}`
  ]]
];

const PRIVACY_ZH = [
  ["一、我们是谁", [
    "阿钉（ADing，包括电脑版、手机版和配套的云端服务）由个人开发者赵彬彬（BINBIN ZHAO）提供，他是你个人信息的处理者。",
    `有任何关于个人信息的问题或请求，请发邮件到 ${CONTACT}。`
  ]],
  ["二、我们收集哪些信息", [
    "账号信息：用户名、密码（只保存加盐哈希，不保存明文）、显示名称；你在资料里填写的头像、手机号、邮箱。",
    "好友和会话：好友关系、好友申请、拉黑记录；你创建或参与的会话、会话成员、消息内容（包括你让 AI 执行的指令和 AI 的回复）、会话里的执行步骤、AI 的记忆、工作区名称。",
    "附件：你主动选取并发送的照片、视频和文件，以及文件名、类型和大小。联机发送时，文件会上传到阿里云对象存储，供会话成员和处理该会话的电脑下载；我们不会自动上传整个相册或其他文件。",
    "电脑和 AI 工具：你登录的电脑名称和电脑标识（由电脑硬件标识经 SHA-256 处理后得到，不是原始硬件编号）、电脑是否在线；电脑上检测到的 AI 工具类型、版本和是否可用。",
    "设备统计：电脑版每次启动时上报电脑标识、设备类型、可用的 AI 工具类型，以及按 IP 地址在服务器本地推算出的城市（不保存 IP 本身）；登录时还会带上账号和资料里的手机号、邮箱。检查更新时上报电脑标识和版本号。单机版（不登录）同样会上报设备统计和检查更新，但不带账号信息。",
    "问题上报和举报：你主动提交的问题描述、截图和日志；你提交举报时，我们会附上被举报人在该会话里最近的消息。",
    "服务器日志：为保障安全和排查故障，服务器会记录请求时间、IP 地址和出错信息。",
    "购买记录：Apple 处理打赏付款，手机版通过 StoreKit 在本机验证并确认交易；我们不在阿钉服务器保存逐笔打赏记录，也拿不到银行卡等支付信息。开发者可在 App Store Connect 查看 Apple 提供的销售报表。"
  ]],
  ["三、我们不收集什么", [
    "我们不做广告，不做跨应用或跨网站的跟踪，不出售或出租你的个人信息，不读取系统通讯录，也不请求 GPS 定位。照片、视频和文件只处理你主动选取发送的内容。",
    "不登录账号时，电脑版的会话、消息和 AI 记忆不上传到阿钉云端。这不代表任务只在本机处理：你发送给 Agent 的消息及任务所需内容仍可能发送到该 Agent 配置的 AI 服务。"
  ]],
  ["四、我们怎么使用这些信息", [
    "提供服务：登录、同步好友和会话、把手机上的消息送到你的电脑执行、显示 AI 的工作状态和信息流。",
    "安全和处理举报：防止滥用，处理违规内容和账号。",
    "排查故障和改进产品：分析问题上报、日志和设备统计。",
    "处理自愿打赏：通过 Apple StoreKit 在手机版验证并确认交易，不影响任何功能的使用。"
  ]],
  ["五、AI 工具和第三方", [
    "消息转发：阿钉通过 CLI、SDK 等接口，把你向 Agent 发送的消息交给你选择的 Agent，并接收和展示其回复。Agent 会根据你的配置，将消息及任务所需内容发送给对应的 AI 服务提供方处理；阿钉并非在本机独立完成 AI 处理。",
    "处理内容与用途：为完成任务，相关内容可能包括消息、对话上下文、你发送的附件，以及 Agent 在任务中读取的文件、记忆和工具结果。这些内容通过你的输入、会话记录或获准的工具操作取得，用于理解和执行任务、生成回复。",
    "接收方：你选择的 Agent 及其配置的 AI 服务提供方；如果你自行设置模型服务、代理或企业端点，接收方也包括这些配置对应的运营方。具体接收方、处理地点、保存期限和数据使用方式，请查看所选工具的配置与相应服务的隐私政策。",
    "授权与停止使用：桌面端在添加 Agent 前展示消息转发说明，由你选择是否同意；不同意则不添加。你可以在桌面端移除 Agent，停止随后通过阿钉向其发起任务。已经发送的数据不会因此自动从第三方删除，删除请求应按相应服务的政策办理，也可以联系我们协助。",
    "手机与云端：手机端的消息先经阿钉服务同步到你的电脑，再交给对应 Agent；联机消息、AI 回复和附件由阿钉云端存储和同步。",
    "我们使用以下服务商处理信息，只为提供本服务：阿里云（服务器、数据库和文件存储，位于中国上海）；新浪邮箱（把问题上报和举报发送给开发者）；Apple（App 内购买）。",
    "第三方保护：我们要求受托处理用户数据的服务商提供不低于本政策及适用审核规则要求的数据保护。你自行配置的 Agent、模型服务或代理也应满足这一要求；若发现不符合要求的服务，请停止向其发送数据并联系我们。",
    "除此之外，只有在法律要求或为保护用户和他人安全必需时，我们才会披露你的信息。"
  ]],
  ["六、谁能看到你的信息", [
    "你的好友能看到你的显示名称、用户名和头像，以及你们共同会话里的消息。",
    "别人输入你的用户名、邮箱或手机号的完整内容时，可以搜到你并申请加好友；他们看不到你的邮箱和手机号本身。",
    "你的 AI 只和你自己在会话里，别人看不到、也不能使用你的 AI。"
  ]],
  ["七、存储地点和跨境传输", [
    "云端数据存储在阿里云中国上海地域。如果你在中国大陆以外使用本服务，你的信息会被传输到中国并在那里存储和处理。我们通过加密传输、访问控制等措施保护这些信息。"
  ]],
  ["八、保存多久", [
    "账号、好友和会话数据保存到你删除相关内容或注销账号为止。问题上报、举报材料和服务器日志在排查和处理所需的期间内保存。",
    `注销账号：请用注册邮箱或在邮件里写明用户名，发邮件到 ${CONTACT}。我们会在 15 个工作日内删除你的账号和相关个人信息；和好友共同的会话里，你发过的消息会保留，但发送人显示为已注销用户。法律要求保留的除外。`
  ]],
  ["九、你的权利", [
    "你可以查阅、更正你的个人信息（资料可以在电脑版里直接修改），要求导出或删除，撤回你给予的同意，反对某些处理。发邮件给我们即可，我们会在 15 个工作日内答复。",
    "如果你在欧盟、英国或其他有类似法律的地区，你还可以向当地的数据保护监管机构投诉。我们处理你信息的依据是：履行和你之间的服务协议（账号、好友、会话和消息）、我们的正当利益（安全、排查故障、设备统计），以及法律义务。"
  ]],
  ["十、安全", [
    "我们使用 HTTPS 加密传输；密码只保存加盐哈希；电脑版的登录令牌用系统钥匙串加密后保存在本机。没有任何措施能保证绝对安全，发现安全问题请及时告诉我们。"
  ]],
  ["十一、未成年人", [
    "本服务面向年满 16 周岁的用户。如果你发现未满 16 周岁的人向我们提供了个人信息，请联系我们删除。"
  ]],
  ["十二、政策变更", [
    "本政策有变化时，我们会更新生效日期；重大变化会在 App 内或官网提示。"
  ]]
];

const PRIVACY_EN = [
  ["1. Who we are", [
    "ADing (ADing for Mac, ADing for iPhone and the related cloud service) is provided by independent developer BINBIN ZHAO, who is the controller of your personal information.",
    `For any privacy question or request, email ${CONTACT}.`
  ]],
  ["2. What we collect", [
    "Account: username, password (stored only as a salted hash, never in plain text) and display name; the avatar, phone number and email you add to your profile.",
    "Friends and conversations: friendships, friend requests and blocks; the conversations you create or join, their members, message content (including the instructions you give AI and its replies), execution steps, AI memories and workspace names.",
    "Attachments: the photos, videos and files you choose to send, including file names, types and sizes. In online mode, files are uploaded to Alibaba Cloud object storage so conversation members and the computer handling the conversation can download them. We do not automatically upload your photo library or other files.",
    "Computers and AI tools: the names of computers you sign in on and a computer identifier (a SHA-256 hash of the hardware identifier, not the raw hardware number), and whether each is online; the AI tools detected on it, their versions and whether they're usable.",
    "Device statistics: each time ADing for Mac starts, it reports the computer identifier, device type, usable AI tool types, and a city estimated from your IP address on our server (the IP itself isn't stored). When signed in, it also includes your account and the phone number and email in your profile. Update checks send the computer identifier and version. Standalone use (not signed in) also sends device statistics and update checks, without account information.",
    "Problem reports and user reports: the descriptions, screenshots and logs you choose to submit. When you report someone, we attach their recent messages in that conversation.",
    "Server logs: for security and troubleshooting, our servers log request times, IP addresses and errors.",
    "Purchases: Apple processes tip payments. The iPhone app uses StoreKit to verify and finish transactions locally. ADing's server does not store individual tip transactions or receive card or other payment details. The developer can view sales reports provided by Apple in App Store Connect."
  ]],
  ["3. What we don't collect", [
    "We don't show ads, track you across apps or websites, sell or rent your personal information, read your system address book, or request GPS location. We process only the photos, videos and files you choose to send.",
    "Without an account, ADing for Mac does not upload conversations, messages or AI memories to ADing's cloud. This does not mean tasks are processed only on your computer: messages sent to an Agent and content needed for a task may still be sent to the AI services configured for that Agent."
  ]],
  ["4. How we use it", [
    "To run the Service: sign-in, syncing friends and conversations, delivering messages from your phone to your computer, and showing AI status and activity.",
    "For safety and reports: preventing abuse and acting on objectionable content and accounts.",
    "To troubleshoot and improve the product: analyzing problem reports, logs and device statistics.",
    "For voluntary tips: verifying and finishing transactions through Apple StoreKit on iPhone. Tips do not affect access to features."
  ]],
  ["5. AI tools and third parties", [
    "Message forwarding: ADing passes messages you send to an Agent to your chosen Agent through a CLI, SDK or similar interface, and receives and displays its replies. According to your configuration, the Agent sends messages and content needed for a task to the corresponding AI service providers for processing. AI processing is not performed solely within ADing on your computer.",
    "Content and purpose: To complete a task, this may include messages, conversation context, attachments you send, and files, memories and tool results accessed by the Agent during the task. This content comes from your input, conversation history or authorized tool operations and is used to understand and carry out tasks and generate replies.",
    "Recipients: Your chosen Agent and its configured AI service providers. If you configure a model service, proxy or enterprise endpoint, recipients also include the operators of those services. Refer to the selected tool settings and the relevant privacy policies for the specific recipients, processing locations, retention periods and data uses.",
    "Consent and stopping use: Before adding an Agent, the desktop app shows a message-sharing notice and asks whether you agree; declining leaves the Agent unadded. You can remove the Agent in the desktop app to stop initiating further tasks with it through ADing. This does not automatically delete data already sent to a third party; follow that service's policy to request deletion, or contact us for assistance.",
    "Mobile and cloud: Messages from the mobile app first sync through ADing's service to your computer and are then passed to the corresponding Agent. ADing's cloud stores and syncs online messages, AI replies and attachments.",
    "We use these service providers only to run the Service: Alibaba Cloud (servers, database and file storage in Shanghai, China); Sina Mail (delivering problem reports and user reports to the developer); and Apple (In-App Purchases).",
    "Third-party protection: We require service providers entrusted with user data to provide protection at least equivalent to this policy and applicable review requirements. Agents, model services and proxies you configure must also meet this standard. If you identify a service that does not, stop sending data to it and contact us.",
    "Otherwise we disclose your information only when required by law or when necessary to protect the safety of users or others."
  ]],
  ["6. Who can see your information", [
    "Your friends can see your display name, username and avatar, and the messages in conversations you share.",
    "Someone who enters your exact username, email or phone number can find you and send a friend request. They can't see your email or phone number itself.",
    "Your AI works only with you. Others can't see or use it."
  ]],
  ["7. Where data is stored and international transfers", [
    "Cloud data is stored in Alibaba Cloud's Shanghai, China region. If you use the Service outside mainland China, your information is transferred to, stored and processed in China. We protect it with encryption in transit and access controls."
  ]],
  ["8. How long we keep it", [
    "Account, friend and conversation data are kept until you delete them or delete your account. Problem reports, user reports and server logs are kept as long as needed to investigate and resolve them.",
    `To delete your account, email ${CONTACT} from your account email, or include your username. We'll delete your account and related personal information within 15 business days. In conversations shared with friends, your messages remain but show as sent by a deleted user. Information we must keep by law is excepted.`
  ]],
  ["9. Your rights", [
    "You can access and correct your information (you can edit your profile in ADing for Mac), ask us to export or delete it, withdraw consent you gave, and object to certain processing. Email us and we'll respond within 15 business days.",
    "If you're in the EU, the UK or another region with similar laws, you can also complain to your local data protection authority. We process your information to perform our agreement with you (account, friends, conversations and messages), for our legitimate interests (security, troubleshooting and device statistics), and to meet legal obligations."
  ]],
  ["10. Security", [
    "We use HTTPS for data in transit, store passwords only as salted hashes, and ADing for Mac stores its sign-in tokens on your computer encrypted with the system keychain. No measure is perfectly secure; please tell us promptly if you find a security issue."
  ]],
  ["11. Children", [
    "The Service is for people 16 and older. If you learn that someone under 16 has given us personal information, contact us and we'll delete it."
  ]],
  ["12. Changes", [
    "When this policy changes, we update the effective date, and we point out material changes in the app or on our website."
  ]]
];

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function section(lang, heading, effective, items) {
  const body = items.map(([h, paragraphs]) =>
    `<h2>${escape(h)}</h2>\n${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("\n")}`).join("\n");
  return `<section id="${lang}" lang="${lang === "zh" ? "zh-CN" : "en"}">
<h1>${escape(heading)}</h1>
<p class="meta">${escape(effective)}</p>
${body}
</section>`;
}

function renderPage({ title, zhHeading, enHeading, zh, en, effective = EFFECTIVE }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<link rel="icon" href="icon.png" />
<style>
  :root { color-scheme: light dark; --text: #1f2430; --muted: #697386; --line: #e3e7ee; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --text: #e6e9ef; --muted: #9aa3b2; --line: #2c3240; --bg: #14171d; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.75 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  nav { display: flex; flex-wrap: wrap; gap: 16px; font-size: 14px; margin-bottom: 24px; }
  a { color: #165dff; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  p { margin: 0 0 10px; }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 20px; }
  section + section { margin-top: 56px; padding-top: 32px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
<nav><a href="./">阿钉 ADing</a><a href="terms.html">用户协议 Terms</a><a href="privacy.html">隐私政策 Privacy</a><a href="#zh">中文</a><a href="#en">English</a></nav>
${section("zh", zhHeading, `生效日期：${effective.zh}`, zh)}
${section("en", enHeading, `Effective ${effective.en}`, en)}
</main>
</body>
</html>
`;
}

export function renderTerms() {
  return renderPage({ title: "阿钉用户协议 · ADing Terms of Use", zhHeading: "阿钉用户协议", enHeading: "ADing Terms of Use", zh: ZH, en: EN });
}

export function renderPrivacy() {
  return renderPage({ title: "阿钉隐私政策 · ADing Privacy Policy", zhHeading: "阿钉隐私政策", enHeading: "ADing Privacy Policy", zh: PRIVACY_ZH, en: PRIVACY_EN, effective: { zh: "2026 年 10 月 12 日", en: "October 12, 2026" } });
}
