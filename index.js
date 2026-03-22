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
  error: (msg) => console.log(`${Colors.red}❌ Error: ${msg}${Colors.reset}`),
  success: (msg) => console.log(`${Colors.green}✅ ${msg}${Colors.reset}`),
  ask: (q) => new Promise(r => rl.question(q, r)),
  wait: () => new Promise(r => rl.question("\n[Press Enter to continue...] ", r))
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ==========================================
// 💾 DATA LAYER (Crash Safe)
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
    const load = (f, def) => {
      try {
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f));
      } catch (e) {
        ui.error(`Corrupt file ${f}. Resetting it.`);
      }
      return def;
    };
    
    DB.streams = load(FILES.STREAMS, {});
    DB.dests = load(FILES.DESTS, []);
    DB.presets = load(FILES.PRESETS, []);

    // Sanitize PIDs (Fix for restarts)
    let recovered = 0;
    for (let id in DB.streams) {
      if (DB.streams[id].status === "LIVE" || DB.streams[id].status === "STARTING") {
        DB.streams[id].status = "STOPPED";
        DB.streams[id].pid = null;
        DB.streams[id].retryCount = 0;
        recovered++;
      }
    }
    if (recovered > 0) ui.log(`Cleaned up ${recovered} orphaned streams.`, "yellow");
    DB.save("STREAMS");
  },

  save: (key) => {
    try { fs.writeFileSync(FILES[key], JSON.stringify(DB[key], null, 2)); } 
    catch (e) { ui.error("Failed to save data: " + e.message); }
  }
};

// Tool Checks
let hasFfmpeg = false;
let hasYtdlp = false;
try { hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0; } catch(e){}
try { hasYtdlp = spawnSync("yt-dlp", ["--version"]).status === 0; } catch(e){}

if (!hasFfmpeg) ui.error("FFmpeg not found in PATH. Streaming will not work.", "red");
if (!hasYtdlp) ui.log("Warning: yt-dlp not found. URL resolution disabled.", "yellow");

// ==========================================
// ⚙️ ENGINE (Crash Proof)
// ==========================================
const Engine = {
  resolve: (url) => {
    return new Promise((resolve) => {
      if (!hasYtdlp || !url.startsWith("http")) return resolve(null);
      
      let child;
      try {
        child = spawn("yt-dlp", [
          "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", 
          "-g", url
        ]);
      } catch (e) {
        return resolve(null);
      }
      
      let output = "";
      child.stdout.on("data", d => output += d.toString());
      
      // Safety timeout
      const timer = setTimeout(() => { 
        try { child.kill(); } catch(e){}
        resolve(null); 
      }, 10000);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve(null);
        const lines = output.trim().split("\n").filter(l => l.startsWith("http"));
        if (lines.length >= 2) return resolve({ video: lines[0], audio: lines[1] });
        if (lines.length === 1) return resolve({ video: lines[0], audio: null });
        resolve(null);
      });
    });
  },

  launch: async (id, config) => {
    // 1. Validations
    if (!config.source || config.source.trim() === "") return ui.error("Source cannot be empty.");
    if (!hasFfmpeg) return ui.error("Cannot start: FFmpeg is missing.");
    
    const dest = DB.dests[config.destIndex];
    if (!dest) return ui.error(`Destination index ${config.destIndex} does not exist. Please add a destination.`);

    ui.log(`🚀 Launching ${id}...`, "cyan");

    // 2. Check Source Type
    let isLocal = false;
    try {
      // Check if it's a file
      const stat = fs.statSync(config.source);
      if (stat.isFile()) isLocal = true;
      else if (stat.isDirectory()) return ui.error("Source is a folder, not a file.");
    } catch (e) {
      // It's likely a URL or non-existent local file
    }

    let inputArgs = [];
    let mapArgs = [];

    if (isLocal) {
      ui.log("   Source: Local File", "green");
      inputArgs = ["-re", "-i", config.source];
    } else {
      ui.log("   Source: Remote URL (Resolving...)", "yellow");
      const urls = await Engine.resolve(config.source);
      
      if (urls && urls.audio) {
        inputArgs = ["-re", "-i", urls.video, "-i", urls.audio];
        mapArgs = ["-map", "0:v", "-map", "1:a"];
      } else if (urls) {
        inputArgs = ["-re", "-i", urls.video];
      } else {
        ui.log("   Resolution failed. Trying raw URL...", "yellow");
        inputArgs = ["-re", "-i", config.source];
      }
    }

    // 3. Spawn FFmpeg
    const rtmp = `${dest.rtmp.replace(/\/$/, '')}/${dest.key.replace(/^\//, '')}`;
    const ffmpegArgs = [
      ...inputArgs, ...mapArgs,
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-f", "flv",
      rtmp
    ];

    let ffmpeg;
    try {
      // Redirect stderr to log file to keep console clean
      const logStream = fs.createWriteStream(FILES.LOGS, { flags: 'a' });
      ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });
      ffmpeg.stderr.pipe(logStream);
    } catch (e) {
      return ui.error(`Failed to spawn FFmpeg: ${e.message}`);
    }
    
    // 4. Update State
    DB.streams[id] = {
      ...DB.streams[id],
      pid: ffmpeg.pid,
      status: "STARTING",
      startTime: Date.now(),
      source: config.source,
      platform: dest.name,
      config: config,
      retryCount: (DB.streams[id]?.retryCount || 0)
    };
    DB.save("STREAMS");

    // 5. Monitor
    let buffer = "";
    ffmpeg.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1000) buffer = buffer.slice(-1000);

      if (buffer.includes("Press [q]")) {
        if (DB.streams[id].status !== "LIVE") {
          DB.streams[id].status = "LIVE";
          DB.streams[id].retryCount = 0;
          DB.save("STREAMS");
          ui.success(`${id} is LIVE`);
        }
      }
    });

    ffmpeg.on("exit", (code) => {
      const s = DB.streams[id];
      if (!s) return;

      const crashed = code !== 0;
      const shouldRestart = s.config.autoRestart !== false;
      const maxRetries = s.config.maxRetries || 5;
      const currentRetries = s.retryCount || 0;

      if (crashed && shouldRestart && currentRetries < maxRetries) {
        const delay = Math.min(currentRetries * 2, 30) * 1000;
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
    try { process.kill(pid, "SIGTERM"); } catch(e){}
    try { setTimeout(() => process.kill(pid, "SIGKILL"), 2000); } catch(e){}
  }
};

// ==========================================
// 📅 SCHEDULER
// ==========================================
const Scheduler = {
  timers: {},
  init: () => {
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
  DB.init();
  Scheduler.init();

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

    try {
      const choice = await ui.ask("Select: ");
      if (choice === "1") await menuStart();
      else if (choice === "2") await menuDashboard();
      else if (choice === "3") await menuPresets();
      else if (choice === "4") await menuDests();
      else if (choice === "0") process.exit(0);
    } catch (e) {
      ui.error(`Menu Error: ${e.message}`);
      await ui.wait();
    }
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
  if (DB.dests.length === 0) {
    ui.error("No destinations found. Please add one in the Destinations menu first.");
    await ui.wait();
    return;
  }

  const id = await ui.ask("Stream ID: ");
  if (DB.streams[id]) {
    ui.error("Stream ID already exists. Stop or delete it first.");
    await ui.wait();
    return;
  }

  const source = await ui.ask("Source (URL or File Path): ");
  
  const config = {
    source: source.trim(),
    destIndex: 0, // Uses the first destination
    autoRestart: true,
    maxRetries: 5
  };
  
  await Engine.launch(id, config);
  await ui.wait();
}

async function actionPreset() {
  if (DB.presets.length === 0) {
    ui.log("No presets found. Create one in the Presets menu.", "yellow");
    await ui.wait();
    return;
  }

  DB.presets.forEach((p, i) => console.log(`  ${i+1}. ${p.name}`));
  const idxStr = await ui.ask("Preset #: ");
  const idx = parseInt(idxStr) - 1;
  
  if (idx >= 0 && DB.presets[idx]) {
    const id = await ui.ask("Stream ID: ");
    await Engine.launch(id, DB.presets[idx].config);
    await ui.wait();
  } else {
    ui.error("Invalid selection.");
    await ui.wait();
  }
}

async function actionSchedule() {
  if (DB.dests.length === 0) {
    ui.error("No destinations found.");
    await ui.wait();
    return;
  }

  const id = await ui.ask("Stream ID: ");
  const source = await ui.ask("Source: ");
  const timeStr = await ui.ask("Time (HH:MM 24h): ");
  
  const [h, m] = timeStr.split(':').map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target <= Date.now()) target.setDate(target.getDate() + 1);

  const config = {
    source: source.trim(),
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
         console.log(logs.slice(-2000)); 
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
    console.log(`  1. Save Current (Stream must be active/stopped)`);
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
      } else ui.error("Stream not found or no config data.");
      await ui.wait();
    } else if (c === "2") {
      const name = await ui.ask("Name: ");
      const src = await ui.ask("Source: ");
      const dIdx = parseInt(await ui.ask("Dest Index: "));
      if (!DB.dests[dIdx]) {
        ui.error("Invalid destination index.");
        await ui.wait();
        continue;
      }
      DB.presets.push({ name, config: { source: src, destIndex: dIdx, autoRestart: true }});
      DB.save("PRESETS");
      ui.success("Created.");
      await ui.wait();
    } else if (c === "3") {
       const idx = parseInt(await ui.ask("#: ")) - 1;
       if (idx >= 0 && DB.presets[idx]) { 
         DB.presets.splice(idx, 1); 
         DB.save("PRESETS"); 
         ui.success("Deleted."); 
       }
       await ui.wait();
    } else if (c === "0") return;
  }
}

async function menuDests() {
  while (true) {
    ui.header("DESTINATIONS");
    DB.dests.forEach((d, i) => console.log(`  ${i+1}. ${d.name} (${d.rtmp})`));
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
