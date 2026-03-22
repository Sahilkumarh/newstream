const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==========================================
// 🎨 CONFIG & UI
// ==========================================
const Colors = {
  reset: "\x1b[0m", bright: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m"
};

const ui = {
  header: (title) => {
    console.clear();
    console.log(`\n${Colors.bright}${Colors.cyan}═══════════════════════════════════════════════════════${Colors.reset}`);
    console.log(`${Colors.bright}${Colors.blue}    ${title}${Colors.reset}`);
    console.log(`${Colors.bright}${Colors.cyan}═══════════════════════════════════════════════════════${Colors.reset}\n`);
  },
  log: (msg, color = "reset") => console.log(`${Colors[color]}${msg}${Colors.reset}`),
  error: (msg) => console.log(`${Colors.red}❌ ${msg}${Colors.reset}`),
  success: (msg) => console.log(`${Colors.green}✅ ${msg}${Colors.reset}`),
  ask: (q) => new Promise(r => rl.question(q, r)),
  wait: () => new Promise(r => rl.question("\n[Press Enter to continue...] ", r))
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ==========================================
// 💾 DATA LAYER (Safe Persistence)
// ==========================================
const FILES = {
  STREAMS: "phoenix_streams.json",
  DESTS: "phoenix_dests.json",
  PRESETS: "phoenix_presets.json",
  LOGS: "phoenix_ffmpeg.log"
};

const DB = {
  streams: {},
  dests: [],
  presets: [],
  
  init: () => {
    // Safe load with fallbacks
    const load = (f, def) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : def;
    DB.streams = load(FILES.STREAMS, {});
    DB.dests = load(FILES.DESTS, []);
    DB.presets = load(FILES.PRESETS, []);

    // CRITICAL FIX 2: The "Dead PID" Problem
    // On restart, we cannot trust PIDs. Reset them to null.
    // Reset any "LIVE" streams to "STOPPED" because they are definitely dead if we just started.
    let recovered = 0;
    for (let id in DB.streams) {
      if (DB.streams[id].status === "LIVE" || DB.streams[id].status === "STARTING") {
        DB.streams[id].status = "STOPPED";
        DB.streams[id].pid = null;
        DB.streams[id].retryCount = 0;
        recovered++;
      }
    }
    if (recovered > 0) {
      ui.log(`System Boot: Reset ${recovered} orphaned streams.`, "yellow");
    }
    DB.save("STREAMS");
  },

  save: (key) => {
    try { fs.writeFileSync(FILES[key], JSON.stringify(DB[key], null, 2)); } 
    catch (e) { ui.error("Failed to save data: " + e.message); }
  }
};

// CRITICAL FIX 8: Safe yt-dlp check
let hasYtdlp = false;
try {
  hasYtdlp = spawnSync("yt-dlp", ["--version"]).status === 0;
} catch (e) {
  ui.log("Warning: yt-dlp check failed.", "yellow");
}

// ==========================================
// ⚙️ ENGINE (Async & Robust)
// ==========================================
const Engine = {
  // CRITICAL FIX 3: Async Resolution (Non-blocking)
  resolve: (url) => {
    return new Promise((resolve) => {
      if (!hasYtdlp || !url.startsWith("http")) return resolve(null);
      
      const child = spawn("yt-dlp", [
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", 
        "-g", url
      ]);
      
      let output = "";
      child.stdout.on("data", d => output += d.toString());
      child.on("close", (code) => {
        if (code !== 0) return resolve(null);
        const lines = output.trim().split("\n").filter(l => l.startsWith("http"));
        if (lines.length >= 2) return resolve({ video: lines[0], audio: lines[1] });
        if (lines.length === 1) return resolve({ video: lines[0], audio: null });
        resolve(null);
      });
      // 10s timeout for resolution
      setTimeout(() => { child.kill(); resolve(null); }, 10000);
    });
  },

  launch: async (id, config) => {
    const dest = DB.dests[config.destIndex];
    if (!dest) return ui.error("Destination configuration missing.");

    ui.log(`🚀 Launching ${id}...`, "cyan");

    // 1. Validate Source
    let isLocal = false;
    try {
      // CRITICAL FIX 7: Check if it's a file or directory
      const stat = fs.statSync(config.source);
      if (stat.isFile()) isLocal = true;
      else if (stat.isDirectory()) return ui.error("Source is a directory, not a file.");
    } catch (e) {
      // Doesn't exist locally, assume URL
    }

    let inputArgs = [];
    let mapArgs = [];

    if (isLocal) {
      ui.log("   Source: Local File", "green");
      inputArgs = ["-re", "-i", config.source];
    } else {
      ui.log("   Source: Remote URL (Resolving...)", "yellow");
      // Always resolve fresh. (CRITICAL FIX 6: Don't save expired tokens)
      const urls = await Engine.resolve(config.source);
      
      if (urls && urls.audio) {
        inputArgs = ["-re", "-i", urls.video, "-i", urls.audio];
        mapArgs = ["-map", "0:v", "-map", "1:a"];
      } else if (urls) {
        inputArgs = ["-re", "-i", urls.video];
      } else {
        ui.log("   Resolution failed. Using raw URL.", "yellow");
        inputArgs = ["-re", "-i", config.source];
      }
    }

    // 2. Construct Command
    const rtmp = `${dest.rtmp.replace(/\/$/, '')}/${dest.key.replace(/^\//, '')}`;
    const ffmpegArgs = [
      ...inputArgs, ...mapArgs,
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-f", "flv",
      rtmp
    ];

    // 3. Spawn
    // CRITICAL FIX 9: Log Clutter. Redirect stderr to file stream, not inherit.
    const logStream = fs.createWriteStream(FILES.LOGS, { flags: 'a' });
    
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });
    
    // Pipe stderr to both log file AND our monitor logic
    ffmpeg.stderr.pipe(logStream);

    // 4. Update State
    DB.streams[id] = {
      ...DB.streams[id],
      pid: ffmpeg.pid,
      status: "STARTING",
      startTime: Date.now(),
      source: config.source,
      platform: dest.name,
      config: config, // Save intent, not resolved URLs
      retryCount: (DB.streams[id]?.retryCount || 0)
    };
    DB.save("STREAMS");

    // 5. Monitor (Rolling Buffer for Live Detection)
    // CRITICAL FIX 4: Fix chunking issue
    let buffer = "";
    
    ffmpeg.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      // Keep buffer size manageable (e.g., last 1000 chars)
      if (buffer.length > 1000) buffer = buffer.slice(-1000);

      if (buffer.includes("Press [q]")) {
        if (DB.streams[id].status !== "LIVE") {
          DB.streams[id].status = "LIVE";
          DB.streams[id].retryCount = 0; // Reset retries on success
          DB.save("STREAMS");
          ui.success(`${id} is LIVE`);
        }
      }
      
      // Log errors to console but not frame stats
      if (chunk.toString().toLowerCase().includes("error")) {
         ui.log(`[FFmpeg Error] ${chunk.toString().trim().substring(0, 50)}`, "red");
      }
    });

    ffmpeg.on("exit", (code) => {
      logStream.end();
      const s = DB.streams[id];
      if (!s) return;

      const crashed = code !== 0;
      const shouldRestart = s.config.autoRestart !== false;
      const maxRetries = s.config.maxRetries || 5;
      const currentRetries = s.retryCount || 0;

      if (crashed && shouldRestart && currentRetries < maxRetries) {
        // CRITICAL FIX 5: Infinite Loop Prevention
        const delay = Math.min(currentRetries * 2, 30) * 1000; // Cap at 30s wait
        ui.log(`💥 ${id} Crashed. Retry ${currentRetries}/${maxRetries} in ${delay/1000}s...`, "yellow");
        
        s.status = "RETRYING";
        s.retryCount = currentRetries + 1;
        DB.save("STREAMS");
        
        setTimeout(() => Engine.launch(id, s.config), delay);
      } else {
        s.status = crashed ? "FAILED" : "STOPPED";
        DB.save("STREAMS");
        ui.log(`🛑 ${id} Stopped.`, "gray");
      }
    });
  },

  kill: (pid) => {
    if (!pid) return;
    try { process.kill(pid, "SIGTERM"); } catch(e) {}
    try { setTimeout(() => process.kill(pid, "SIGKILL"), 2000); } catch(e) {}
  }
};

// ==========================================
// 📅 SCHEDULER (Persistent)
// ==========================================
const Scheduler = {
  timers: {},

  init: () => {
    // CRITICAL FIX 1: Restore Jobs on Restart
    const now = Date.now();
    for (let id in DB.streams) {
      const s = DB.streams[id];
      if (s.status === "SCHEDULED" && s.config.scheduledTime) {
        const target = new Date(s.config.scheduledTime).getTime();
        if (target > now) {
          const diff = target - now;
          ui.log(`⏰ Restoring Schedule: ${id}`, "magenta");
          Scheduler.set(id, s.config, diff);
        } else {
          // Time passed
          s.status = "FAILED";
          s.lastError = "Scheduled time passed while offline";
          DB.save("STREAMS");
        }
      }
    }
  },

  set: (id, config, delayMs) => {
    if (Scheduler.timers[id]) clearTimeout(Scheduler.timers[id]);
    
    Scheduler.timers[id] = setTimeout(() => {
      ui.log(`⏰ Triggering: ${id}`, "magenta");
      delete Scheduler.timers[id];
      Engine.launch(id, config);
    }, delayMs);
  },

  clear: (id) => {
    if (Scheduler.timers[id]) clearTimeout(Scheduler.timers[id]);
    delete Scheduler.timers[id];
  }
};

// ==========================================
// 🧭 MENUS
// ==========================================

async function mainMenu() {
  DB.init(); // Load data & sanitize PIDs
  Scheduler.init(); // Restore scheduled jobs

  while (true) {
    const active = Object.values(DB.streams).filter(s => s.status === "LIVE").length;
    const sched = Object.values(DB.streams).filter(s => s.status === "SCHEDULED").length;
    const retry = Object.values(DB.streams).filter(s => s.status === "RETRYING").length;

    ui.header("PHOENIX STABLE EDITION");
    console.log(`  Status: ${Colors.green}${active} Live${Colors.reset} | ${Colors.yellow}${retry} Retrying${Colors.reset} | ${Colors.magenta}${sched} Scheduled${Colors.reset}\n`);
    
    console.log(`  ${Colors.cyan}1.${Colors.reset} Start Stream`);
    console.log(`  ${Colors.cyan}2.${Colors.reset} Dashboard`);
    console.log(`  ${Colors.cyan}3.${Colors.reset} Presets`);
    console.log(`  ${Colors.cyan}4.${Colors.reset} Destinations`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Exit\n`);

    const choice = await ui.ask("Select: ");
    
    if (choice === "1") await menuStart();
    else if (choice === "2") await menuDashboard();
    else if (choice === "3") await menuPresets();
    else if (choice === "4") await menuDests();
    else if (choice === "0") process.exit(0);
  }
}

async function menuStart() {
  while (true) {
    ui.header("START STREAM");
    console.log(`  ${Colors.green}1.${Colors.reset} Quick Start`);
    console.log(`  ${Colors.green}2.${Colors.reset} From Preset`);
    console.log(`  ${Colors.green}3.${Colors.reset} Schedule Stream`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Select: ");
    if (c === "1") await actionQuick();
    else if (c === "2") await actionPreset();
    else if (c === "3") await actionSchedule();
    else if (c === "0") return;
  }
}

async function actionQuick() {
  if (DB.dests.length === 0) return ui.error("No destinations. Add one first.");
  const id = await ui.ask("Stream ID: ");
  const source = await ui.ask("Source (URL or File Path): ");
  
  // Simple config
  const config = {
    source,
    destIndex: 0,
    autoRestart: true,
    maxRetries: 5
  };
  
  await Engine.launch(id, config);
  await ui.wait();
}

async function actionPreset() {
  if (DB.presets.length === 0) return ui.log("No presets found.", "yellow");
  DB.presets.forEach((p, i) => console.log(`  ${i+1}. ${p.name}`));
  const idx = parseInt(await ui.ask("Preset #: ")) - 1;
  
  if (idx >= 0 && DB.presets[idx]) {
    const id = await ui.ask("Stream ID: ");
    await Engine.launch(id, DB.presets[idx].config);
    await ui.wait();
  }
}

async function actionSchedule() {
  if (DB.dests.length === 0) return ui.error("No destinations.");
  const id = await ui.ask("Stream ID: ");
  const source = await ui.ask("Source: ");
  const timeStr = await ui.ask("Time (HH:MM 24h): ");
  
  const [h, m] = timeStr.split(':').map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target <= Date.now()) target.setDate(target.getDate() + 1);

  const config = {
    source,
    destIndex: 0,
    autoRestart: true,
    maxRetries: 5,
    scheduledTime: target.toISOString()
  };

  Scheduler.set(id, config, target - Date.now());
  DB.streams[id] = { status: "SCHEDULED", source: source, platform: "Scheduled", config };
  DB.save("STREAMS");
  
  ui.log(`Scheduled for ${target.toLocaleTimeString()}`, "magenta");
  await ui.wait();
}

async function menuDashboard() {
  while (true) {
    ui.header("DASHBOARD");
    const keys = Object.keys(DB.streams);
    
    if (keys.length === 0) console.log("  No active streams.\n");
    else {
      console.log(`  ${Colors.bright}ID\tSTATUS\t\tSOURCE${Colors.reset}`);
      console.log("  ───────────────────────────────────────────────────");
      
      keys.forEach(k => {
        const s = DB.streams[k];
        let c = "gray";
        if (s.status === "LIVE") c = "green";
        if (s.status === "FAILED") c = "red";
        if (s.status === "SCHEDULED") c = "magenta";
        if (s.status === "RETRYING") c = "yellow";

        const src = s.source.length > 20 ? s.source.substring(0, 17)+"..." : s.source;
        console.log(`  ${k}\t${Colors[c]}${s.status}${Colors.reset}\t${src}`);
      });
      console.log("");
    }

    console.log(`  ${Colors.red}1.${Colors.reset} Stop Stream`);
    console.log(`  ${Colors.red}2.${Colors.reset} Delete Entry`);
    console.log(`  ${Colors.blue}3.${Colors.reset} View FFmpeg Logs`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Action: ");
    if (c === "1") {
      const id = await ui.ask("ID: ");
      if (DB.streams[id]) {
        Engine.kill(DB.streams[id].pid);
        Scheduler.clear(id);
        DB.streams[id].status = "STOPPED";
        DB.streams[id].pid = null;
        DB.save("STREAMS");
        ui.success("Stopped.");
      }
      await ui.wait();
    } else if (c === "2") {
      const id = await ui.ask("ID: ");
      if (DB.streams[id]) {
        Engine.kill(DB.streams[id].pid);
        Scheduler.clear(id);
        delete DB.streams[id];
        DB.save("STREAMS");
        ui.success("Deleted.");
      }
      await ui.wait();
    } else if (c === "3") {
       if (fs.existsSync(FILES.LOGS)) {
         const logs = fs.readFileSync(FILES.LOGS, "utf-8");
         console.log(logs.slice(-2000)); // Last 2KB
       } else ui.log("No logs.", "gray");
       await ui.wait();
    } else if (c === "0") return;
  }
}

async function menuPresets() {
  while (true) {
    ui.header("PRESETS");
    DB.presets.forEach((p, i) => console.log(`  ${i+1}. ${p.name}`));
    console.log("");
    console.log(`  1. Save Current`);
    console.log(`  2. Create New`);
    console.log(`  3. Delete`);
    console.log(`  0. Back\n`);
    
    const c = await ui.ask("Select: ");
    if (c === "1") {
      const id = await ui.ask("Stream ID to save: ");
      if (DB.streams[id]?.config) {
        const name = await ui.ask("Preset Name: ");
        DB.presets.push({ name, config: DB.streams[id].config });
        DB.save("PRESETS");
        ui.success("Saved.");
      }
      await ui.wait();
    } else if (c === "2") {
      const name = await ui.ask("Name: ");
      const src = await ui.ask("Source: ");
      const dIdx = parseInt(await ui.ask("Dest Index: "));
      DB.presets.push({ name, config: { source: src, destIndex: dIdx, autoRestart: true }});
      DB.save("PRESETS");
      ui.success("Created.");
      await ui.wait();
    } else if (c === "3") {
       const idx = parseInt(await ui.ask("#: ")) - 1;
       if (idx >= 0) { DB.presets.splice(idx, 1); DB.save("PRESETS"); ui.success("Deleted."); }
       await ui.wait();
    } else if (c === "0") return;
  }
}

async function menuDests() {
  while (true) {
    ui.header("DESTINATIONS");
    DB.dests.forEach((d, i) => console.log(`  ${i+1}. ${d.name}`));
    console.log("");
    console.log(`  1. Add`);
    console.log(`  2. Remove`);
    console.log(`  0. Back\n`);
    
    const c = await ui.ask("Select: ");
    if (c === "1") {
      const name = await ui.ask("Name: ");
      const rtmp = await ui.ask("RTMP: ");
      const key = await ui.ask("Key: ");
      DB.dests.push({ name, rtmp, key });
      DB.save("DESTS");
      ui.success("Added.");
      await ui.wait();
    } else if (c === "2") {
      const idx = parseInt(await ui.ask("#: ")) - 1;
      if (idx >= 0) { DB.dests.splice(idx, 1); DB.save("DESTS"); ui.success("Removed."); }
      await ui.wait();
    } else if (c === "0") return;
  }
}

// Start
mainMenu();
