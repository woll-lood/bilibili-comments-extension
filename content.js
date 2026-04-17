// content.js - 优化版 + 支持 av 号
// 功能：B站视频/番剧/动态评论爬取，支持 BV/av 号、二级评论、暂停/继续、断点续爬、低内存占用

// 确保 CryptoJS 可用
if (typeof CryptoJS === 'undefined') {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('lib/crypto-js.min.js');
    script.onload = function() { this.remove(); initCrawler(); };
    (document.head || document.documentElement).appendChild(script);
} else {
    initCrawler();
}

async function initCrawler() {
    // ==================== 样式注入 ====================
    const style = document.createElement('style');
    style.textContent = `
        #bili-comment-crawler { position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: white; border: 1px solid #e7e7e7; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 320px; font-family: 'Microsoft YaHei', sans-serif; overflow: hidden; }
        .crawler-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: #f5f5f5; cursor: pointer; border-bottom: 1px solid #eee; }
        .crawler-title { font-size: 16px; font-weight: bold; color: #00a1d6; }
        .crawler-toggle { font-size: 18px; color: #999; transition: transform 0.3s; }
        .crawler-body { padding: 15px; display: none; }
        .crawler-stats { display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-bottom: 10px; }
        .crawler-buttons { display: flex; gap: 10px; margin-bottom: 10px; }
        .crawler-btn { flex: 1; padding: 8px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .btn-start { background: #00a1d6; color: white; }
        .btn-start:hover { background: #0087b3; }
        .btn-pause { background: #ff9800; color: white; }
        .btn-pause:hover { background: #e68900; }
        .btn-continue { background: #4caf50; color: white; }
        .btn-continue:hover { background: #3e8e41; }
        .btn-download { background: #52c41a; color: white; }
        .btn-download:hover { background: #389e0d; }
        .crawler-log { max-height: 150px; overflow-y: auto; font-size: 12px; color: #666; border: 1px solid #eee; border-radius: 4px; padding: 8px; background: #fafafa; }
        .log-entry { margin-bottom: 4px; line-height: 1.4; }
        .log-time { color: #999; margin-right: 5px; }
        .log-error { color: #ff4d4f; }
        .log-warning { color: #faad14; }
        .watermark { text-align: center; font-size: 10px; color: #aaa; padding: 5px; border-top: 1px solid #eee; background: #f9f9f9; }
        .expanded .crawler-toggle { transform: rotate(180deg); }
        .expanded .crawler-body { display: block; }
    `;
    document.head.appendChild(style);

    // ==================== UI 创建 ====================
    const container = document.createElement('div');
    container.id = 'bili-comment-crawler';
    container.innerHTML = `
        <div class="crawler-header">
            <div class="crawler-title">B站评论爬取工具</div>
            <div class="crawler-toggle">▼</div>
        </div>
        <div class="crawler-body">
            <div class="crawler-stats">
                <span>已爬取: <span id="crawled-count">0</span> 条</span>
                <span>状态: <span id="crawler-status">就绪</span></span>
            </div>
            <div class="crawler-buttons">
                <button class="crawler-btn btn-start" id="start-crawl">开始爬取</button>
                <button class="crawler-btn btn-pause" id="pause-crawl" disabled>暂停</button>
                <button class="crawler-btn btn-download" id="download-csv" disabled>下载CSV</button>
            </div>
            <div class="crawler-log" id="crawler-log"></div>
        </div>
        <div class="watermark">Created by Ldyer (优化版+av支持)</div>
    `;
    document.body.appendChild(container);

    const header = container.querySelector('.crawler-header');
    const toggleBtn = container.querySelector('.crawler-toggle');
    const body = container.querySelector('.crawler-body');
    const startBtn = container.querySelector('#start-crawl');
    const pauseBtn = container.querySelector('#pause-crawl');
    const downloadBtn = container.querySelector('#download-csv');
    const crawledCountSpan = container.querySelector('#crawled-count');
    const crawlerStatusSpan = container.querySelector('#crawler-status');
    const crawlerLogDiv = container.querySelector('#crawler-log');

    let isExpanded = false;
    header.addEventListener('click', () => {
        isExpanded = !isExpanded;
        container.classList.toggle('expanded', isExpanded);
    });

    // ==================== 辅助函数 ====================
    function addLog(message, type = 'info') {
        const now = new Date();
        const timeStr = now.toTimeString().substring(0, 8);
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        if (type === 'error') logEntry.classList.add('log-error');
        if (type === 'warning') logEntry.classList.add('log-warning');
        logEntry.innerHTML = `<span class="log-time">[${timeStr}]</span> ${message}`;
        crawlerLogDiv.appendChild(logEntry);
        crawlerLogDiv.scrollTop = crawlerLogDiv.scrollHeight;
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // 带重试的 fetch
    async function fetchWithRetry(url, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const response = await fetch(url, {
                    credentials: 'include',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                        'Referer': window.location.href
                    },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                if (json.code !== 0) throw new Error(`API error: ${json.message}`);
                return json;
            } catch (e) {
                if (i === retries - 1) throw e;
                await sleep(delay * (i + 1));
            }
        }
    }

    // MD5 加密
    function md5(str) { return CryptoJS.MD5(str).toString(); }

    // 获取页面类型和ID（支持 BV 和 av）
    function getPageInfo() {
        const path = window.location.pathname;
        if (path.includes('/video/')) {
            // 匹配 BV 号
            let match = path.match(/\/video\/(BV\w+)/);
            if (match) return { type: 'video', id: match[1] };
            // 匹配 av 号
            match = path.match(/\/video\/av(\d+)/);
            if (match) return { type: 'video', id: match[1] };
            return { type: 'video', id: '' };
        } else if (path.includes('/bangumi/play/')) {
            const match = path.match(/\/bangumi\/play\/(\w+)/);
            return { type: 'bangumi', id: match ? match[1] : '' };
        } else if (path.includes('/opus/')) {
            const match = path.match(/\/opus\/(\w+)/);
            return { type: 'opus', id: match ? match[1] : '' };
        }
        return null;
    }

    // 通过 API 获取 oid 和标题（支持 BV 和 av）
    async function getInformation(pageType, id) {
        if (pageType === 'video' || pageType === 'bangumi') {
            let apiUrl;
            // 判断 id 是否为纯数字（av 号）
            if (/^\d+$/.test(id)) {
                apiUrl = `https://api.bilibili.com/x/web-interface/view?aid=${id}`;
            } else {
                apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${id}`;
            }
            const data = await fetchWithRetry(apiUrl);
            return { oid: data.data.aid.toString(), title: data.data.title };
        } else if (pageType === 'opus') {
            const apiUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}`;
            const data = await fetchWithRetry(apiUrl);
            const authorName = data.data.item.modules.module_author.name;
            return { oid: data.data.item.id_str, title: `${authorName}的动态` };
        }
        throw new Error('未知页面类型');
    }

    // 构建带签名的 API URL
    function buildApiUrl(oid, offset, mode, type) {
        const wts = Math.floor(Date.now() / 1000);
        const pagination_str = JSON.stringify({ offset: offset || "" });
        const encoded = encodeURIComponent(pagination_str);
        let code;
        if (offset) {
            code = `mode=${mode}&oid=${oid}&pagination_str=${encoded}&plat=1&type=${type}&web_location=1315875&wts=${wts}ea1db124af3c7062474693fa704f4ff8`;
        } else {
            code = `mode=${mode}&oid=${oid}&pagination_str=${encoded}&plat=1&seek_rpid=&type=${type}&web_location=1315875&wts=${wts}ea1db124af3c7062474693fa704f4ff8`;
        }
        const w_rid = md5(code);
        return `https://api.bilibili.com/x/v2/reply/wbi/main?oid=${oid}&type=${type}&mode=${mode}&pagination_str=${encoded}&plat=1${offset ? '' : '&seek_rpid='}&web_location=1315875&w_rid=${w_rid}&wts=${wts}`;
    }

    // 提取评论信息
    function extractComment(reply) {
        const member = reply.member || {};
        const content = reply.content || {};
        const replyControl = reply.reply_control || {};
        const upAction = reply.up_action || {};
        let subCount = 0;
        if (replyControl.sub_reply_entry_text) {
            const match = replyControl.sub_reply_entry_text.match(/\d+/);
            subCount = match ? parseInt(match[0]) : 0;
        }
        return {
            parent: reply.parent || 0,
            rpid: reply.rpid,
            uid: reply.mid,
            name: member.uname || '',
            level: (member.level_info && member.level_info.current_level) || 0,
            sex: member.sex || '未知',
            avatar: member.avatar || '',
            vip: (member.vip && member.vip.vipStatus === 1) ? '是' : '否',
            ip: (replyControl.location && replyControl.location.slice(5)) || '未知',
            message: content.message || '',
            ctime: new Date(reply.ctime * 1000).toISOString(),
            subCount: subCount,
            like: reply.like || 0,
            sign: member.sign || '',
            upLike: upAction.like ? '是' : '否',
            upReply: upAction.reply ? '是' : '否'
        };
    }

    // ==================== IndexedDB 存储管理 ====================
    let db = null;
    const DB_NAME = 'BiliCommentCrawler';
    const STORE_NAME = 'comments';
    const BATCH_SIZE = 500; // 每500条写入一次数据库

    async function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'seq' });
                }
            };
        });
    }

    async function saveCommentBatch(batch) {
        if (!db) db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const item of batch) {
            store.put(item);
        }
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });
    }

    async function getAllComments() {
        if (!db) db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const items = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return items.sort((a,b) => a.seq - b.seq);
    }

    async function clearComments() {
        if (!db) db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });
    }

    // ==================== 爬取状态机 ====================
    let isCrawling = false;
    let isPaused = false;
    let stopRequested = false;
    let pausePromise = Promise.resolve();
    let pauseResolve = null;
    let currentCount = 0;
    let commentBuffer = [];       // 缓冲区，达到 BATCH_SIZE 时写入 DB
    let lastSaveSeq = 0;          // 用于断点续爬（存储上次保存的序号）
    let currentOffset = '';
    let currentOid = '';
    let currentMode = 2;
    let currentType = 1;
    let totalFetched = 0;         // 已从DB恢复的数量

    function setPaused(value) {
        if (value === isPaused) return;
        isPaused = value;
        if (isPaused) {
            pausePromise = new Promise(resolve => { pauseResolve = resolve; });
            crawlerStatusSpan.textContent = '已暂停';
            pauseBtn.textContent = '继续';
            pauseBtn.classList.remove('btn-pause');
            pauseBtn.classList.add('btn-continue');
            downloadBtn.disabled = false; // 暂停时可下载
        } else {
            if (pauseResolve) pauseResolve();
            pausePromise = Promise.resolve();
            crawlerStatusSpan.textContent = '爬取中...';
            pauseBtn.textContent = '暂停';
            pauseBtn.classList.remove('btn-continue');
            pauseBtn.classList.add('btn-pause');
            downloadBtn.disabled = true;
        }
    }

    async function waitIfPaused() {
        if (!isPaused) return;
        await pausePromise;
    }

    async function flushBuffer() {
        if (commentBuffer.length === 0) return;
        await saveCommentBatch(commentBuffer);
        commentBuffer = [];
    }

    async function addComment(comment) {
        const seq = ++currentCount;
        comment.seq = seq;
        commentBuffer.push(comment);
        if (commentBuffer.length >= BATCH_SIZE) {
            await flushBuffer();
        }
        crawledCountSpan.textContent = currentCount;
    }

    // 二级评论爬取（并发控制）
    async function fetchSubComments(oid, rootRpid, total, type, concurrency = 3) {
        const pageSize = 20;
        const totalPages = Math.ceil(total / pageSize);
        let page = 1;
        const queue = [];
        while (page <= totalPages) {
            await waitIfPaused();
            if (stopRequested) break;
            const task = (async () => {
                const url = `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${rootRpid}&ps=${pageSize}&pn=${page}&web_location=333.788`;
                try {
                    const data = await fetchWithRetry(url);
                    const replies = data.data?.replies || [];
                    for (const rep of replies) {
                        await waitIfPaused();
                        if (stopRequested) break;
                        const comment = extractComment(rep);
                        await addComment(comment);
                        // 递归抓取更深层（如果存在）
                        if (comment.subCount > 0) {
                            await fetchSubComments(oid, comment.rpid, comment.subCount, type, concurrency);
                        }
                    }
                } catch (e) {
                    addLog(`二级评论请求失败: ${e.message}`, 'error');
                }
            })();
            queue.push(task);
            if (queue.length >= concurrency || page === totalPages) {
                await Promise.all(queue);
                queue.length = 0;
            }
            page++;
            await sleep(300);
        }
    }

    // 主爬取循环
    async function startCrawl(isSecond = true) {
        const pageInfo = getPageInfo();
        if (!pageInfo || !pageInfo.id) {
            addLog('无法识别页面类型或ID', 'error');
            isCrawling = false;
            return;
        }
        addLog(`页面类型: ${pageInfo.type}, ID: ${pageInfo.id}`);

        try {
            const info = await getInformation(pageInfo.type, pageInfo.id);
            currentOid = info.oid;
            addLog(`标题: ${info.title}`);
            addLog(`oid: ${currentOid}`);
        } catch (e) {
            addLog(`获取基本信息失败: ${e.message}`, 'error');
            isCrawling = false;
            return;
        }

        // 设置 mode 和 type
        if (pageInfo.type === 'opus') {
            currentMode = 3;   // 动态用热门评论
            currentType = 11;
        } else {
            currentMode = 2;   // 视频/番剧用最新评论
            currentType = 1;
        }

        // 恢复上次进度（如果有）
        const savedOffset = localStorage.getItem('crawler_offset');
        const savedCount = parseInt(localStorage.getItem('crawler_count') || '0');
        if (savedOffset && savedCount > 0 && confirm('检测到上次未完成的爬取，是否继续？')) {
            currentOffset = savedOffset;
            currentCount = savedCount;
            totalFetched = savedCount;
            crawledCountSpan.textContent = currentCount;
            addLog(`恢复进度，已爬取 ${currentCount} 条，从 offset=${currentOffset} 继续`);
        } else {
            currentOffset = '';
            currentCount = 0;
            totalFetched = 0;
            await clearComments();
            localStorage.removeItem('crawler_offset');
            localStorage.removeItem('crawler_count');
        }

        let page = 1;
        while (true) {
            await waitIfPaused();
            if (stopRequested) break;

            const url = buildApiUrl(currentOid, currentOffset, currentMode, currentType);
            try {
                const data = await fetchWithRetry(url);
                const replies = data.data?.replies;
                if (!replies || replies.length === 0) {
                    addLog('没有更多评论，爬取结束');
                    break;
                }

                for (const reply of replies) {
                    await waitIfPaused();
                    if (stopRequested) break;
                    const comment = extractComment(reply);
                    await addComment(comment);

                    // 二级评论
                    if (isSecond && comment.subCount > 0) {
                        addLog(`正在爬取评论 ${comment.rpid} 的 ${comment.subCount} 条子评论...`);
                        await fetchSubComments(currentOid, comment.rpid, comment.subCount, currentType);
                    }

                    // 冷却机制：每100条暂停5秒，每1000条暂停30秒
                    if (currentCount % 100 === 0 && currentCount !== 0) {
                        addLog(`已爬取 ${currentCount} 条，暂停5秒...`, 'warning');
                        await waitIfPaused();
                        await sleep(5000);
                    }
                    if (currentCount % 1000 === 0 && currentCount !== 0) {
                        addLog(`已爬取 ${currentCount} 条，暂停30秒...`, 'warning');
                        await waitIfPaused();
                        await sleep(30000);
                    }

                    // 保存进度到 localStorage
                    localStorage.setItem('crawler_offset', currentOffset);
                    localStorage.setItem('crawler_count', currentCount);
                }

                const nextOffset = data.data?.cursor?.pagination_reply?.next_offset;
                if (!nextOffset) {
                    addLog('爬取完成！');
                    break;
                }
                currentOffset = nextOffset;
                addLog(`进入下一页，offset=${currentOffset}，当前总条数 ${currentCount}`);
                await sleep(500);
                page++;
            } catch (e) {
                addLog(`爬取失败: ${e.message}`, 'error');
                break;
            }
        }

        // 爬取结束
        await flushBuffer();
        localStorage.removeItem('crawler_offset');
        localStorage.removeItem('crawler_count');
        isCrawling = false;
        crawlerStatusSpan.textContent = '完成';
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        downloadBtn.disabled = false;
        pauseBtn.textContent = '暂停';
        pauseBtn.classList.remove('btn-continue');
        pauseBtn.classList.add('btn-pause');
        addLog(`全部完成！共爬取 ${currentCount} 条评论。`);
    }

    // ==================== CSV 导出 ====================
    async function exportCSV() {
        addLog('正在生成CSV文件...');
        const comments = await getAllComments();
        if (comments.length === 0) {
            addLog('没有评论数据', 'error');
            return;
        }
        const headers = ['序号', '上级评论ID', '评论ID', '用户ID', '用户名', '用户等级', '性别', '评论内容', '评论时间', '回复数', '点赞数', '个性签名', 'IP属地', '是否是大会员', '头像', 'UP主点赞', 'UP主回复'];
        const BOM = '\uFEFF';
        let csvContent = BOM + headers.join(',') + '\n';
        for (const c of comments) {
            const row = [
                c.seq,
                c.parent,
                c.rpid,
                c.uid,
                `"${(c.name || '').replace(/"/g, '""')}"`,
                c.level,
                c.sex,
                `"${(c.message || '').replace(/"/g, '""')}"`,
                c.ctime,
                c.subCount,
                c.like,
                `"${(c.sign || '').replace(/"/g, '""')}"`,
                c.ip,
                c.vip,
                c.avatar,
                c.upLike,
                c.upReply
            ];
            csvContent += row.join(',') + '\n';
        }
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeTitle = (document.title || 'B站评论').replace(/[\/\\:*?"<>|]/g, '_').substring(0, 50);
        a.download = `${safeTitle}_评论.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        addLog('CSV导出成功');
    }

    // ==================== 按钮事件绑定 ====================
    startBtn.addEventListener('click', async () => {
        if (isCrawling) return;
        isCrawling = true;
        stopRequested = false;
        isPaused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        downloadBtn.disabled = true;
        crawlerStatusSpan.textContent = '爬取中...';
        addLog('开始爬取评论...');
        try {
            await startCrawl(true);
        } catch (err) {
            addLog(`爬取出错: ${err.message}`, 'error');
            isCrawling = false;
            startBtn.disabled = false;
            pauseBtn.disabled = true;
            downloadBtn.disabled = false;
            crawlerStatusSpan.textContent = '错误';
        }
    });

    pauseBtn.addEventListener('click', () => {
        if (!isCrawling) return;
        setPaused(!isPaused);
    });

    downloadBtn.addEventListener('click', exportCSV);

    addLog('优化版爬虫已加载（支持 av 号），支持断点续爬和低内存占用');
}
