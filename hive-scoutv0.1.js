const { Client, PrivateKey } = require('@hiveio/dhive');
const fs = require('fs');
const readline = require('readline');

// --- 1. CONFIGURATION ---
const parseIni = (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const config = {};
        let section = '';
        content.split(/\r?\n/).forEach(line => {
            line = line.trim();
            if (!line || line.startsWith(';')) return;
            if (line.startsWith('[') && line.endsWith(']')) {
                section = line.slice(1, -1);
                config[section] = {};
            } else {
                const [key, ...val] = line.split('=');
                if (section) config[section][key.trim()] = val.join('=').trim();
            }
        });
        return config;
    } catch (e) { process.exit(1); }
};

let INI = parseIni('settings.ini');
const CONFIG = {
    account: INI.ACCOUNT.username,
    vote_weight: parseInt(INI.ACCOUNT.vote_weight),
    mode: parseInt(INI.ACCOUNT.mode),
    vp_threshold: parseFloat(INI.ACCOUNT.vp_threshold || "15.0"),
    recharge_ms: parseInt(INI.ACCOUNT.recharge_vp_time || "1800000"),
    logger_account: INI.ACCOUNT.logger_account,
    log_link: INI.ACCOUNT.log_post_link,
    word_count_min: parseInt(INI.RULES.word_count),
    image_count_min: parseInt(INI.RULES.image_count),
    fast_word_min: parseInt(INI.RULES.fast_word_min),
    fast_image_min: parseInt(INI.RULES.fast_image_min),
    second_word_min: parseInt(INI.RULES.second_standard_rule_min_words || "99999"),
    second_image_min: parseInt(INI.RULES.second_standard_rule_min_imgs || "99999"),
    freshness_seconds: parseInt(INI.RULES.freshness_seconds),
    panic_sleep: parseInt(INI.RULES.panic_sleep_ms) || 3000,
    tags_to_skip: (INI.RULES['tags-to-skip'] || "").split(',').map(t => t.trim().toLowerCase()).filter(t => t),
    files: INI.FILES,
    display: INI.LOG_DISPLAY,
    memory_file: "scanner_memory.json"
};

// --- 2. GLOBAL STATE ---
let NODES = ["https://api.deathwing.me", "https://api.hive.blog", "https://anyx.io"];
const C = { res: "\x1b[0m", grn: "\x1b[32m", ylw: "\x1b[33m", cyn: "\x1b[36m", mag: "\x1b[35m", red: "\x1b[31m", bld: "\x1b[1m", wht: "\x1b[37m" };

let STATE = {
    client: null,
    vp_val: 0.0,
    vp_str: "Init...",
    is_recharging: false,
    lists: { follow: new Set(), mute: new Set(), new: new Set(), pending: new Set(), testers: new Set(), blacklist: new Set() },
    edit_tracker: {}, 
    edit_jail: new Map(),
    intervals: [],
    stats: { scanned: 0, voted: 0, rejected: 0, reports: 0, multipliers: 0 } // Stats for v0.49
};

// --- 3. PERSISTENCE & HELPERS ---
const saveFloatingMemory = () => {
    try {
        const data = { edit_tracker: STATE.edit_tracker, edit_jail: Array.from(STATE.edit_jail.entries()) };
        fs.writeFileSync(CONFIG.memory_file, JSON.stringify(data));
    } catch (e) {}
};

const loadFloatingMemory = () => {
    try {
        if (fs.existsSync(CONFIG.memory_file)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.memory_file, 'utf8'));
            STATE.edit_tracker = data.edit_tracker || {};
            STATE.edit_jail = new Map(data.edit_jail || []);
            console.log(`[${getTime12()}] ${C.grn}📂 Memory restored.${C.res}`);
        }
    } catch (e) {}
};

const getTime12 = () => new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const logSafe = (msg) => { 
    readline.clearLine(process.stdout, 0); 
    readline.cursorTo(process.stdout, 0);
    console.log(`[${getTime12()}] ${msg}`); 
};

// --- 4. LOGGING ---
const postLogTable = async (data) => {
    try {
        const d = CONFIG.display;
        let head = "|", sep = "|", row = "|";
        const mapping = [
            { key: 'show_time', label: 'Time', val: data.time },
            { key: 'show_author', label: 'Author', val: data.author },
            { key: 'show_link', label: 'Link', val: `[PeakD](https://peakd.com/@${data.author}/${data.permlink})` },
            { key: 'show_block', label: 'Block', val: data.block },
            { key: 'show_trx', label: 'TRX ID', val: `[Link](https://hiveblockexplorer.com/tx/${data.trx})` },
            { key: 'show_reason', label: 'Type', val: data.type },
            { key: 'show_details', label: 'Details', val: data.details }
        ];
        mapping.forEach(m => { if (d[m.key] === "1") { head += ` ${m.label} |`; sep += " --- |"; row += ` ${m.val} |`; }});
        const key = PrivateKey.fromString(fs.readFileSync(CONFIG.files.logger_posting_key, 'utf8').trim());
        const parts = CONFIG.log_link.replace('@', '').split('/');
        await STATE.client.broadcast.comment({
            author: CONFIG.logger_account, body: `${head}\n${sep}\n${row}`, json_metadata: JSON.stringify({ app: 'scanner/0.49' }),
            parent_author: parts[0], parent_permlink: parts[1], permlink: 'log-' + Date.now(), title: ''
        }, key);
        STATE.stats.reports++;
        logSafe(`${C.ylw}📝 Report sent for @${data.author} (${data.type})${C.res}`);
    } catch (e) {}
};

// --- 5. CORE LOGIC ---
const processPost = async (author, permlink, blockNum, trxId) => {
    if (STATE.is_recharging) return;
    STATE.stats.scanned++;
    try {
        const authorL = author.toLowerCase();
        const postID = `${authorL}/${permlink}`;

        if (STATE.edit_jail.has(authorL)) {
            if (Date.now() - STATE.edit_jail.get(authorL) < 86400000) return;
            else STATE.edit_jail.delete(authorL);
        }

        const isKnown = STATE.lists.mute.has(authorL) || STATE.lists.new.has(authorL) || STATE.lists.pending.has(authorL) || STATE.lists.blacklist.has(authorL);
        if (isKnown && !STATE.lists.follow.has(authorL)) return;

        await new Promise(r => setTimeout(r, 2000));
        const content = await STATE.client.database.call('get_content', [author, permlink]);
        if (!content || !content.body) return;

        // Edit Jail Logic
        const created = new Date(content.created + 'Z').getTime();
        const ageSec = (Date.now() - created) / 1000;
        if (ageSec > (CONFIG.freshness_seconds + 60)) {
            STATE.edit_tracker[postID] = (STATE.edit_tracker[postID] || 0) + 1;
            if (STATE.edit_tracker[postID] >= 2) {
                STATE.edit_jail.set(authorL, Date.now());
                logSafe(`${C.red}⚖️ JAILED: @${author}${C.res}`);
                await postLogTable({ time: getTime12(), author, permlink, block: blockNum, trx: trxId, type: "EDIT JAIL", details: "Late edit." });
                saveFloatingMemory();
            }
            return;
        }

        // Tag Logic
        let meta = {}; try { meta = JSON.parse(content.json_metadata); } catch(e){}
        const postTags = (meta.tags || []).map(t => t.toLowerCase());
        const hitTag = CONFIG.tags_to_skip.find(t => postTags.includes(t));
        if (hitTag) {
            await postLogTable({ time: getTime12(), author, permlink, block: blockNum, trx: trxId, type: "TAG REJECTION", details: `Tag: ${hitTag}` });
            STATE.stats.rejected++;
            return;
        }

        // Quality Logic
        const words = content.body.split(/\s+/).filter(x => x.length > 1).length;
        const imgRegex = /!\[.*?\]\((.*?)\)|<img.*?src=["'](.*?)["']|https?:\/\/\S+\.(?:jpg|jpeg|gif|png|webp|svg)/gi;
        const imgs = (content.body.match(imgRegex) || []).length;
        const isFollowed = STATE.lists.follow.has(authorL);

        logSafe(`${C.cyn}Scanning @${author}: ${words}w, ${imgs}i (Followed: ${isFollowed})${C.res}`);

        let rejectType = null;
        const passedFast = isFollowed && words >= CONFIG.fast_word_min && imgs >= CONFIG.fast_image_min;
        const passedStandard = (words >= CONFIG.word_count_min && imgs >= CONFIG.image_count_min) || (words >= CONFIG.second_word_min && imgs >= CONFIG.second_image_min);

        if (isFollowed) {
            if (!passedFast && !passedStandard) rejectType = "FAST TRACK REJECTION";
        } else {
            if (!passedStandard) rejectType = "STANDARD RULE REJECTION";
        }

        if (rejectType) {
            await postLogTable({ time: getTime12(), author, permlink, block: blockNum, trx: trxId, type: rejectType, details: `${words}w/${imgs}i` });
            STATE.stats.rejected++;
            return;
        }

        // --- Multiplier Integration v0.49 ---
        let finalWeight = CONFIG.vote_weight;
        if (passedFast) {
            finalWeight = Math.min(10000, CONFIG.vote_weight * 2);
            STATE.stats.multipliers++;
            logSafe(`${C.mag}🚀 FAST TRACK MULTIPLIER: Voting ${finalWeight/100}% on @${author}${C.res}`);
        }

        const key = PrivateKey.fromString(fs.readFileSync(CONFIG.files.posting_key, 'utf8').trim());
        await STATE.client.broadcast.vote({ voter: CONFIG.account, author, permlink, weight: finalWeight }, key);
        STATE.stats.voted++;
        logSafe(`${C.grn}🗳 VOTE SUCCESS: @${author}${C.res}`);
    } catch (err) {}
};

// --- 6. ENGINE & HIBERNATION ---
const deepSleep = async () => {
    STATE.is_recharging = true;
    logSafe(`${C.mag}💤 VP LOW (${STATE.vp_val}%). HIBERNATING...${C.res}`);
    saveFloatingMemory();
    STATE.intervals.forEach(clearInterval);
    STATE.intervals = [];
    STATE.client = null;
    await new Promise(r => setTimeout(r, CONFIG.recharge_ms));
    logSafe(`${C.grn}🔋 WAKING UP...${C.res}`);
    STATE.is_recharging = false;
    start();
};

const syncList = async (type, key) => {
    let res = [], start = "";
    while(true) {
        try {
            const batch = await STATE.client.call('condenser_api', 'get_following', [CONFIG.account, start, type, 1000]);
            if (!batch || !batch.length) break;
            batch.forEach(e => { if (e.following !== start || !start) res.push(e.following.toLowerCase()); });
            if (batch.length < 1000) break;
            start = batch[batch.length - 1].following;
        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
    STATE.lists[key] = new Set(res);
    logSafe(`✓ ${key} synced`);
};

const start = async () => {
    STATE.client = new Client(NODES, { timeout: 4000 });
    loadFloatingMemory();
    const loadFile = (f, k) => { if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split('\n').forEach(u => { if(u.trim()) STATE.lists[k].add(u.trim().toLowerCase()); }); };
    loadFile(CONFIG.files.new_users, 'new'); loadFile(CONFIG.files.pending, 'pending'); loadFile(CONFIG.files.blacklist, 'blacklist');
    await syncList('blog', 'follow'); await syncList('ignore', 'mute');

    try {
        const [acc] = await STATE.client.database.getAccounts([CONFIG.account]);
        STATE.vp_val = acc.voting_power / 100;
        STATE.vp_str = STATE.vp_val.toFixed(2) + "%";
        logSafe(`${C.cyn}Init VP: ${STATE.vp_str}${C.res}`);
    } catch(e) {}

    // VP Monitor
    STATE.intervals.push(setInterval(async () => {
        try {
            const [acc] = await STATE.client.database.getAccounts([CONFIG.account]);
            const lastVote = new Date(acc.last_vote_time + 'Z').getTime();
            const regen = ((Date.now() - lastVote) / 1000 * 10000) / 432000;
            STATE.vp_val = Math.min(10000, acc.voting_power + regen) / 100;
            STATE.vp_str = STATE.vp_val.toFixed(2) + "%";
            if (CONFIG.mode === 1 && STATE.vp_val < CONFIG.vp_threshold) deepSleep();
        } catch (e) {}
    }, 15000));

    // --- Stats Summary Interval (New in v0.49) ---
    STATE.intervals.push(setInterval(() => {
        console.log(`\n${C.bld}${C.wht}--- HOURLY PERFORMANCE SUMMARY ---${C.res}`);
        console.table({
            "Posts Scanned": STATE.stats.scanned,
            "Total Votes": STATE.stats.voted,
            "Total Rejections": STATE.stats.rejected,
            "Log Reports Sent": STATE.stats.reports,
            "2x Bonus Multipliers": STATE.stats.multipliers
        });
        console.log(`${C.wht}----------------------------------${C.res}\n`);
    }, 3600000)); // Every 60 Minutes

    // Block Stream
    let lastBlock = 0;
    STATE.intervals.push(setInterval(async () => {
        if (STATE.is_recharging) return;
        process.stdout.write(`\r${getTime12()} 💓 Block: ${lastBlock} | VP: ${STATE.vp_str} `);
        try {
            const props = await STATE.client.database.getDynamicGlobalProperties();
            const head = props.head_block_number;
            if (lastBlock === 0) lastBlock = head - 1;
            if (head > lastBlock) {
                for (let b = lastBlock + 1; b <= head; b++) {
                    const block = await STATE.client.database.getBlock(b);
                    if (block?.transactions) {
                        block.transactions.forEach(tx => tx.operations.forEach(op => {
                            if (op[0] === 'comment' && op[1].parent_author === '') processPost(op[1].author, op[1].permlink, b, tx.transaction_id);
                        }));
                    }
                }
                lastBlock = head;
            }
        } catch (e) {
            process.stdout.write(`\r${C.red}[ERR] Node Error: ${e.message.substring(0, 30)}${C.res}`);
        }
    }, 3000));
};

start();
