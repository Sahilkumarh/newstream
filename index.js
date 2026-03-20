const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ================= CONFIGURATION =================
const STREAM_FILE = "streams.json";
const DEST_FILE = "destinations.json";
const LOG_FILE = "logs.txt";
const YTDLP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ================= LOGGING SYSTEM =================
// Writes to file, only prints short summary to console
function writeLog(msg, type = "INFO") {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] [${type}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, logMsg);
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

// --- THE ACTUAL STREAM LAUNCHER ---
// Can be called by "Start New" or "Restart"
function launchStream(id, config) {
  const { url, destIndex, usePipe, loop, cookiesFile, resolvedUrl } = config;
  
  if (streams[id] && (streams[id].status === "LIVE" || streams[id].status === "STARTING")) {
    console.log(`⚠️  Stream ${id} is already running.`);
    return;
  }

  const dest = destinations[destIndex];
  if (!dest) {
    console.log("❌ Destination removed. Cannot start stream.");
    return;
  }

  const fullUrl = joinRtmpUrl(dest.rtmp, dest.key);
  console.log(`\n🚀 Starting ${id} -> ${dest.name}...`);
  writeLog(`Starting stream ${id} to ${fullUrl}`);

  const ffmpegArgs = ["-re"];
  const finalInput = resolvedUrl || url;

  if (loop && !usePipe) ffmpegArgs.push("-stream_loop", "-1");

  if (usePipe) {
    ffmpegArgs.push("-i", "pipe:0");
  } else {
    ffmpegArgs.push("-i", finalInput);
  }

  ffmpegArgs.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-c:a", "aac", "-b:a", "128k", "-f", "flv", fullUrl);

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
        console.log(`❌ Stream ${id} failed (yt-dlp exited). See logs.`);
      }
    });
  }

  streams[id] = {
    pid: ffmpeg.pid,
    ytdlpPid: ytdlp ? ytdlp.pid : null,
    url,
    platform: dest.name,
    mode: usePipe ? "PIPE" : "DIRECT",
    started: new Date().toLocaleString(),
    status: "STARTING",
    error: "",
    // Save config for restart
    config: { url, destIndex, usePipe, loop, cookiesFile, resolvedUrl }
  };
  saveStreams();

  ffmpeg.stderr.on("data", (data) => {
    const msg = data.toString();
    writeLog(`[FFmpeg ${id}] ${msg.trim()}`); // Write full log to file

    if (msg.includes("Press [q]")) {
      if (streams[id].status !== "LIVE") {
        streams[id].status = "LIVE";
        saveStreams();
        console.log(`✅ Stream ${id} is LIVE`);
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
    
    if (code !== 0) console.log(`❌ Stream ${id} stopped with error. Check logs.`);
    else console.log(`🛑 Stream ${id} stopped.`);
  });
}

// ================= MENUS =================

async function mainMenu() {
  while(true) {
    console.log("\n==============================");
    console.log("🎥 STREAM CONTROL PANEL");
    console.log("==============================\n");

    console.log("1. Manage Streams (Start/Stop/Restart)");
    console.log("2. Manage Destinations (Keys)");
    console.log("3. View Logs");
    console.log("4. Clear Logs");
    console.log("5. Exit\n");

    const choice = await ask("Enter choice: ");

    if (choice === "1") return streamMenu();
    if (choice === "2") return destMenu();
    if (choice === "3") {
      console.log("\n--- LAST 30 LOG LINES ---\n");
      console.log(getLogs(30));
      console.log("--------------------------\n");
    }
    if (choice === "4") {
      clearLogs();
      console.log("🧹 Logs cleared.");
    }
    if (choice === "5") process.exit(0);
  }
}

// --- STREAM MENU ---
async function streamMenu() {
  while(true) {
    console.log("\n--- MANAGE STREAMS ---\n");
    
    // Quick Status
    const active = Object.values(streams).filter(s => s.status === "LIVE" || s.status === "STARTING").length;
    const failed = Object.values(streams).filter(s => s.status === "FAILED").length;
    console.log(`Active: ${active} | Failed: ${failed}\n`);

    console.log("1. Start New Stream");
    console.log("2. Stop Active Stream");
    console.log("3. Restart Stopped/Failed Stream");
    console.log("4. View Dashboard (Details)");
    console.log("5. Cleanup (Clear Stopped/Failed entries)");
    console.log("6. Back\n");

    const choice = await ask("Enter choice: ");

    if (choice === "1") await startNewStream();
    else if (choice === "2") await stopStream();
    else if (choice === "3") await restartStream();
    else if (choice === "4") viewDashboard();
    else if (choice === "5") await cleanupStreams();
    else if (choice === "6") return mainMenu();
  }
}

// --- DESTINATION MENU ---
async function destMenu() {
  while(true) {
    console.log("\n--- MANAGE DESTINATIONS ---\n");
    if (destinations.length === 0) console.log("No destinations saved.\n");
    else {
      destinations.forEach((d, i) => console.log(`${i + 1}. ${d.name}`));
      console.log("");
    }

    console.log("1. Add Destination");
    console.log("2. Remove Destination");
    console.log("3. Back\n");

    const choice = await ask("Enter choice: ");

    if (choice === "1") {
      const name = await ask("Name: ");
      const rtmp = await ask("RTMP URL: ");
      const key = await ask("Stream Key: ");
      destinations.push({ name, rtmp, key });
      saveDest();
      console.log("✅ Destination added.");
    } else if (choice === "2") {
      if (destinations.length === 0) {
        console.log("Nothing to remove.");
        continue;
      }
      const idx = parseInt(await ask("Enter number to remove: ")) - 1;
      if (idx >= 0 && idx < destinations.length) {
        console.log(`Removed: ${destinations[idx].name}`);
        destinations.splice(idx, 1);
        saveDest();
      } else {
        console.log("Invalid selection.");
      }
    } else if (choice === "3") {
      return mainMenu();
    }
  }
}

// ================= ACTIONS =================

async function startNewStream() {
  if (destinations.length === 0) {
    console.log("❌ No destinations found. Please add one in Manage Destinations.");
    return;
  }

  const id = await ask("Stream ID: ");
  if (streams[id]) {
    console.log("⚠️  ID exists. Stop it first or use a different ID.");
    return;
  }

  // Select Dest
  destinations.forEach((d, i) => console.log(`${i + 1}. ${d.name}`));
  const dIdx = parseInt(await ask("Select Destination: ")) - 1;
  if (dIdx < 0 || dIdx >= destinations.length) return console.log("Invalid selection.");

  // Config
  const url = await ask("Video URL: ");
  const cookiesFile = (await ask("Cookies file (leave blank): ")).trim();
  
  let usePipe = false;
  if (hasYtdlp) {
    usePipe = (await ask("Use Pipe Mode? (y/n): ")).toLowerCase().startsWith('y');
  }

  let resolvedUrl = null;
  if (!usePipe && hasYtdlp) {
    if ((await ask("Resolve URL? (y/n): ")).toLowerCase().startsWith('y')) {
      console.log("Resolving...");
      resolvedUrl = resolveInputUrl(url, cookiesFile || null);
      if(resolvedUrl) console.log("✅ Resolved.");
    }
  }

  let loop = false;
  if (!usePipe) {
    loop = (await ask("Loop? (y/n): ")).toLowerCase().startsWith('y');
  }

  launchStream(id, {
    url, destIndex: dIdx, usePipe, loop, cookiesFile, resolvedUrl
  });
}

async function stopStream() {
  const ids = Object.keys(streams).filter(id => streams[id].status === "LIVE" || streams[id].status === "STARTING");
  if (ids.length === 0) return console.log("No active streams.");

  ids.forEach((id, i) => console.log(`${i + 1}. ${id}`));
  const choice = parseInt(await ask("Select stream to stop: ")) - 1;
  const id = ids[choice];

  if (!id) return console.log("Invalid.");

  try {
    if (streams[id].pid) process.kill(streams[id].pid);
    if (streams[id].ytdlpPid) process.kill(streams[id].ytdlpPid);
    streams[id].status = "STOPPED";
    saveStreams();
    console.log(`🛑 Stopped ${id}`);
  } catch (e) {
    console.log("Error stopping process.");
  }
}

async function restartStream() {
  const ids = Object.keys(streams).filter(id => streams[id].status !== "LIVE" && streams[id].status !== "STARTING");
  if (ids.length === 0) return console.log("No stopped/failed streams to restart.");

  ids.forEach((id, i) => {
    console.log(`${i + 1}. ${id} (${streams[id].status})`);
  });
  const choice = parseInt(await ask("Select stream to restart: ")) - 1;
  const id = ids[choice];

  if (!id || !streams[id].config) return console.log("Cannot restart (old config missing).");

  // Launch with saved config
  launchStream(id, streams[id].config);
}

function viewDashboard() {
  console.log("\n========= DASHBOARD =========\n");
  for (let id in streams) {
    const s = streams[id];
    const icon = s.status === "LIVE" ? "🟢" : (s.status === "FAILED" ? "🔴" : "⚫");
    console.log(`${icon} ${id} | ${s.platform} | ${s.status}`);
    if (s.error) console.log(`   Error: ${s.error.substring(0, 50)}...`);
  }
  console.log("=============================\n");
}

async function cleanupStreams() {
  console.log("\n1. Clear Stopped only");
  console.log("2. Clear Failed only");
  console.log("3. Clear All (non-active)");
  console.log("4. Cancel\n");
  
  const choice = await ask("Select option: ");
  
  for (let id in streams) {
    const s = streams[id];
    let del = false;
    if (choice === "1" && s.status === "STOPPED") del = true;
    if (choice === "2" && s.status === "FAILED") del = true;
    if (choice === "3" && s.status !== "LIVE" && s.status !== "STARTING") del = true;

    if (del) delete streams[id];
  }
  
  if (choice !== "4") {
    saveStreams();
    console.log("🧹 Cleanup done.");
  }
}

// Start App
mainMenu();
