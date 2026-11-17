(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var DASH = "—";
  var PAGE_SIZE = 20;

  /* ---------- Basic utilities ---------- */

  var DOM_PROPS = { disabled: 1, value: 1, checked: 1 };

  // All API text reaches the DOM via createElement + textContent, and attribute values only via setAttribute, to avoid injection
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "onClick") node.addEventListener("click", value);
        else if (DOM_PROPS[key]) node[key] = value;
        else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  var SVG_NS = $("#active-chart").namespaceURI;

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function num(value) { return typeof value === "number" && isFinite(value) ? value : 0; }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function text(value) {
    if (value === null || value === undefined) return DASH;
    var s = String(value);
    return s === "" ? DASH : s;
  }

  function count(value) {
    if (value === null || value === undefined) return DASH;
    return String(num(value));
  }

  function decimal(value) {
    if (value === null || value === undefined) return DASH;
    var n = num(value);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // Backend times carry no zone; they are wall-clock times in the server zone (state.me.zone). Parsing as local time only serves to split out year/month/day/hour/minute,
  // so the displayed numbers match the server; on parse failure return as-is rather than inventing a time
  function parseDate(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  // Wall-clock "now" in the server zone, used to decide today / yesterday; dates aren't mislabelled when the browser is outside UTC+8
  function serverNow() {
    var zone = state.me && state.me.zone;
    if (!zone || typeof Intl !== "object") return new Date();
    try {
      var parts = {};
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      }).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
      return new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    } catch (e) {
      return new Date();
    }
  }

  function fmtDateTime(value) {
    if (value === null || value === undefined || value === "") return DASH;
    var d = parseDate(value);
    if (!d) return String(value);
    var now = serverNow();
    var startOf = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((startOf(now) - startOf(d)) / 86400000);
    var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    if (diff === 0) return hm;
    if (diff === 1) return "昨天 " + hm;
    var md = (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + "年" + md;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  /* ---------- API layer ---------- */

  // If the page is opened at /ading/ops (no trailing slash), relative paths lose a directory level; fill it in here
  var PATH_FIX = /\/$/.test(location.pathname) ? "" : location.pathname + "/";

  function ApiError(message, code) {
    this.name = "ApiError";
    this.message = message || "请求失败";
    this.code = code || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function AuthError(message) {
    this.name = "AuthError";
    this.message = message || "未登录或登录已过期";
    this.code = "OPS_001";
  }
  AuthError.prototype = Object.create(Error.prototype);
  AuthError.prototype.constructor = AuthError;

  function request(method, path, options) {
    var opts = options || {};
    var init = { method: method, credentials: "same-origin", headers: opts.headers || {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(PATH_FIX + path, init).then(function (res) {
      return res.text().then(function (raw) {
        var payload = null;
        if (raw) { try { payload = JSON.parse(raw); } catch (e) { payload = null; } }
        var code = payload ? payload.code : null;
        var message = payload && payload.message ? payload.message : null;
        if (res.status === 401 || code === "OPS_001") {
          var authMessage = message || "未登录或登录已过期";
          if (!opts.silentAuth) handleAuth(authMessage);
          throw new AuthError(authMessage);
        }
        if (!res.ok || code !== "OK") {
          throw new ApiError(message || ("请求失败（HTTP " + res.status + "）"), code);
        }
        return payload.data;
      });
    }, function () {
      throw new ApiError("网络异常，无法连接运维服务，请检查网络后重试");
    });
  }

  function query(path, params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === null || value === undefined) return;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    });
    return parts.length ? path + "?" + parts.join("&") : path;
  }

  /* ---------- Session and view switching ---------- */

  var state = {
    me: null,
    tab: "overview",
    cache: {},
    active: { granularity: "day", days: 30 },
    users: { keyword: "", page: 1, size: PAGE_SIZE },
    devices: { keyword: "", page: 1, size: PAGE_SIZE, scope: "all", owner: null, ownerLabel: null, activeOnly: false },
    feedback: { status: "PENDING", page: 1, size: PAGE_SIZE },
    contacts: { page: 1, size: PAGE_SIZE }
  };

  var lastActiveData = null;

  function showView(name) {
    $("#view-boot").hidden = name !== "boot";
    $("#view-login").hidden = name !== "login";
    $("#view-main").hidden = name !== "main";
  }

  function showLogin(message) {
    state.me = null;
    state.seq = (state.seq || 0) + 1; // On logout or session expiry, in-flight requests that come back are no longer rendered
    state.cache = {};
    lastActiveData = null;
    showView("login");
    var box = $("#login-error");
    if (message) { box.textContent = message; box.hidden = false; }
    else { box.textContent = ""; box.hidden = true; }
    $("#login-submit").disabled = false;
    $("#login-submit").textContent = "登录";
    setTimeout(function () { ($("#login-username").value ? $("#login-password") : $("#login-username")).focus(); }, 0);
  }

  function handleAuth(message) { showLogin(message); }

  function showApp(me) {
    state.me = me;
    var name = me.displayName || me.username || DASH;
    var who = $("#whoami");
    clear(who);
    who.appendChild(document.createTextNode("当前账号 "));
    who.appendChild(el("strong", { text: name }));
    who.setAttribute("title", text(me.username) + " · " + text(me.userId));
    showView("main");
  }

  /* ---------- State blocks (loading / empty / failed) ---------- */

  function setState(host, kind, message, onRetry) {
    clear(host);
    if (!kind) { host.hidden = true; return; }
    host.hidden = false;
    if (kind === "loading") {
      host.appendChild(el("div", { class: "state" }, [
        el("p", {}, [el("span", { class: "spin" }), document.createTextNode("加载中…")])
      ]));
      return;
    }
    var box = el("div", { class: "state" });
    box.appendChild(el("p", { text: kind === "error" ? "加载失败" : message || "暂无数据" }));
    if (kind === "error") box.appendChild(el("p", { class: "state-sub", text: message || "未知错误" }));
    if (kind === "error" && onRetry) box.appendChild(el("button", { class: "btn", type: "button", text: "重试", onClick: onRetry }));
    host.appendChild(box);
  }

  /* ---------- Tables and paging ---------- */

  function buildTable(columns, items) {
    var thead = el("thead");
    var htr = el("tr");
    columns.forEach(function (col) { htr.appendChild(el("th", { scope: "col", text: col.label })); });
    thead.appendChild(htr);

    var tbody = el("tbody");
    items.forEach(function (item) {
      var tr = el("tr");
      columns.forEach(function (col) {
        var td = el("td", col.tdProps || null);
        col.render(td, item);
        if (!td.childNodes.length) td.textContent = DASH;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    return el("div", { class: "table-card" }, [
      el("div", { class: "table-wrap" }, [el("table", {}, [thead, tbody])])
    ]);
  }

  function withPager(card, pager, onChange) {
    var total = num(pager.total);
    if (total <= 0) return card;
    var pages = Math.max(1, Math.ceil(total / Math.max(1, num(pager.size))));
    var page = Math.min(Math.max(1, num(pager.page)), pages);
    var bar = el("div", { class: "pager" }, [
      el("span", { class: "pager-info", text: "第 " + page + " / " + pages + " 页 · 共 " + total + " 条" }),
      el("button", { class: "btn", type: "button", text: "上一页", disabled: page <= 1, onClick: function () { onChange(page - 1); } }),
      el("button", { class: "btn", type: "button", text: "下一页", disabled: page >= pages, onClick: function () { onChange(page + 1); } })
    ]);
    card.appendChild(bar);
    return card;
  }

  var STATUS_TEXT = { ACTIVE: "正常", DISABLED: "已禁用", BANNED: "已封禁", DELETED: "已注销" };
  var TERMINAL_TEXT = { ONLINE: "在线", OFFLINE: "离线", DISABLED: "已禁用" };
  var USER_TAG_TEXT = { PRE_GRAY: "预发灰度", MAINLAND_ADD_FRIEND: "大陆加好友" };
  var FEEDBACK_STATUS_TEXT = { PENDING: "待处理", IGNORED: "忽略", ACCEPTED: "接受", IN_PROGRESS: "处理中", RESOLVED: "已解决" };
  var FEEDBACK_FILTER_TEXT = { PENDING: "待处理", ACTIVE: "进行中", COMPLETED: "已完成" };
  var FEEDBACK_BADGE = { PENDING: "soon", ACCEPTED: "info", IN_PROGRESS: "soon", RESOLVED: "ready", IGNORED: "muted" };
  var CHANNEL_TEXT = { develop: "开发版", pre: "预发版", release: "正式版" };
  var MODE_TEXT = { local: "单机版", remote: "联机版", cloud: "联机版", "user-report": "用户举报" };
  var ATTACHMENT_KIND_TEXT = { log: "日志", log_archive: "日志压缩包", server_log: "服务端日志", file: "文件" };
  var DEVICE_TYPE_TEXT = { mac: "macOS", macos: "macOS", windows: "Windows", win: "Windows", linux: "Linux", ios: "iOS", android: "Android", mobile: "手机", desktop: "电脑" };

  function lookup(map, value) {
    if (value === null || value === undefined || value === "") return null;
    return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : String(value);
  }

  /* ---------- Overview ---------- */

  var VOID_NOTICE = "活跃数据从部署后开始积累，当前还没有记录";
  // The backend writes sources it couldn't read this time into unavailable; one broken block doesn't affect other numbers, and the page must say which block
  var BLOCK_TEXT = { account: "注册用户", devices: "终端", terminal: "已登记终端", active: "活跃汇总" };

  function missing(value) { return value === null || value === undefined; }

  function metricCard(label, value, note, isVoid, target) {
    return el("div", { class: "card" + (isVoid ? " is-void" : "") }, [
      el("span", { class: "card-label", text: label }),
      el(target && !isVoid ? "button" : "span", { class: "card-value", type: target ? "button" : null, text: isVoid ? DASH : value, onClick: target ? (typeof target === "function" ? target : function () { showTab(target); }) : function () {} }),
      note ? el("span", { class: "card-note", text: note }) : null
    ]);
  }

  function renderOverview(host, summary) {
    clear(host);
    var s = summary || {};
    var unavailable = Array.isArray(s.unavailable) ? s.unavailable : [];
    var activeDown = unavailable.indexOf("active") >= 0;
    // Only when earliestStatHour is empty and not unreadable do activity stats truly have no records yet;
    // then the four activity numbers are real 0s and must not be shown as 0
    var noStat = !activeDown && missing(s.earliestStatHour);

    if (unavailable.length) {
      host.appendChild(el("div", { class: "notice", role: "status", text:
        "以下数据本次没读到：" + unavailable.map(function (b) { return BLOCK_TEXT[b] || String(b); }).join("、")
        + "。其余数据不受影响，可稍后点「刷新」重试。" }));
    } else if (noStat) {
      host.appendChild(el("div", { class: "notice", role: "status", text: VOID_NOTICE }));
    }

    var activeValue = function (v) { return count(noStat ? null : v); };
    var activeVoid = function (v) { return noStat || missing(v); };
    var cards = el("div", { class: "cards" }, [
      metricCard("注册用户", count(s.userCount), null, missing(s.userCount), "users"),
      metricCard("终端", count(s.deviceCount), null, missing(s.deviceCount), function () { clearOwnerFilter("devices"); showTab("devices"); }),
      metricCard("在线终端", count(s.onlineTerminalCount), null, missing(s.onlineTerminalCount), function () {
        clearOwnerFilter("devices"); state.devices.scope = "online"; state.devices.keyword = ""; $("#devices-keyword").value = ""; renderScopeSeg(); showTab("devices", true);
      }),
      metricCard("今日活跃终端", activeValue(s.dauToday), null, activeVoid(s.dauToday), function () { openMembers("terminals", "today", "今日活跃终端"); }),
      metricCard("今日活跃用户", activeValue(s.dauUsersToday), null, activeVoid(s.dauUsersToday), function () { openMembers("users", "today", "今日活跃用户"); }),
      metricCard("近 30 天活跃终端", activeValue(s.mau30), null, activeVoid(s.mau30), function () { openMembers("terminals", "last30", "近 30 天活跃终端"); }),
      metricCard("近 30 天活跃用户", activeValue(s.mauUsers30), null, activeVoid(s.mauUsers30), function () { openMembers("users", "last30", "近 30 天活跃用户"); })
    ]);
    host.appendChild(cards);


  }

  /* ---------- Activity: chart ---------- */

  function tickStep(maxValue) {
    var raw = Math.max(1, maxValue / 4);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    // Active counts are whole terminals, so ticks can't be fractional
    return Math.max(1, Math.ceil(step * mag));
  }

  function bucketLabel(bucket, granularity) {
    var s = typeof bucket === "string" ? bucket : String(bucket === null || bucket === undefined ? "" : bucket);
    if (granularity === "hour") return s.length >= 16 ? s.slice(5, 16).replace("T", " ") : s;
    return s.length >= 10 ? s.slice(5, 10) : s;
  }

  function hideTip() { var tip = $("#active-tip"); tip.hidden = true; clear(tip); }

  function showTip(index, point, cx, topY, wrapWidth) {
    var tip = $("#active-tip");
    clear(tip);
    tip.appendChild(el("b", { text: text(point.bucket) }));
    (state.active.dimension === "users" ? [["活跃用户", count(point.total)]] : [["活跃终端", count(point.total)], ["已登录", count(point.loggedIn)], ["单机版", count(point.standalone)]]).forEach(function (row) {
      tip.appendChild(el("div", { class: "tip-row" }, [el("span", { text: row[0] }), el("span", { text: row[1] })]));
    });
    tip.hidden = false;
    var half = tip.offsetWidth / 2;
    var left = Math.min(Math.max(cx, half + 2), Math.max(half + 2, wrapWidth - half - 2));
    tip.style.left = left + "px";
    tip.style.top = Math.max(topY - 8, tip.offsetHeight + 4) + "px";
  }

  function chartPoints(data) {
    var points = data && data.points ? data.points : [];
    return state.active.dimension === "users" ? points.map(function(p) { return {bucket:p.bucket,total:p.users,loggedIn:p.users,standalone:0}; }) : points;
  }

  function drawChart() {
    var svgNode = $("#active-chart");
    var wrap = $("#active-chart-wrap");
    clear(svgNode);
    hideTip();
    var data = lastActiveData;
    var points = chartPoints(data);
    var width = Math.floor(wrap.clientWidth || 0);
    if (!points.length || width < 40) { svgNode.hidden = true; return; }
    svgNode.hidden = false;

    var granularity = data.granularity === "hour" ? "hour" : "day";
    var height = 300, padL = 46, padR = 14, padT = 16, padB = 40;
    var plotW = Math.max(10, width - padL - padR);
    var plotH = height - padT - padB;

    svgNode.setAttribute("viewBox", "0 0 " + width + " " + height);
    svgNode.setAttribute("width", width);
    svgNode.setAttribute("height", height);
    svgNode.setAttribute("preserveAspectRatio", "xMidYMid meet");

    var maxVal = 0;
    points.forEach(function (p) {
      maxVal = Math.max(maxVal, num(p.total), num(p.loggedIn) + num(p.standalone));
    });
    var step = tickStep(maxVal);
    var top = Math.max(step, Math.ceil(maxVal / step) * step);
    var yOf = function (v) { return padT + plotH - (v / top) * plotH; };

    for (var v = 0; v <= top; v += step) {
      var gy = Math.round(yOf(v)) + 0.5;
      svgNode.appendChild(svg("line", { class: "grid", x1: padL, y1: gy, x2: padL + plotW, y2: gy }));
      var label = svg("text", { x: padL - 9, y: gy + 4, "text-anchor": "end" });
      label.textContent = String(v);
      svgNode.appendChild(label);
    }
    svgNode.appendChild(svg("line", { class: "axis", x1: padL, y1: padT + plotH + 0.5, x2: padL + plotW, y2: padT + plotH + 0.5 }));

    var linePoints = [];
    var bandW = plotW / points.length;
    var labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / (granularity === "hour" ? 84 : 56)))));

    points.forEach(function (point, i) {
      var bx = padL + bandW * i;
      var cx = bx + bandW / 2;
      var loggedIn = num(point.loggedIn), standalone = num(point.standalone), total = num(point.total);
      var sum = loggedIn + standalone;

      var band = svg("rect", { class: "band", x: bx, y: padT, width: bandW, height: plotH, "pointer-events": "all" });
      svgNode.appendChild(band);

      linePoints.push([cx, yOf(total)]);

      if (i % labelEvery === 0) {
        var t = svg("text", { x: cx, y: padT + plotH + 18, "text-anchor": "middle" });
        t.textContent = bucketLabel(point.bucket, granularity);
        svgNode.appendChild(t);
      }

      band.addEventListener("mouseenter", function () {
        band.setAttribute("class", "band on");
        showTip(i, point, cx, Math.min(yOf(Math.max(total, sum)), padT + plotH), width);
      });
      band.addEventListener("mouseleave", function () {
        band.setAttribute("class", "band");
        hideTip();
      });
    });
    {
      var series = svg("g", {class:"trend-series", "pointer-events":"none"});
      series.appendChild(svg("polyline", {class:"trend-line", points:linePoints.map(function(p){return p.join(",");}).join(" ")}));
      linePoints.forEach(function(p){series.appendChild(svg("circle", {class:"trend-point", cx:p[0], cy:p[1], r:points.length > 60 ? 2 : 3}));});
      svgNode.appendChild(series);
    }
  }

  /* ---------- Activity: rendering ---------- */

  function renderActive(data) {
    lastActiveData = data || { points: [] };
    var d = lastActiveData;
    var noStat = d.earliestStatHour === null || d.earliestStatHour === undefined;

    setState($("#active-state"), null);
    $("#active-body").hidden = false;

    var notice = $("#active-notice");
    clear(notice);
    if (noStat) notice.appendChild(el("div", { class: "notice", role: "status", text: VOID_NOTICE }));

    var totals = d.totals || {};
    var totalsHost = $("#active-totals");
    clear(totalsHost);
    var usersDimension = state.active.dimension === "users";
    $("#active-chart-title").textContent = usersDimension ? "活跃用户趋势" : "活跃终端趋势";
    $("#active-chart").setAttribute("aria-label", usersDimension ? "活跃用户趋势折线图" : "活跃终端趋势折线图");
    var legend = $("#active-chart-card .legend"); clear(legend);
    (usersDimension ? [["sw-a", "活跃用户"]] : [["sw-a", "活跃终端"]]).forEach(function(item) {
      legend.appendChild(el("span", {}, [el("i", {class:"sw " + item[0]}), document.createTextNode(item[1])]));
    });
    (usersDimension ? [
      ["今日活跃用户",count(totals.dauUsersToday)], ["昨日活跃用户",count(totals.dauUsersYesterday)],
      ["近 7 日均值（不含今天）",decimal(totals.avgUsers7)], ["近 30 天活跃用户",count(totals.mauUsers30)], ["本自然月活跃用户",count(totals.mauUsersMonth)]
    ] : [
      ["今日活跃终端",count(totals.dauToday)], ["昨日活跃终端",count(totals.dauYesterday)],
      ["近 7 日均值（不含今天）",decimal(totals.avg7)], ["近 30 天活跃终端",count(totals.mau30)], ["本自然月活跃终端",count(totals.mauMonth)]
    ]).forEach(function (item, index) {
      var period = ["today", "yesterday", null, "last30", "month"][index];
      totalsHost.appendChild(metricCard(item[0], item[1], null, noStat,
        period ? function () { openMembers(usersDimension ? "users" : "terminals", period, item[0]); } : null));
    });

    var points = Array.isArray(d.points) ? d.points : [];
    $("#active-chart-card").hidden = points.length === 0;
    if (points.length) drawChart();

    var host = $("#active-table");
    clear(host);
    if (!points.length) {
      setState(host, "empty", noStat ? VOID_NOTICE : "所选区间内没有活跃记录");
      return;
    }
    var columns = [
      { label: d.granularity === "hour" ? "小时" : "日期", tdProps: {class:"nowrap mono"}, render:function(td,row){td.textContent=text(row.bucket);} }
    ];
    if(usersDimension) columns.push({label:"活跃用户",tdProps:{class:"num"},render:function(td,row){td.appendChild(activityLink(row.users, "users", row.bucket, "all"));}});
    else columns = columns.concat([
      {label:"活跃终端",tdProps:{class:"num"},render:function(td,row){td.appendChild(activityLink(row.total, "terminals", row.bucket, "all"));}},
      {label:"已登录终端",tdProps:{class:"num"},render:function(td,row){td.appendChild(activityLink(row.loggedIn, "terminals", row.bucket, "loggedIn"));}},
      {label:"单机版",tdProps:{class:"num"},render:function(td,row){td.appendChild(activityLink(row.standalone, "terminals", row.bucket, "standalone"));}}
    ]);
    var table = buildTable(columns, points);
    host.appendChild(table);
    host.appendChild(el("p", { class: "cell-sub", style: "margin:10px 2px 0", text: "数据起点：" + (noStat ? "暂无记录" : text(d.earliestStatHour)) }));
  }

  /* ---------- Activity details ---------- */

  function openMembers(dimension, period, title, bucket, login) {
    state.members = {dimension:dimension, period:period, bucket:bucket || "", login:login || "all",
      granularity:state.active.granularity, page:1, size:PAGE_SIZE, title:title};
    $("#members-title").textContent = title;
    showTab("members", true);
  }

  function activityLink(value, dimension, bucket, login) {
    var label = dimension === "users" ? "活跃用户" : login === "loggedIn" ? "已登录终端" : login === "standalone" ? "单机版终端" : "活跃终端";
    return el("button", {type:"button", class:"count-link", text:count(value),
      "aria-label":bucket + " " + label + " " + count(value),
      onClick:function () { openMembers(dimension, "bucket", bucket + " " + label, bucket, login); }});
  }

  function renderMembers(host, data) {
    clear(host);
    $("#members-title").textContent = state.members.title;
    var page = data.members;
    host.appendChild(el("p", {class:"cell-sub", text:text(data.from).replace("T", " ") + " 至 " + text(data.to).replace("T", " ")}));
    if (!page.items.length) { host.appendChild(el("p", {class:"empty", text:"该范围内没有活跃记录"})); return; }
    var users = data.dimension === "users";
    var items = page.items;
    var columns;
    if (users) {
      columns = [
        {label:"用户名",render:function(td,r){td.textContent=text(r.username);}},
        {label:"显示名",render:function(td,r){td.textContent=text(r.name);}},
        {label:"活跃终端数",tdProps:{class:"num"},render:function(td,r){td.textContent=count(r.terminalCount);}},
        {label:"活跃小时数",tdProps:{class:"num"},render:function(td,r){td.textContent=hoursText(r.activeHours);}},
        {label:"范围内最近活跃",render:function(td,r){td.textContent=fmtDateTime(r.lastActiveAt);}}
      ];
    } else {
      columns = DEVICE_COLUMNS.filter(function (column) { return column.label !== "状态"; }).concat([{label:"活跃小时数",tdProps:{class:"num"},render:function(td,r){td.textContent=hoursText(r.activeHours);}}]);
      items = items.map(function (member) {
        return Object.assign({deviceUuid:member.memberId, name:member.name, deviceType:member.deviceType}, member.device || {},
          {lastActiveAt:member.lastActiveAt, activeHours:member.activeHours});
      });
    }
    host.appendChild(withPager(buildTable(columns,items),page,function(page){state.members.page=page;showTab("members",true);}));
  }

  /* ---------- Registered users ---------- */

  /** No connection record means empty, not 0 */
  function hoursText(hours) {
    if (missing(hours)) return DASH;
    return hours > 0 && hours < 0.1 ? "<0.1" : Number(hours).toFixed(1);
  }

  function renderUserTags(td, row) {
    clear(td);
    var tags = Array.isArray(row.tags) ? row.tags : [];
    var controls = [];
    var chips = el("div", { class: "tag-chips" });
    var status = el("p", { class: "tag-status", role: "status", "aria-live": "polite", hidden: true });
    function change(tag, enabled) {
      controls.forEach(function (node) { node.disabled = true; });
      status.hidden = false;
      status.textContent = "正在保存…";
      request("POST", "api/users/" + encodeURIComponent(row.userId) + "/tags", {
        headers: { "X-Ops-Request": "user-tags" }, body: { tag: tag, enabled: enabled }
      }).then(function (updated) {
        row.tags = updated;
        renderUserTags(td, row);
        var next = td.querySelector('.tag-add') || td.querySelector('button');
        if (next) next.focus({ preventScroll: true });
      }).catch(function (error) {
        controls.forEach(function (node) { node.disabled = false; });
        status.textContent = error.message || "保存失败，请重试";
      });
    }
    tags.forEach(function (tag) {
      var name = lookup(USER_TAG_TEXT, tag) || text(tag);
      var remove = el("button", { type: "button", class: "tag-remove", text: "×",
        title: "移除" + name, "aria-label": "移除" + name,
        onClick: function () { change(tag, false); } });
      controls.push(remove);
      chips.appendChild(el("span", { class: "tag tag-chip" }, [el("span", { text: name }), remove]));
    });
    var available = Object.keys(USER_TAG_TEXT).filter(function (tag) { return tags.indexOf(tag) < 0; });
    var choices = el("div", { class: "tag-picker", popover: "auto", "aria-label": "选择要添加的标签" });
    choices.appendChild(el("div", { class: "tag-picker-heading", text: "添加标签" }));
    var options = el("ul", { class: "tag-options" });
    choices.appendChild(options);
    if (available.length) {
      var add = el("button", { type: "button", class: "tag-add", text: "+", title: "添加标签",
        "aria-label": "添加标签", "aria-expanded": "false", onClick: function () {
          if (choices.matches(":popover-open")) { choices.hidePopover(); return; }
          choices.showPopover();
          var rect = add.getBoundingClientRect();
          choices.style.left = (rect.right + 8) + "px";
          choices.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - choices.offsetHeight - 8)) + "px";
          add.setAttribute("aria-expanded", "true");
        } });
      choices.addEventListener("toggle", function () {
        add.setAttribute("aria-expanded", String(choices.matches(":popover-open")));
      });
      controls.push(add);
      chips.appendChild(add);
      available.forEach(function (tag) {
        var option = el("button", { type: "button", class: "tag-option", text: USER_TAG_TEXT[tag],
          "aria-label": "添加" + USER_TAG_TEXT[tag], onClick: function () { change(tag, true); } });
        controls.push(option);
        options.appendChild(el("li", null, [option]));
      });
    }
    td.appendChild(chips);
    if (available.length) td.appendChild(choices);
    td.appendChild(status);
  }

  function ownerLink(value, label, r, open) {
    var name = r.displayName || r.username || r.userId;
    return el("button", { type: "button", class: "count-link", text: count(value), title: "查看" + name + "的" + label,
      "aria-label": name + " " + label + " " + count(value), onClick: function () { open(r.userId, name + " · " + label); } });
  }

  function openOwnerAgents(owner, label) {
    state.agents.owner = owner; state.agents.ownerLabel = label; state.agents.contactOnly = true;
    state.agents.keyword = ""; state.agents.page = 1; $("#agents-keyword").value = "";
    showTab("agents", true);
  }

  function openOwnerTerminals(owner, label, activeOnly) {
    state.devices.owner = owner; state.devices.ownerLabel = label; state.devices.activeOnly = activeOnly;
    state.devices.scope = "terminal"; state.devices.keyword = ""; state.devices.page = 1; $("#devices-keyword").value = "";
    renderScopeSeg();
    showTab("devices", true);
  }

  function clearOwnerFilter(name) {
    var filter = state[name];
    filter.owner = null; filter.ownerLabel = null; filter.page = 1;
    if (name === "agents") filter.contactOnly = false;
    else if (filter.activeOnly !== undefined) { filter.activeOnly = false; filter.scope = "all"; renderScopeSeg(); }
  }

  // When coming from the user list, show only this account's; the filter is shown next to the search box, x returns to all
  function syncOwnerFilter(name) {
    var filter = state[name], host = $("#" + name + "-filter");
    clear(host);
    host.hidden = !filter.owner;
    if (name === "devices") $("#seg-scope").hidden = !!filter.owner;
    if (!filter.owner) return;
    host.appendChild(el("span", { text: filter.ownerLabel }));
    host.appendChild(el("button", { type: "button", class: "tag-remove", text: "×", title: "清除筛选", "aria-label": "清除筛选",
      onClick: function () { clearOwnerFilter(name); showTab(name, true); } }));
  }

  function openUserDetail(row, opener) {
    var dialog = $("#user-detail");
    clear(dialog);
    dialog.appendChild(el("div", { class: "detail-head" }, [
      el("h2", { id: "user-detail-title", text: "用户详情" }),
      el("button", { type: "button", class: "btn", text: "关闭", onClick: function () { dialog.close(); } })
    ]));
    var meta = el("dl", { class: "detail-meta user-detail-meta" });
    function field(label, value) {
      meta.appendChild(el("dt", { text: label }));
      meta.appendChild(el("dd", typeof value === "string" ? { text: value } : null, typeof value === "string" ? null : [value]));
    }
    field("用户名", text(row.username));
    field("显示名", text(row.displayName));
    field("手机号", text(row.phone));
    field("邮箱", text(row.email));
    field("注册时间", fmtDateTime(row.registeredAt));
    field("已登记终端数", ownerLink(row.terminalCount, "已登记终端", row, function (id, label) { dialog.close(); openOwnerTerminals(id, label, false); }));
    field("Agent 数", ownerLink(row.agentCount, "Agent", row, function (id, label) { dialog.close(); openOwnerAgents(id, label); }));
    dialog.appendChild(meta);
    dialog.addEventListener("close", function () { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    dialog.showModal();
  }

  var USER_COLUMNS = [
    { label: "用户名", tdProps: { class: "nowrap mono" }, render: function (td, r) { td.appendChild(el("button", { type: "button", class: "row-link user-link", text: text(r.username), "aria-haspopup": "dialog", onClick: function (event) { openUserDetail(r, event.currentTarget); } })); } },
    { label: "显示名", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = text(r.displayName); } },
    { label: "状态", tdProps: { class: "nowrap" }, render: function (td, r) {
      var raw = r.status;
      td.appendChild(el("span", { class: "badge " + (raw === "ACTIVE" ? "ready" : "soon"), text: lookup(STATUS_TEXT, raw) || DASH }));
    } },
    { label: "标签", tdProps: { class: "user-tags-cell" }, render: renderUserTags },
    { label: "最近活跃", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = fmtDateTime(r.lastActiveAt); } },
    { label: "在线", tdProps: { class: "nowrap" }, render: function (td, r) {
      td.appendChild(el("span", { class: "badge " + (r.online ? "ready" : "muted"), text: r.online ? "在线" : "离线" }));
    } }
  ];

  function renderUsers(host, data) {
    clear(host);
    var items = data && Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      setState(host, "empty", state.users.keyword ? "没有匹配「" + state.users.keyword + "」的注册用户" : "还没有注册用户");
      return;
    }
    var table = buildTable(USER_COLUMNS, items);
    host.appendChild(withPager(table, data, function (page) {
      state.users.page = page;
      showTab("users", true);
    }));
  }

  /* ---------- Terminals ---------- */

  function accountsCell(td, row) {
    var accounts = Array.isArray(row.accounts) ? row.accounts : [];
    if (!accounts.length) { td.appendChild(el("span", { class: "badge muted", text: "单机版" })); return; }
    accounts.forEach(function (account) {
      var primary = account.username || account.displayName || account.userId;
      var line = el("div", { class: "cell-main" }, [el("span", { class: "mono", text: text(primary) })]);
      if (account.displayName && account.displayName !== primary) line.appendChild(el("span", { class: "cell-sub inline", text: " " + account.displayName }));
      if (account.online) line.appendChild(el("span", { class: "badge ready", text: "在线" }));
      td.appendChild(line);
    });
  }

  function statusCell(td, row) {
    if (!row.status) { td.appendChild(el("span", { class: "badge muted", text: "未登记" })); return; }
    td.appendChild(el("span", { class: "badge " + (row.status === "ONLINE" ? "ready" : "muted"), text: lookup(TERMINAL_TEXT, row.status) || DASH }));
  }

  function openDeviceDetail(row, opener) {
    var dialog = $("#device-detail");
    clear(dialog);
    dialog.appendChild(el("div", { class: "detail-head" }, [
      el("h2", { id: "device-detail-title", text: "终端详情" }),
      el("button", { type: "button", class: "btn", text: "关闭", onClick: function () { dialog.close(); } })
    ]));
    var meta = el("dl", { class: "detail-meta user-detail-meta" });
    function field(label, value) {
      meta.appendChild(el("dt", { text: label }));
      var cell = el("dd", typeof value === "string" ? { text: value } : null);
      if (typeof value === "function") value(cell, row);
      meta.appendChild(cell);
    }
    field("终端名称", text(row.name));
    field("UUID", text(row.deviceUuid));
    field("类型", function (cell) {
      var type = lookup(DEVICE_TYPE_TEXT, row.deviceType) || DASH;
      var version = row.osVersion ? String(row.osVersion).trim() : "";
      cell.textContent = version ? (version.toLowerCase().indexOf(type.toLowerCase()) === 0 ? version : type + " " + version) : type;
    });
    field("关联账号", accountsCell);
    field("可用 Agent", function (cell) {
      var agents = Array.isArray(row.agents) ? row.agents : [];
      if (!agents.length) { cell.textContent = DASH; return; }
      agents.forEach(function (name) { cell.appendChild(el("span", { class: "tag", text: text(name) })); });
    });
    field("首次注册时间", fmtDateTime(row.firstSeenAt));
    dialog.appendChild(meta);
    dialog.addEventListener("close", function () { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    dialog.showModal();
  }

  var DEVICE_COLUMNS = [
    { label: "终端", tdProps: { class: "device-name-cell" }, render: function (td, r) {
      td.appendChild(el("button", { type: "button", class: "row-link device-link", text: text(r.name || "未命名终端"),
        "aria-haspopup": "dialog", onClick: function (event) { openDeviceDetail(r, event.currentTarget); } }));
    } },
    { label: "类型", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = lookup(DEVICE_TYPE_TEXT, r.deviceType) || DASH; } },
    { label: "版本号", tdProps: { class: "nowrap mono" }, render: function (td, r) { td.textContent = text(r.appVersion); } },
    { label: "城市", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = text(r.city); } },
    { label: "最近活跃", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = fmtDateTime(r.lastActiveAt); } },
    { label: "状态", render: statusCell }
  ];

  function renderDevices(host, data) {
    clear(host);
    var items = data && Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      var empty = state.devices.keyword
        ? "没有匹配「" + state.devices.keyword + "」的终端"
        : (state.devices.scope === "online" ? "当前没有在线终端" : state.devices.scope === "terminal" ? "还没有已登记终端" : "还没有终端");
      setState(host, "empty", empty);
      return;
    }
    var columns = state.devices.scope === "online" ? DEVICE_COLUMNS.filter(function (column) { return column.label !== "最近活跃" && column.label !== "状态"; }) : DEVICE_COLUMNS;
    var table = buildTable(columns, items);
    host.appendChild(withPager(table, data, function (page) {
      state.devices.page = page;
      showTab("devices", true);
    }));
  }

  /* ---------- Issue reports and user contacts ---------- */

  function attachmentHref(id) { return PATH_FIX + "api/attachments/" + encodeURIComponent(id); }

  function fmtBytes(value) {
    var n = num(value);
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function isImageAttachment(item) { return /^image\/(png|jpeg|webp)$/i.test(item.contentType || ""); }

  function runtimeText(r) {
    return [lookup(CHANNEL_TEXT, r.channel), lookup(MODE_TEXT, r.mode) || r.mode, r.platform, r.arch].filter(Boolean).join(" / ");
  }

  function metaBlock(rows) {
    var box = el("dl", { class: "detail-meta" });
    rows.forEach(function (row) {
      box.appendChild(el("dt", { text: row[0] }));
      box.appendChild(el("dd", { class: row[2] || null, text: text(row[1]) }));
    });
    return box;
  }

  // Images preview directly and open full size on click; logs and other files are download-only: content comes from users and isn't rendered under the ops console domain
  function attachmentBlock(items) {
    var images = items.filter(isImageAttachment);
    var files = items.filter(function (item) { return !isImageAttachment(item); });
    var box = el("div", { class: "detail-attachments" });
    box.appendChild(el("h3", { class: "detail-heading", text: "附件（" + items.length + "）" }));
    if (!items.length) box.appendChild(el("p", { class: "cell-sub", text: "没有附件" }));
    if (images.length) {
      var gallery = el("div", { class: "attachment-gallery" });
      images.forEach(function (item) {
        gallery.appendChild(el("a", { class: "attachment-thumb", href: attachmentHref(item.id), target: "_blank", rel: "noopener", title: item.name }, [
          el("img", { src: attachmentHref(item.id), alt: item.name, loading: "lazy" }),
          el("span", { class: "cell-sub", text: item.name })
        ]));
      });
      box.appendChild(gallery);
    }
    if (files.length) {
      var list = el("ul", { class: "attachment-files" });
      files.forEach(function (item) {
        list.appendChild(el("li", {}, [
          el("a", { href: attachmentHref(item.id), download: item.name, text: item.name }),
          el("span", { class: "cell-sub", text: " " + (lookup(ATTACHMENT_KIND_TEXT, item.kind) || "文件") + " · " + fmtBytes(item.sizeBytes) })
        ]));
      });
      box.appendChild(list);
    }
    return box;
  }

  function feedbackBadge(status) {
    return el("span", { class: "badge " + (FEEDBACK_BADGE[status] || "muted"), text: lookup(FEEDBACK_STATUS_TEXT, status) || text(status) });
  }

  // Accepting, ignoring and confirming closure are done by ops staff; Agents only claim as in progress.
  function feedbackActions(row, onDone) {
    var box = el("div", { class: "feedback-actions" });
    if (row.status === "RESOLVED") return box;
    var pick = function (status, label, primary) {
      var button = el("button", { class: "btn" + (primary ? " primary" : ""), type: "button", text: label });
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        if (status === "RESOLVED" && !window.confirm("确认此问题已解决？\n\n" + row.description)) return;
        Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) { b.disabled = true; });
        Array.prototype.forEach.call(box.querySelectorAll(".action-error"), function (n) { n.remove(); });
        request("POST", "api/feedback/" + encodeURIComponent(row.reportId) + "/status", { body: { status: status } }).then(function () {
          state.cache = {};
          onDone();
        }).catch(function (err) {
          if (err && err.name === "AuthError") return;
          Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) { b.disabled = false; });
          box.appendChild(el("span", { class: "action-error", role: "alert", text: (err && err.message) || "修改失败，请重试" }));
        });
      });
      return button;
    };
    if (row.status === "IN_PROGRESS") {
      box.appendChild(pick("RESOLVED", "已解决", true));
      box.appendChild(pick("ACCEPTED", "退回接受", false));
      box.appendChild(pick("IGNORED", "忽略", false));
      return box;
    }
    if (row.status !== "ACCEPTED") box.appendChild(pick("ACCEPTED", "接受", true));
    if (row.status !== "IGNORED") box.appendChild(pick("IGNORED", "忽略", false));
    return box;
  }

  function summaryLink(value, onOpen) {
    return el("button", { class: "row-link", type: "button", text: value, title: value, onClick: onOpen });
  }

  function openFeedback(reportId) { state.feedbackDetail = { id: reportId }; showTab("feedbackDetail", true); }
  function openContact(contactId) { state.contactDetail = { id: contactId }; showTab("contactDetail", true); }

  function renderFeedback(host, data) {
    clear(host);
    renderFeedbackStatusSeg(data.counts || {});
    var page = data.feedback || {};
    var items = Array.isArray(page.items) ? page.items : [];
    if (!items.length) {
      setState(host, "empty", state.feedback.status ? "没有「" + lookup(FEEDBACK_FILTER_TEXT, state.feedback.status) + "」的问题反馈" : "还没有问题反馈");
      return;
    }
    var columns = [
      { label: "问题描述", tdProps: { class: "summary-cell" }, render: function (td, r) {
        td.appendChild(summaryLink(r.description, function () { openFeedback(r.reportId); }));
      } },
      { label: "版本", tdProps: { class: "nowrap mono" }, render: function (td, r) { td.textContent = text(r.appVersion); } },
      { label: "环境", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = runtimeText(r) || DASH; } },
      { label: "状态", tdProps: { class: "nowrap" }, render: function (td, r) { td.appendChild(feedbackBadge(r.status)); } },
      { label: "上报时间", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = fmtDateTime(r.submittedAt); } },
      { label: "解决时间", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = r.status === "RESOLVED" ? fmtDateTime(r.statusChangedAt) : DASH; } },
      { label: "操作", tdProps: { class: "nowrap" }, render: function (td, r) {
        td.appendChild(feedbackActions(r, function () { showTab("feedback", true); }));
      } }
    ];
    host.appendChild(withPager(buildTable(columns, items), page, function (next) {
      state.feedback.page = next;
      showTab("feedback", true);
    }));
  }

  function renderFeedbackDetail(host, r) {
    clear(host);
    var card = el("article", { class: "detail-card" });
    card.appendChild(el("div", { class: "detail-head" }, [
      feedbackBadge(r.status),
      feedbackActions(r, function () { showTab("feedbackDetail", true); })
    ]));
    card.appendChild(el("h3", { class: "detail-heading", text: "问题描述" }));
    card.appendChild(el("p", { class: "detail-body", text: r.description }));
    card.appendChild(metaBlock([
      ["发生时间", fmtDateTime(r.occurredAt)],
      ["上报时间", fmtDateTime(r.submittedAt)],
      ["解决时间", r.status === "RESOLVED" ? fmtDateTime(r.statusChangedAt) : DASH],
      ["账号", r.userId || "没有账号（单机版或老版本）", "mono"],
      ["终端", r.terminalId, "mono"],
      ["报告编号", r.reportId, "mono"],
      ["版本", r.appVersion, "mono"],
      ["环境", runtimeText(r)],
      ["最后处理", r.handledBy ? r.handledBy + " · " + fmtDateTime(r.statusChangedAt) : null]
    ]));
    card.appendChild(attachmentBlock(Array.isArray(r.attachments) ? r.attachments : []));
    host.appendChild(card);
  }

  function renderContacts(host, data) {
    clear(host);
    var items = data && Array.isArray(data.items) ? data.items : [];
    if (!items.length) { setState(host, "empty", "还没有用户联系"); return; }
    var columns = [
      { label: "主题", tdProps: { class: "summary-cell" }, render: function (td, r) {
        td.appendChild(summaryLink(r.subject, function () { openContact(r.contactId); }));
      } },
      { label: "回复方式", render: function (td, r) { td.textContent = text(r.replyTo); } },
      { label: "附件", tdProps: { class: "num" }, render: function (td, r) { td.textContent = String((r.attachments || []).length); } },
      { label: "版本", tdProps: { class: "nowrap mono" }, render: function (td, r) { td.textContent = text(r.appVersion); } },
      { label: "环境", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = runtimeText(r) || DASH; } },
      { label: "提交时间", tdProps: { class: "nowrap" }, render: function (td, r) { td.textContent = fmtDateTime(r.submittedAt); } }
    ];
    host.appendChild(withPager(buildTable(columns, items), data, function (next) {
      state.contacts.page = next;
      showTab("contacts", true);
    }));
  }

  function renderContactDetail(host, r) {
    clear(host);
    var card = el("article", { class: "detail-card" });
    card.appendChild(el("h3", { class: "detail-heading", text: r.subject }));
    card.appendChild(el("p", { class: "detail-body", text: r.content }));
    card.appendChild(metaBlock([
      ["回复方式", r.replyTo],
      ["提交时间", fmtDateTime(r.submittedAt)],
      ["账号", r.userId || "没有账号（单机版或老版本）", "mono"],
      ["终端", r.terminalId, "mono"],
      ["联络编号", r.contactId, "mono"],
      ["版本", r.appVersion, "mono"],
      ["环境", runtimeText(r)]
    ]));
    card.appendChild(attachmentBlock(Array.isArray(r.attachments) ? r.attachments : []));
    host.appendChild(card);
  }

  /* ---------- Tab dispatch ---------- */

  var DAY_OPTIONS = [7, 14, 30];
  var HOUR_OPTIONS = [1, 3, 7];

  var TABS = {
    members: {
      host:function(){return $("#out-members");},
      key:function(){return JSON.stringify(state.members);},
      load:function(){return request("GET",query("api/active/members",state.members));},
      render:renderMembers
    },
    overview: {
      host: function () { return $("#out-overview"); },
      key: function () { return "summary"; },
      load: function () { return request("GET", "api/summary"); },
      render: function (host, data) { renderOverview(host, data); }
    },
    active: {
      host: function () { return $("#active-state"); },
      begin: function () { $("#active-body").hidden = true; },
      key: function () { return "active|" + state.active.granularity + "|" + state.active.days; },
      load: function () {
        return request("GET", query("api/active", { days: state.active.days, granularity: state.active.granularity }));
      },
      render: function (host, data) { renderActive(data); }
    },
    users: {
      host: function () { return $("#out-users"); },
      key: function () { return "users|" + state.users.keyword + "|" + state.users.page + "|" + state.users.size; },
      load: function () {
        return request("GET", query("api/users", { keyword: state.users.keyword, page: state.users.page, size: state.users.size }));
      },
      render: function (host, data) { renderUsers(host, data); }
    },
    agents: {
      host: function () { return $("#out-agents"); },
      key: function () { return "agents|" + state.agents.keyword + "|" + state.agents.page + "|" + state.agents.owner; },
      load: function () {
        return request("GET", query("api/agents", { keyword: state.agents.keyword, page: state.agents.page, size: state.agents.size,
          owner: state.agents.owner, contact: state.agents.contactOnly ? true : null }));
      },
      render: function (host, data) {
        clear(host);
        if (!data.items.length) { setState(host, "empty", "没有匹配的 Agent"); return; }
        var columns = USER_COLUMNS.slice(0, 2).concat([
          { label:"类型", render:function(td,r) { td.textContent = text(r.agentType); } },
          { label:"所属用户", render:function(td,r) { td.textContent = text(r.ownerName || r.owner); } },
          { label:"已加联系人", tdProps:{class:"nowrap"}, render:function(td,r) { td.textContent = r.contact ? "是" : "否"; } }
        ], USER_COLUMNS.slice(4, 5), USER_COLUMNS.slice(6, 7));
        host.appendChild(withPager(buildTable(columns, data.items), data, function(page) { state.agents.page = page; showTab("agents", true); }));
      }
    },
    feedback: {
      host: function () { return $("#out-feedback"); },
      key: function () { return JSON.stringify(state.feedback); },
      load: function () { return request("GET", query("api/feedback", state.feedback)); },
      render: renderFeedback
    },
    feedbackDetail: {
      host: function () { return $("#out-feedbackDetail"); },
      key: function () { return JSON.stringify(state.feedbackDetail); },
      load: function () { return request("GET", "api/feedback/" + encodeURIComponent(state.feedbackDetail.id)); },
      render: renderFeedbackDetail
    },
    contacts: {
      host: function () { return $("#out-contacts"); },
      key: function () { return JSON.stringify(state.contacts); },
      load: function () { return request("GET", query("api/contacts", state.contacts)); },
      render: renderContacts
    },
    contactDetail: {
      host: function () { return $("#out-contactDetail"); },
      key: function () { return JSON.stringify(state.contactDetail); },
      load: function () { return request("GET", "api/contacts/" + encodeURIComponent(state.contactDetail.id)); },
      render: renderContactDetail
    },
    devices: {
      host: function () { return $("#out-devices"); },
      key: function () { return "devices|" + state.devices.keyword + "|" + state.devices.page + "|" + state.devices.size + "|" + state.devices.scope + "|" + state.devices.owner + "|" + state.devices.activeOnly; },
      load: function () {
        return request("GET", query("api/devices", { keyword: state.devices.keyword, page: state.devices.page, size: state.devices.size, scope: state.devices.scope, owner: state.devices.owner, active: state.devices.activeOnly ? true : null }));
      },
      render: function (host, data) { renderDevices(host, data); }
    }
  };

  state.agents = {keyword:"", page:1, size:PAGE_SIZE, owner:null, ownerLabel:null, contactOnly:false};
  $("#agents-keyword").addEventListener("input", debounce(function () { state.agents.keyword = this.value.trim(); state.agents.page = 1; showTab("agents", true); }, 250));


  var refreshButton = $("#btn-refresh");

  function selectTabButtons() {
    Object.keys(TABS).forEach(function (name) {
      var selected = name === state.tab;
      var tabButton = $("#tabbtn-" + name);
      if (tabButton) tabButton.setAttribute("aria-selected", String(selected));
      $("#panel-" + name).hidden = !selected;
    });
  }

  // Restore filters in place: search handlers retain references to these objects.
  function navigationState() {
    return JSON.parse(JSON.stringify({ops:true, user:state.me.userId || state.me.username,
      tab:state.tab, active:state.active, users:state.users, agents:state.agents,
      devices:state.devices, members:state.members || null,
      feedback:state.feedback, contacts:state.contacts,
      feedbackDetail:state.feedbackDetail || null, contactDetail:state.contactDetail || null}));
  }

  function recordNavigation(mode) {
    if (!state.me || mode === "restore") return;
    var next = navigationState();
    if (JSON.stringify(history.state) === JSON.stringify(next)) return;
    var replace = mode === "replace" || !history.state || !history.state.ops;
    history[replace ? "replaceState" : "pushState"](next, "", "#" + state.tab);
  }

  function restoreNavigation(saved) {
    if (!state.me || !saved || saved.ops !== true || saved.user !== (state.me.userId || state.me.username)
        || !TABS[saved.tab] || (saved.tab === "members" && !saved.members)
        || (saved.tab === "feedbackDetail" && !saved.feedbackDetail)
        || (saved.tab === "contactDetail" && !saved.contactDetail)) return false;
    ["active", "users", "agents", "devices", "feedback", "contacts"].forEach(function(key) {
      if (saved[key]) Object.assign(state[key], saved[key]);
    });
    var feedbackGroup = { ACCEPTED: "ACTIVE", IN_PROGRESS: "ACTIVE", IGNORED: "COMPLETED", RESOLVED: "COMPLETED" }[state.feedback.status];
    if (feedbackGroup || !FEEDBACK_FILTER_TEXT[state.feedback.status]) {
      state.feedback.status = feedbackGroup || "PENDING";
      state.feedback.page = 1;
    }
    state.members = saved.members ? Object.assign({}, saved.members) : null;
    state.feedbackDetail = saved.feedbackDetail ? Object.assign({}, saved.feedbackDetail) : null;
    state.contactDetail = saved.contactDetail ? Object.assign({}, saved.contactDetail) : null;
    ["users", "agents", "devices"].forEach(function(key) { $("#" + key + "-keyword").value = state[key].keyword; });
    renderDimensionSeg(); renderGranularitySeg(); renderDaysSeg(); renderScopeSeg();
    showTab(saved.tab, false, "restore");
    return true;
  }

  window.addEventListener("popstate", function(event) {
    if (!state.me) return;
    if (!restoreNavigation(event.state)) showTab("overview", false, "replace");
  });

  function showTab(tab, force, navigationMode) {
    if (!TABS[tab]) tab = "overview";
    if ($("#user-detail").open) $("#user-detail").close();
    if ($("#device-detail").open) $("#device-detail").close();
    state.tab = tab;
    recordNavigation(navigationMode);
    selectTabButtons();
    if (tab === "agents" || tab === "devices") syncOwnerFilter(tab);
    var def = TABS[tab];
    var host = def.host();
    var key = def.key();
    var cached = state.cache[tab];
    // Each switch or request increments the sequence and only the latest counts: an earlier slow request (e.g. searching ab) that returns late
    // must not overwrite the later result (searching abc) or be written to the cache; after switching away and back via cache, old in-flight requests are discarded too
    var seq = state.seq = (state.seq || 0) + 1;
    if (!force && cached && cached.key === key) {
      refreshButton.disabled = false;
      def.render(host, cached.data);
      return;
    }
    if (def.begin) def.begin();
    setState(host, "loading");
    refreshButton.disabled = true;
    def.load().then(function (data) {
      if (seq !== state.seq) return;
      state.cache[tab] = { key: key, data: data };
      def.render(host, data);
    }).catch(function (err) {
      // When the login state has expired the whole page has already switched back to the login view; don't overwrite it with an error state here
      if (err && err.name === "AuthError") return;
      if (seq === state.seq) setState(host, "error", err && err.message, function () { showTab(tab, true); });
    }).then(function () {
      if (seq === state.seq) refreshButton.disabled = false;
    });
  }

  /* ---------- Control bindings ---------- */

  function buildSeg(host, options, current, onPick) {
    clear(host);
    options.forEach(function (opt) {
      var value = opt.value, label = opt.label;
      host.appendChild(el("button", {
        type: "button",
        text: label,
        "aria-pressed": String(value === current),
        onClick: function () { if (value !== current) onPick(value); }
      }));
    });
  }

  function renderGranularitySeg() {
    buildSeg($("#seg-granularity"), [
      { value: "day", label: "按天" },
      { value: "hour", label: "按小时" }
    ], state.active.granularity, function (value) {
      state.active.granularity = value;
      var allowed = value === "hour" ? HOUR_OPTIONS : DAY_OPTIONS;
      // In hourly mode days is limited to 1-7; out of range falls back to the max days for that granularity
      if (allowed.indexOf(state.active.days) < 0) state.active.days = allowed[allowed.length - 1];
      renderGranularitySeg();
      renderDaysSeg();
      showTab("active", true);
    });
  }

  function renderDaysSeg() {
    var options = (state.active.granularity === "hour" ? HOUR_OPTIONS : DAY_OPTIONS).map(function (d) {
      return { value: d, label: d + " 天" };
    });
    buildSeg($("#seg-days"), options, state.active.days, function (value) {
      state.active.days = value;
      renderDaysSeg();
      showTab("active", true);
    });
  }

  function renderFeedbackStatusSeg(counts) {
    var label = function (name, keys) {
      return name + (counts ? " " + count(keys.reduce(function (total, key) { return total + (Number(counts[key]) || 0); }, 0)) : "");
    };
    buildSeg($("#seg-feedback-status"), [
      { value: "PENDING", label: label("待处理", ["PENDING"]) },
      { value: "ACTIVE", label: label("进行中", ["ACCEPTED", "IN_PROGRESS"]) },
      { value: "COMPLETED", label: label("已完成", ["IGNORED", "RESOLVED"]) }
    ], state.feedback.status, function (value) {
      state.feedback.status = value;
      state.feedback.page = 1;
      showTab("feedback", true);
    });
  }

  function renderScopeSeg() {
    buildSeg($("#seg-scope"), [
      { value: "all", label: "全部终端" },
      { value: "terminal", label: "仅已登记终端" },
      { value: "online", label: "仅在线终端" }
    ], state.devices.scope, function (value) {
      state.devices.scope = value;
      state.devices.page = 1;
      renderScopeSeg();
      showTab("devices", true);
    });
  }

  function bindSearch(inputId, target, tabName) {
    var input = $(inputId);
    var run = debounce(function () {
      target.keyword = input.value.trim();
      target.page = 1;
      showTab(tabName, true);
    }, 300);
    input.addEventListener("input", run);
    input.addEventListener("search", run);
  }

  $("#login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var username = $("#login-username").value.trim();
    var password = $("#login-password").value;
    var box = $("#login-error");
    if (!username || !password) {
      box.textContent = "请输入用户名和密码";
      box.hidden = false;
      return;
    }
    var button = $("#login-submit");
    button.disabled = true;
    button.textContent = "登录中…";
    box.hidden = true;
    request("POST", "api/login", { body: { username: username, password: password } }).then(function (data) {
      $("#login-password").value = "";
      state.cache = {};
      state.tab = "overview";
      showApp(data || {});
      selectTabButtons();
      showTab("overview", true, "replace");
    }).catch(function (err) {
      if (err && err.name === "AuthError") return;
      box.textContent = (err && err.message) || "登录失败，请稍后重试";
      box.hidden = false;
      $("#login-password").value = "";
      $("#login-password").focus();
    }).then(function () {
      button.disabled = false;
      button.textContent = "登录";
    });
  });

  $("#btn-logout").addEventListener("click", function () {
    var button = $("#btn-logout");
    button.disabled = true;
    request("POST", "api/logout", { silentAuth: true }).catch(function () { /* Even if logout fails, return to the login view */ }).then(function () {
      button.disabled = false;
      state.users.keyword = "";
      state.devices.keyword = "";
      state.users.page = 1;
      state.devices.page = 1;
      clearOwnerFilter("agents");
      clearOwnerFilter("devices");
      $("#users-keyword").value = "";
      $("#devices-keyword").value = "";
      showLogin(null);
    });
  });

  refreshButton.addEventListener("click", function () { showTab(state.tab, true); });

  Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (button) {
    button.addEventListener("click", function () { showTab(button.getAttribute("data-tab"), false); });
  });

  bindSearch("#users-keyword", state.users, "users");
  bindSearch("#devices-keyword", state.devices, "devices");
  state.active.dimension = "devices";
  function renderDimensionSeg() {
    buildSeg($("#seg-dimension"), [{value:"users",label:"用户"},{value:"devices",label:"终端"}], state.active.dimension, function(value) {
      state.active.dimension=value; renderDimensionSeg(); showTab("active");
    });
  }
  renderDimensionSeg();
  renderGranularitySeg();
  renderDaysSeg();
  renderScopeSeg();

  // The chart is recomputed from container width and redrawn when the window or sidebar changes, so labels don't pile up
  if (typeof ResizeObserver === "function") {
    var schedule = null;
    new ResizeObserver(function () {
      if (schedule) return;
      schedule = requestAnimationFrame(function () {
        schedule = null;
        if (!$("#panel-active").hidden && lastActiveData) drawChart();
      });
    }).observe($("#active-chart-wrap"));
  } else {
    window.addEventListener("resize", debounce(function () {
      if (!$("#panel-active").hidden && lastActiveData) drawChart();
    }, 150));
  }

  request("GET", "api/me", { silentAuth: true }).then(function (me) {
    showApp(me || {});
    selectTabButtons();
    if (!restoreNavigation(history.state)) showTab("overview", true, "replace");
  }).catch(function (err) {
    if (err && err.name === "AuthError") { showLogin(null); return; }
    showLogin(err && err.message);
  });
})();
