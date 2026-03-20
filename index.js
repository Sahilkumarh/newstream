const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

// ================= COLORS =================
const colors = {
  reset: "\x1b[0m", bright: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m",
  gray: "\x1b[90m", cyan: "\x1b[36m", magenta: "\x1b[35m"
};

const log = (msg, c = "reset") => console.log(`${colors[c]}${msg}${colors.reset}`);

// ================= CONFIG =================
const STREAM_FILE = "streams_pro.json";
const DEST_FILE = "destinations.json";
const LOG_FILE = "logs_pro.txt";
const YTDLP_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ================= HELPERS =================
let hasYtdlp = false;
try { hasYtdlp = spawnSync("yt-dlp", ["--version"]).status === 0; } catch(e){}

let streams = fs.existsSync(STREAM_FILE) ? JSON.parse(fs.readFileSync(STREAM_FILE)) : {};
let destinations = fs.existsSync(DEST_FILE) ? JSON.parse(fs.readFileSync(DEST_FILE)) : [];

function save(data, file) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e){} }

// --- SMART URL RESOLVER (1080p FIX) ---
// Tries to get separate Video/Audio URLs for 1080p, falls back to single URL.
function resolveUrls(url) {
  if (!hasYtdlp) return null;
  try {
    // Format: Best Video (mp4) + Best Audio (m4a), fallback to best single
    const args = ["-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best", "-g", url];
    const res = spawnSync("yt-dlp", args, { encoding: "utf8" });
    if (res.status !== 0) return null;
    
    const lines = res.stdout.trim().split("\n").filter(l => l.startsWith("http"));
    if (lines.length >= 2) return { video: lines[0], audio: lines[1] }; // 1080p+
    if (lines.length === 1) return { video: lines[0], audio: null };   // Fallback
    return null;
  } catch (e) { return null; }
}

// --- UPTIME & TIME HELPERS ---
function getUptime(startStr) {
  if (!startStr) return "--:--:--";
  const diff = Math.floor((Date.now() - new Date(startStr).getTime()) / 1000);
  const h = Math.floor(diff / 3600).toString().padStart(2,'0');
  const m = Math.floor((diff % 3600) / 60).toString().padStart(2,'0');
  const s = (diff % 60).toString().padStart(2,'0');
  return `${h}:${m}:${s}`;
}

function isTime(targetTime) {
  const now = new Date();
  const [h, m] = targetTime.split(':').map(Number);
  return now.getHours() === h && now.getMinutes() === m;
}

// ================= INPUT =================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

// ================= LOGIC =================

// 1. THE LAUNCHER
function launchStream(id, config) {
  // Sanity check
  if (streams[id] && (streams[id].status === "LIVE" || streams[id].status === "STARTING")) {
    log(`⚠️  Stream ${id} already active.`, "yellow");
    return;
  }

  const dest = destinations[config.destIndex];
  const rtmpUrl = dest ? `${dest.rtmp.replace(/\/$/, '')}/${dest.key.replace(/^\//, '')}` : null;

  log(`\n🚀 Launching ${id}...`, "cyan");
  writeLog(`Starting ${id} (${config.loop ? "Looping" : "Once"})`);

  // --- SMART INPUT HANDLING ---
  // Check if we need to resolve URLs (for YouTube 1080p)
  let inputArgs = [];
  let mapArgs = [];

  if (config.urls && config.urls.video) {
    // We have pre-resolved URLs (Restart case)
    if (config.urls.audio) {
      inputArgs = ["-i", config.urls.video, "-i", config.urls.audio];
      mapArgs = ["-map", "0:v", "-map", "1:a"];
    } else {
      inputArgs = ["-i", config.urls.video];
    }
  } else {
    // Fresh Start -> Resolve now
    log("🔍 Detecting best quality stream...", "yellow");
    const resolved = resolveUrls(config.url);
    if (resolved) {
      log("✅ Found High Quality Stream (1080p)", "green");
      if (resolved.audio) {
        inputArgs = ["-i", resolved.video, "-i", resolved.audio];
        mapArgs = ["-map", "0:v", "-map", "1:a"];
      } else {
        inputArgs = ["-i", resolved.video];
      }
      // Save resolved URLs for restarts
      config.urls = resolved;
      save(streams, STREAM_FILE);
    } else {
      log("⚠️  Detection failed. Using direct URL.", "yellow");
      inputArgs = ["-i", config.url];
    }
  }

  // --- FFmpeg ARGS ---
  // Re-encoding to ensure compatibility (VP9/AV1 -> H264)
  const ffmpegArgs = [
    "-re", 
    ...inputArgs,
    ...mapArgs,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", 
    "-c:a", "aac", "-b:a", "128k", 
    "-pix_fmt", "yuv420p", "-f", "flv",
    rtmpUrl
  ];

  if (!rtmpUrl && !config.recordLocal) {
    log("❌ No destination. Aborting.", "red");
    return;
  }

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "inherit", "pipe"] });
  
  // --- STATE UPDATE ---
  streams[id] = {
    ...streams[id],
    pid: ffmpeg.pid,
    status: "STARTING",
    started: new Date().toLocaleString(),
    error: "",
    config: config // Store full config for auto-restart/queue
  };
  save(streams, STREAM_FILE);

  // --- MONITORING ---
  let lastError = "Unknown error";
  ffmpeg.stderr.on("data", (d) => {
    const msg = d.toString();
    writeLog(`[FFmpeg] ${msg.trim()}`);
    if (msg.includes("Press [q]")) {
      streams[id].status = "LIVE";
      save(streams, STREAM_FILE);
      log(`✅ ${id} is LIVE`, "green");
    }
    if (msg.includes("Error") || msg.includes("403")) lastError = msg.trim();
  });

  ffmpeg.on("exit", (code) => {
    const s = streams[id];
    if (!s) return;

    // Logic: Loop? Queue? Or Stop?
    const shouldLoop = s.config.loop;
    const hasQueue = s.config.queue && s.config.queue.length > 0;

    if (shouldLoop && !hasQueue) {
      // AUTO RESTART (Loop Mode)
      log(`🔁 Looping ${id}...`, "yellow");
      setTimeout(() => launchStream(id, s.config), 2000); // 2s delay
    } else if (hasQueue) {
      // NEXT IN QUEUE
      const nextUrl = s.config.queue.shift(); // Remove current, get next
      log(`⏭️  Next in Queue: ${nextUrl}`, "cyan");
      s.config.url = nextUrl; // Update config
      s.config.urls = null; // Force re-resolve for new URL
      save(streams, STREAM_FILE);
      
      if (nextUrl) setTimeout(() => launchStream(id, s.config), 2000);
      else {
        s.status = "STOPPED"; // Queue empty
        save(streams, STREAM_FILE);
      }
    } else {
      // STOPPED
      s.status = code === 0 ? "STOPPED" : "FAILED";
      s.error = code !== 0 ? lastError : "";
      save(streams, STREAM_FILE);
      log(`🛑 Stream ${id} stopped.`, "gray");
    }
  });
}

// 2. SCHEDULER LOOP
// Checks every minute if a scheduled stream needs to start
setInterval(() => {
  for (let id in streams) {
    const s = streams[id];
    if (s.status === "SCHEDULED" && s.scheduleTime) {
      if (isTime(s.scheduleTime)) {
        log(`⏰ Starting scheduled stream: ${id}`, "magenta");
        s.status = "STARTING"; // Change status so it doesn't trigger again
        s.scheduleTime = null;
        save(streams, STREAM_FILE);
        launchStream(id, s.config);
      }
    }
  }
}, 10000); // Check every 10s

function writeLog(msg) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

// ================= MENUS =================

async function mainMenu() {
  while(true) {
    const active = Object.values(streams).filter(s => s.status === "LIVE").length;
    const sched = Object.values(streams).filter(s => s.status === "SCHEDULED").length;

    console.log(`\n${colors.bright}=====================================${colors.reset}`);
    console.log(`${colors.bright}   🚀 STREAM MANAGER PRO 🚀   ${colors.reset}`);
    console.log(`${colors.bright}=====================================${colors.reset}\n`);
    console.log(`  Active: ${colors.green}${active}${colors.reset} | Scheduled: ${colors.magenta}${sched}${colors.reset}\n`);

    console.log(`  ${colors.cyan}1.${colors.reset} Quick Start (Smart Auto-Config)`);
    console.log(`  ${colors.cyan}2.${colors.reset} Manage Streams (Stop/Details)`);
    console.log(`  ${colors.cyan}3.${colors.reset} Queue Manager`);
    console.log(`  ${colors.cyan}4.${colors.reset} Manage Destinations`);
    console.log(`  ${colors.red}5.${colors.reset} Exit\n`);

    const c = await ask("Choice: ");
    if (c === "1") await quickStart();
    if (c === "2") await manageStreams();
    if (c === "3") await queueManager();
    if (c === "4") await manageDests();
    if (c === "5") process.exit(0);
  }
}

// --- QUICK START (The "Just Work" Feature) ---
async function quickStart() {
  if (destinations.length === 0) {
    log("⚠️  No destinations. Please add one in Manage Destinations.", "red");
    return;
  }

  const id = await ask("Stream ID: ");
  const url = await ask("Video URL: ");
  
  // Defaults: Loop ON, Quality Auto, Dest #1
  const config = {
    url: url,
    destIndex: 0,
    loop: true, // DEFAULT: LOOP
    queue: [],  // DEFAULT: NO QUEUE (just loops single)
    recordLocal: false
  };

  // Optional: Ask for specific time
  const timeAns = await ask("Schedule for (HH:MM) or press Enter for Now: ");
  if (timeAns.trim()) {
    streams[id] = { status: "SCHEDULED", scheduleTime: timeAns, config: config };
    save(streams, STREAM_FILE);
    log(`✅ Scheduled ${id} for ${timeAns}`, "magenta");
  } else {
    launchStream(id, config);
  }
}

// --- QUEUE MANAGER ---
async function queueManager() {
  console.log("\n--- QUEUE MANAGER ---");
  console.log("1. Create Queue Stream");
  console.log("2. Add to Existing Stream Queue");
  console.log("3. Back");
  
  const c = await ask("Choice: ");
  if (c === "1") {
    const id = await ask("Stream ID: ");
    const urlsInput = await ask("Paste URLs (comma separated): ");
    const queue = urlsInput.split(',').map(u => u.trim());
    
    streams[id] = {
      status: "STARTING",
      config: {
        url: queue[0], // Start with first
        destIndex: 0,
        loop: false, // Queue mode implies sequence
        queue: queue.slice(1), // Rest of list
        recordLocal: false
      }
    };
    launchStream(id, streams[id].config);
  }
  if (c === "2") {
    // Find non-live streams
    const ids = Object.keys(streams).filter(k => streams[k].status === "STOPPED" || streams[k].status === "LIVE");
    if (ids.length === 0) return log("No streams found.", "gray");
    ids.forEach((x, i) => console.log(`${i+1}. ${x}`));
    const idx = parseInt(await ask("Select stream: ")) - 1;
    const id = ids[idx];
    const newUrl = await ask("URL to add: ");
    
    if (!streams[id].config.queue) streams[id].config.queue = [];
    streams[id].config.queue.push(newUrl);
    save(streams, STREAM_FILE);
    log("Added to queue.", "green");
  }
}

// --- MANAGE STREAMS ---
async function manageStreams() {
  console.log("\n--- STREAMS ---");
  console.log("1. Stop Stream");
  console.log("2. View Dashboard");
  console.log("3. View Logs");
  console.log("4. Cleanup Dead Entries");
  console.log("5. Back");
  
  const c = await ask("Choice: ");
  if (c === "1") {
    const ids = Object.keys(streams).filter(k => streams[k].status === "LIVE" || streams[k].status === "STARTING");
    ids.forEach((x, i) => console.log(`${i+1}. ${x} (${streams[x].status})`));
    const idx = parseInt(await ask("Stop #: ")) - 1;
    const id = ids[idx];
    if (id && streams[id].pid) {
      process.kill(streams[id].pid);
      streams[id].status = "STOPPED"; // Stop looping
      save(streams, STREAM_FILE);
      log(`Stopped ${id}`, "red");
    }
  }
  if (c === "2") {
    console.log(`\n${colors.bright}ID\tSTATUS\t\tUPTIME${colors.reset}`);
    for (let id in streams) {
      const s = streams[id];
      console.log(`${id}\t${s.status}\t${getUptime(s.started)}`);
    }
  }
  if (c === "3") {
    const logs = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "No logs.";
    console.log(logs.slice(-1000)); // Last 1000 chars
  }
  if (c === "4") {
    for (let id in streams) {
      if (streams[id].status === "STOPPED") delete streams[id];
    }
    save(streams, STREAM_FILE);
    log("Cleaned up.", "green");
  }
}

// --- DESTINATIONS ---
async function manageDests() {
  console.log("\n--- DESTINATIONS ---");
  destinations.forEach((d, i) => console.log(`${i+1}. ${d.name}`));
  console.log("1. Add\n2. Remove\n3. Back");
  const c = await ask("Choice: ");
  if (c === "1") {
    const name = await ask("Name: ");
    const rtmp = await ask("RTMP: ");
    const key = await ask("Key: ");
    destinations.push({name, rtmp, key});
    save(destinations, DEST_FILE);
  }
  if (c === "2") {
    const idx = parseInt(await ask("Remove #: ")) - 1;
    destinations.splice(idx, 1);
    save(destinations, DEST_FILE);
  }
}

// Start
mainMenu();
