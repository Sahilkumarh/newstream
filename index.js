const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ================= COLORS & UI =================
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m"
};

function log(msg, color = "reset") {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// ================= CONFIGURATION =================
const STREAM_FILE = "streams.json";
const DEST_FILE = "destinations.json";
const LOG_FILE = "logs.txt";
const YTDLP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ================= LOGGING SYSTEM =================
function writeLog(msg, type = "INFO") {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] [${type}] ${msg}\n`;
  
  // Append to file
  fs.appendFileSync(LOG_FILE, logMsg);

  // Rotate logs: keep only last 500 lines
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.trim().split("\n");
    if (lines.length > 500) {
      const newContent = lines.slice(-500).join("\n");
      fs.writeFileSync(LOG_FILE, newContent);
    }
  } catch (e) {}
}

function getLogs(lines = 30) {
  if (!fs.existsSync(LOG_FILE)) return "No logs found.";
  const content = fs.readFileSync(LOG_FILE, "utf8");
  const allLines = content.trim().split("\n");
  return allLines.slice(-lines).join("\n");
}

function clearLogs() {
  if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
  writeLog("Logs cleared by user.", "SYSTEM");
}

// ================= DATA HELPERS =================
let hasYtdlp = false;
try {
  const check = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  hasYtdlp = check.status === 0;
} catch (err) {
  hasYtdlp = false;
}

let streams = fs.existsSync(STREAM_FILE)
  ? JSON.parse(fs.readFileSync(STREAM_FILE))
  : {};

let destinations = fs.existsSync(DEST_FILE)
  ? JSON.parse(fs.readFileSync(DEST_FILE))
  : [];

function saveStreams() {
  try { fs.writeFileSync(STREAM_FILE, JSON.stringify(streams, null, 2)); } catch(e){}
}

function saveDest() {
  try { fs.writeFileSync(DEST_FILE, JSON.stringify(destinations, null, 2)); } catch(e){}
}

function joinRtmpUrl(rtmp, key) {
  if (!rtmp || !key) return "";
  const cleanRtmp = rtmp.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  return `${cleanRtmp}/${cleanKey}`;
}

// Format uptime (ms -> HH:MM:SS)
function getUptime(startTimeStr) {
  try {
    const start = new Date(startTimeStr).getTime();
    const now = Date.now();
    const diff = Math.floor((now - start) / 1000);
    
    const h = Math.floor(diff / 3600).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  } catch (e) {
    return "00:00:00";
  }
}

// ================= INPUT HELPER =================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((res) => rl.question(q, res));
}

// ================= CORE LOGIC =================

function resolveInputUrl(url, cookiesFile = null) {
  if (!hasYtdlp) return null;
  try {
    const args = ["-g", "--no-playlist", "--no-warnings", "--user-agent", YTDLP_USER_AGENT, "-f", "best[ext=mp4]/best"];
    if (cookiesFile) args.push("--cookies", cookiesFile);
    args.push(url);
    const res = spawnSync("yt-dlp", args, { encoding: "utf8" });
    if (res.status !== 0) return null;
    const out = (res.stdout || "").trim();
    return out ? out.split(/\r?\n/)[0].trim() : null;
  } catch (err) { return null; }
}

function launchStream(id, config) {
  const { url, destIndex, usePipe, loop, cookiesFile, resolvedUrl, recordLocal } = config;
  
  if (streams[id] && (streams[id].status === "LIVE" || streams[id].status === "STARTING")) {
    log(`⚠️  Stream ${id} is already running.`, "yellow");
    return;
  }

  const dest = destinations[destIndex];
  const fullUrl = dest ? joinRtmpUrl(dest.rtmp, dest.key) : null;

  console.log("\n----------------------------------------");
  log(`🚀 Starting Stream: ${id}`, "cyan");
  if (fullUrl) log(`📡 Target: ${dest.name}`, "blue");
  if (recordLocal) log(`💾 Recording: record_${id}_${Date.now()}.mp4`, "yellow");
  console.log("----------------------------------------\n");

  writeLog(`Starting stream ${id}`);

  const ffmpegArgs = ["-re", "-thread_queue_size", "512"]; // Improve buffer stability
  const finalInput = resolvedUrl || url;

  if (loop && !usePipe) ffmpegArgs.push("-stream_loop", "-1");

  if (usePipe) {
    ffmpegArgs.push("-i", "pipe:0");
  } else {
    ffmpegArgs.push("-i", finalInput);
  }

  // Encoding Settings
  const codecArgs = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-f", "flv"];
  
  // --- OUTPUT LOGIC ---
  let outputArg = "";
  
  if (recordLocal && fullUrl) {
    // MODE 3: Stream AND Record (using Tee)
    // Format: [f=flv]rtmp://url|[f=mp4]file.mp4
    // We need to escape brackets for shell if we were using shell, but spawn is safe.
    const filename = `record_${id}_${Date.now()}.mp4`;
    outputArg = `[f=flv]${fullUrl}|[f=mp4]${filename}`;
    ffmpegArgs.push("-f", "tee", "-map", "0:v", "-map", "0:a", outputArg);
  } else if (recordLocal) {
    // MODE 2: Record Only
    const filename = `record_${id}_${Date.now()}.mp4`;
    ffmpegArgs.push("-f", "mp4", filename);
  } else if (fullUrl) {
    // MODE 1: Stream Only
    ffmpegArgs.push(...codecArgs, fullUrl);
  } else {
    log("❌ No destination selected and not recording. Aborting.", "red");
    return;
  }

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: usePipe ? ["pipe", "inherit", "pipe"] : "pipe",
  });

  let lastError = "Unknown error";
  let ytdlp = null;

  if (usePipe) {
    ffmpeg.stdin.on("error", (err) => { if (err.code !== "EPIPE") writeLog(`STDIN Error: ${err.message}`, "ERROR"); });

    const ytdlpArgs = ["--no-playlist", "--no-warnings", "--user-agent", YTDLP_USER_AGENT, "-f", "best", "-o", "-", url];
    if (cookiesFile && fs.existsSync(cookiesFile)) ytdlpArgs.push("--cookies", cookiesFile);
    
    ytdlp = spawn("yt-dlp", ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

    ytdlp.stdout.on("data", (chunk) => {
      if (ffmpeg.killed || !ffmpeg.stdin.writable) { ytdlp.kill(); return; }
      if (!ffmpeg.stdin.write(chunk)) ytdlp.stdout.pause();
    });

    ffmpeg.stdin.on("drain", () => { if (ytdlp.stdout && !ytdlp.stdout.destroyed) ytdlp.stdout.resume(); });
    ytdlp.stdout.on("end", () => { if (ffmpeg.stdin.writable) ffmpeg.stdin.end(); });
    
    ytdlp.stderr.on("data", (d) => {
        const msg = d.toString();
        if(msg.includes("ERROR") || msg.includes("Sign in")) lastError = `yt-dlp: ${msg.trim()}`;
    });

    ytdlp.on("exit", (c) => {
      if (streams[id] && streams[id].status !== "STOPPED") {
        streams[id].status = "FAILED";
        streams[id].error = lastError;
        saveStreams();
        log(`❌ Stream ${id} failed (yt-dlp). Check logs.`, "red");
      }
    });
  }

  streams[id] = {
    pid: ffmpeg.pid,
    ytdlpPid: ytdlp ? ytdlp.pid : null,
    url,
    platform: dest ? dest.name : "Local Recording",
    mode: usePipe ? "PIPE" : "DIRECT",
    recordLocal,
    started: new Date().toLocaleString(),
    status: "STARTING",
    error: "",
    config: { url, destIndex, usePipe, loop, cookiesFile, resolvedUrl, recordLocal }
  };
  saveStreams();

  ffmpeg.stderr.on("data", (data) => {
    const msg = data.toString();
    writeLog(`[FFmpeg ${id}] ${msg.trim()}`);

    if (msg.includes("Press [q]")) {
      if (streams[id].status !== "LIVE") {
        streams[id].status = "LIVE";
        saveStreams();
        log(`✅ Stream ${id} is LIVE`, "green");
      }
    }
    if (msg.includes("Error") || msg.includes("403") || msg.includes("Connection refused")) {
      lastError = msg.trim();
    }
  });

  ffmpeg.on("exit", (code) => {
    if (!streams[id]) return;
    if (ytdlp && !ytdlp.killed) ytdlp.kill();
    
    streams[id].status = code === 0 ? "STOPPED" : "FAILED";
    if (code !== 0) streams[id].error = lastError;
    saveStreams();
    
    if (code !== 0) log(`❌ Stream ${id} stopped with error.`, "red");
    else log(`🛑 Stream ${id} stopped.`, "gray");
  });
}

// ================= MENUS =================

async function mainMenu() {
  while(true) {
    const activeCount = Object.values(streams).filter(s => s.status === "LIVE" || s.status === "STARTING").length;
    const failedCount = Object.values(streams).filter(s => s.status === "FAILED").length;

    console.log(`\n${colors.bright}==============================${colors.reset}`);
    console.log(`${colors.bright}   🎥  STREAM MANAGER   ${colors.reset}`);
    console.log(`${colors.bright}==============================${colors.reset}\n`);
    
    console.log(`  Active: ${colors.green}${activeCount}${colors.reset} | Failed: ${colors.red}${failedCount}${colors.reset}\n`);

    console.log(`  ${colors.cyan}1.${colors.reset} Manage Streams`);
    console.log(`  ${colors.cyan}2.${colors.reset} Manage Destinations`);
    console.log(`  ${colors.cyan}3.${colors.reset} View/Clear Logs`);
    console.log(`  ${colors.red}4.${colors.reset} Exit\n`);

    const choice = await ask("Enter choice: ");

    if (choice === "1") await streamMenu();
    else if (choice === "2") await destMenu();
    else if (choice === "3") await logMenu();
    else if (choice === "4") process.exit(0);
  }
}

async function logMenu() {
  console.log("\n--- LOGS ---\n");
  console.log("1. View last 30 lines");
  console.log("2. View all (tail -f style simulation - just last 100)");
  console.log("3. Clear Logs");
  console.log("4. Back\n");

  const c = await ask("Choice: ");
  if (c === "1") {
    console.log("\n--- LOG OUTPUT ---");
    console.log(getLogs(30));
    console.log("------------------\n");
  } else if (c === "2") {
    console.log("\n--- LAST 100 LINES ---");
    console.log(getLogs(100));
    console.log("----------------------\n");
  } else if (c === "3") {
    clearLogs();
    log("Logs cleared.", "yellow");
  }
}

async function streamMenu() {
  while(true) {
    console.log(`\n${colors.bright}--- MANAGE STREAMS ---${colors.reset}\n`);
    console.log(`  ${colors.green}1.${colors.reset} Start New Stream`);
    console.log(`  ${colors.red}2.${colors.reset} Stop Active Stream`);
    console.log(`  ${colors.yellow}3.${colors.reset} Restart Stopped/Failed`);
    console.log(`  ${colors.blue}4.${colors.reset} View Dashboard (Status)`);
    console.log(`  ${colors.cyan}5.${colors.reset} Stream Details (PID/Config)`);
    console.log(`  ${colors.gray}6.${colors.reset} Cleanup Entries`);
    console.log(`  ${colors.gray}7.${colors.reset} Back\n`);

    const choice = await ask("Enter choice: ");

    if (choice === "1") await startNewStream();
    else if (choice === "2") await stopStream();
    else if (choice === "3") await restartStream();
    else if (choice === "4") viewDashboard();
    else if (choice === "5") await viewStreamDetails();
    else if (choice === "6") await cleanupStreams();
    else if (choice === "7") return;
  }
}

async function destMenu() {
  while(true) {
    console.log(`\n${colors.bright}--- DESTINATIONS ---${colors.reset}\n`);
    if (destinations.length === 0) log("No destinations saved.", "gray");
    else {
      destinations.forEach((d, i) => {
        const status = (i === 0) ? `${colors.green}[Default]${colors.reset}` : "";
        console.log(`  ${i+1}. ${d.name} ${status}`);
      });
      console.log("");
    }

    console.log(`  ${colors.green}1.${colors.reset} Add Destination`);
    console.log(`  ${colors.red}2.${colors.reset} Remove Destination`);
    console.log(`  ${colors.gray}3.${colors.reset} Back\n`);

    const choice = await ask("Enter choice: ");

    if (choice === "1") {
      const name = await ask("Name: ");
      const rtmp = await ask("RTMP URL: ");
      const key = await ask("Stream Key: ");
      destinations.push({ name, rtmp, key });
      saveDest();
      log("✅ Destination added.", "green");
    } else if (choice === "2") {
      if (destinations.length === 0) continue;
      const idx = parseInt(await ask("Enter number to remove: ")) - 1;
      if (idx >= 0 && idx < destinations.length) {
        log(`Removed: ${destinations[idx].name}`, "yellow");
        destinations.splice(idx, 1);
        saveDest();
      }
    } else if (choice === "3") return;
  }
}

// ================= ACTIONS =================

async function startNewStream() {
  if (destinations.length === 0) {
    log("❌ No destinations. Add one first.", "red");
    return;
  }

  const id = await ask("Stream ID: ");
  if (streams[id]) {
    log("⚠️  ID exists.", "yellow");
    return;
  }

  // Select Destination
  destinations.forEach((d, i) => console.log(`${i+1}. ${d.name}`));
  let destIdx = parseInt(await ask("Select Destination (0 for Record Only): ")) - 1;
  
  let recordLocal = false;
  if (destIdx === -1) {
    recordLocal = true;
    destIdx = 0; // dummy
  }

  // Config
  const url = await ask("Video URL: ");
  const cookiesFile = (await ask("Cookies file (leave blank): ")).trim();
  
  let usePipe = false;
  if (hasYtdlp) {
    usePipe = (await ask("Use Pipe Mode? (y/n): ")).toLowerCase() === 'y';
  }

  let resolvedUrl = null;
  if (!usePipe && hasYtdlp) {
    if ((await ask("Resolve URL? (y/n): ")).toLowerCase() === 'y') {
      log("Resolving...", "yellow");
      resolvedUrl = resolveInputUrl(url, cookiesFile || null);
      if(resolvedUrl) log("✅ Resolved.", "green");
      else log("⚠️  Resolution failed.", "yellow");
    }
  }

  let loop = false;
  if (!usePipe) {
    loop = (await ask("Loop? (y/n): ")).toLowerCase() === 'y';
  }

  // Recording Check
  if (!recordLocal) {
    const recAns = await ask("Also save local copy (Record)? (y/n): ");
    recordLocal = recAns.toLowerCase() === 'y';
  }

  launchStream(id, {
    url, destIndex: destIdx, usePipe, loop, cookiesFile, resolvedUrl, recordLocal
  });
}

async function stopStream() {
  const ids = Object.keys(streams).filter(id => streams[id].status === "LIVE" || streams[id].status === "STARTING");
  if (ids.length === 0) return log("No active streams.", "gray");

  ids.forEach((id, i) => {
    const s = streams[id];
    const uptime = getUptime(s.started);
    console.log(`  ${i+1}. ${id} | ${s.platform} | ${colors.green}${uptime}${colors.reset}`);
  });

  const choice = parseInt(await ask("Select stream to stop: ")) - 1;
  const id = ids[choice];

  if (!id) return;

  try {
    if (streams[id].pid) process.kill(streams[id].pid);
    if (streams[id].ytdlpPid) process.kill(streams[id].ytdlpPid);
    streams[id].status = "STOPPED";
    saveStreams();
    log(`🛑 Stopped ${id}`, "gray");
  } catch (e) {
    log("Error stopping process.", "red");
  }
}

async function restartStream() {
  const ids = Object.keys(streams).filter(id => streams[id].status !== "LIVE" && streams[id].status !== "STARTING");
  if (ids.length === 0) return log("No stopped streams.", "gray");

  ids.forEach((id, i) => console.log(`  ${i+1}. ${id} (${streams[id].status})`));
  const choice = parseInt(await ask("Select stream to restart: ")) - 1;
  const id = ids[choice];

  if (!id || !streams[id].config) return log("Cannot restart (config missing).", "red");
  launchStream(id, streams[id].config);
}

function viewDashboard() {
  console.log(`\n${colors.bright}========= DASHBOARD =========${colors.reset}\n`);
  console.log(`  ${colors.bright}ID${colors.reset}       ${colors.bright}PLATFORM${colors.reset}         ${colors.bright}STATUS${colors.reset}    ${colors.bright}UPTIME${colors.reset}`);
  console.log("  ----------------------------------------");
  
  let hasItems = false;
  for (let id in streams) {
    hasItems = true;
    const s = streams[id];
    
    let statusColor = "gray";
    let statusIcon = "●";
    if (s.status === "LIVE") { statusColor = "green"; statusIcon = "●"; }
    if (s.status === "FAILED") { statusColor = "red"; statusIcon = "●"; }
    if (s.status === "STARTING") { statusColor = "yellow"; statusIcon = "○"; }

    const uptime = (s.status === "LIVE") ? getUptime(s.started) : "--:--:--";
    
    // Formatting spacing
    const idPad = id.padEnd(10);
    const platPad = s.platform.substring(0, 15).padEnd(16);
    
    console.log(`  ${idPad} ${platPad} ${colors[statusColor]}${statusIcon} ${s.status}${colors.reset}   ${uptime}`);
  }

  if(!hasItems) console.log("  No streams found.");
  console.log("\n=============================\n");
}

async function viewStreamDetails() {
  const ids = Object.keys(streams);
  if (ids.length === 0) return log("No streams.", "gray");
  
  ids.forEach((id, i) => console.log(`${i+1}. ${id}`));
  const choice = parseInt(await ask("Select stream: ")) - 1;
  const id = ids[choice];
  const s = streams[id];

  if(!s) return;

  console.log(`\n${colors.bright}--- DETAILS: ${id} ---${colors.reset}`);
  console.log(`Status:    ${s.status}`);
  console.log(`Platform:  ${s.platform}`);
  console.log(`Started:   ${s.started}`);
  console.log(`Mode:      ${s.mode}`);
  console.log(`Recording: ${s.recordLocal ? "Yes" : "No"}`);
  console.log(`FFmpeg PID: ${s.pid}`);
  console.log(`Ytdlp PID:  ${s.ytdlpPid || "N/A"}`);
  console.log(`Source URL: ${s.url}`);
  if(s.error) console.log(`\n${colors.red}Last Error: ${s.error}${colors.reset}`);
  console.log(`${colors.bright}-----------------------${colors.reset}\n`);
}

async function cleanupStreams() {
  console.log("\n1. Clear Stopped only");
  console.log("2. Clear Failed only");
  console.log("3. Clear All (non-active)");
  console.log("4. Cancel\n");
  
  const choice = await ask("Select option: ");
  
  let count = 0;
  for (let id in streams) {
    const s = streams[id];
    let del = false;
    if (choice === "1" && s.status === "STOPPED") del = true;
    if (choice === "2" && s.status === "FAILED") del = true;
    if (choice === "3" && s.status !== "LIVE" && s.status !== "STARTING") del = true;

    if (del) {
      delete streams[id];
      count++;
    }
  }
  
  if (choice !== "4") {
    saveStreams();
    log(`🧹 Cleaned up ${count} streams.`, "cyan");
  }
}

// Start App
mainMenu();
