const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ==========================================
// 🎨 UI & COLORS
// ==========================================
const Colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

const ui = {
  log: (msg, color = "reset") => console.log(`${Colors[color]}${msg}${Colors.reset}`),
  header: (title) => {
    console.clear();
    console.log(`\n${Colors.bright}${Colors.cyan}═══════════════════════════════════════════════════════${Colors.reset}`);
    console.log(`${Colors.bright}${Colors.blue}    ${title}${Colors.reset}`);
    console.log(`${Colors.bright}${Colors.cyan}═══════════════════════════════════════════════════════${Colors.reset}\n`);
  },
  ask: (q) => new Promise(r => rl.question(q, r)),
  wait: () => new Promise(r => rl.question("\n[Press Enter to continue...] ", r))
};

// ==========================================
// 💾 DATA & CONFIG
// ==========================================
const FILES = {
  STREAMS: "phoenix_streams.json",
  DESTS: "phoenix_dests.json",
  PRESETS: "phoenix_presets.json",
  LOGS: "phoenix_logs.txt"
};

const DB = {
  streams: fs.existsSync(FILES.STREAMS) ? JSON.parse(fs.readFileSync(FILES.STREAMS)) : {},
  dests: fs.existsSync(FILES.DESTS) ? JSON.parse(fs.readFileSync(FILES.DESTS)) : [],
  presets: fs.existsSync(FILES.PRESETS) ? JSON.parse(fs.readFileSync(FILES.PRESETS)) : [],
  save: (key) => fs.writeFileSync(FILES[key], JSON.stringify(DB[key], null, 2))
};

// Check for yt-dlp
const hasYtdlp = spawnSync("yt-dlp", ["--version"]).status === 0;

// ==========================================
// ⚙️ ENGINE CORE (Spawning & Killing)
// ==========================================
const Engine = {
  // Resolve YouTube URL to 1080p links
  resolve: (url) => {
    if (!hasYtdlp || !url.startsWith("http")) return null;
    try {
      // Best Video + Best Audio for max quality
      const args = ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "-g", url];
      const res = spawnSync("yt-dlp", args, { encoding: "utf8" });
      if (res.status !== 0) return null;
      const lines = res.stdout.trim().split("\n").filter(l => l.startsWith("http"));
      if (lines.length >= 2) return { video: lines[0], audio: lines[1] };
      if (lines.length === 1) return { video: lines[0], audio: null };
      return null;
    } catch (e) { return null; }
  },

  // The "Nuke" function - Ensures processes die
  kill: (pid) => {
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {}
    try {
      // Force kill if it lingers
      setTimeout(() => process.kill(pid, "SIGKILL"), 2000);
    } catch (e) {}
  },

  launch: (id, config) => {
    const dest = DB.dests[config.destIndex];
    if (!dest) return ui.log("Error: Destination missing.", "red");

    ui.log(`🚀 Launching Stream: ${id}`, "cyan");
    ui.log(`   Target: ${dest.name}`, "blue");

    // 1. Determine Input
    let inputArgs = [];
    let mapArgs = [];
    let urls = null;

    const isLocal = fs.existsSync(config.source); // Check if file exists locally

    if (isLocal) {
      ui.log("   Source: Local File", "green");
      inputArgs = ["-re", "-i", config.source];
    } else {
      // It's a URL
      if (config.resolvedUrls) {
        // Restarting with saved URLs
        urls = config.resolvedUrls;
      } else {
        // New URL -> Resolve
        ui.log("   Source: Remote URL (Resolving quality...)", "yellow");
        urls = Engine.resolve(config.source);
      }

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

    // 2. Construct FFmpeg Command
    const rtmp = `${dest.rtmp.replace(/\/$/, '')}/${dest.key.replace(/^\//, '')}`;
    const ffmpegArgs = [
      ...inputArgs,
      ...mapArgs,
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-f", "flv",
      rtmp
    ];

    // 3. Spawn
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "inherit", "pipe"] });
    
    // 4. Save State
    DB.streams[id] = {
      pid: ffmpeg.pid,
      ytdlpPid: null, // Not using pipe mode in this stable version to avoid EPIPE
      status: "STARTING",
      startTime: Date.now(),
      source: config.source,
      platform: dest.name,
      config: { ...config, resolvedUrls: urls }, // Persist resolved URLs
      retries: (DB.streams[id]?.retries || 0) + 1
    };
    DB.save("STREAMS");

    // 5. Monitor
    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("Press [q]")) {
        DB.streams[id].status = "LIVE";
        DB.streams[id].retries = 0; // Reset retry count on success
        DB.save("STREAMS");
        ui.log(`✅ ${id} is LIVE`, "green");
      }
    });

    ffmpeg.on("exit", (code) => {
      const s = DB.streams[id];
      if (!s) return;

      const crashed = code !== 0;
      const shouldAutoRestart = config.autoRestart !== false;

      if (crashed && shouldAutoRestart) {
        ui.log(`💥 ${id} Crashed. Restarting in 3s...`, "yellow");
        setTimeout(() => Engine.launch(id, s.config), 3000);
      } else {
        s.status = crashed ? "FAILED" : "STOPPED";
        DB.save("STREAMS");
        ui.log(`🛑 ${id} Stopped.`, "gray");
      }
    });
  }
};

// ==========================================
// 📅 SCHEDULER
// ==========================================
const Scheduler = {
  jobs: {}, // Stores timeouts

  add: (id, config, timeStr) => {
    const now = new Date();
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);

    if (target <= now) target.setDate(target.getDate() + 1); // Schedule for tomorrow if time passed

    const diff = target - now;
    ui.log(`⏰ Scheduled ${id} for ${target.toLocaleTimeString()} (in ${Math.floor(diff/60000)} mins)`, "magenta");

    const tid = setTimeout(() => {
      ui.log(`⏰ Triggering Scheduled Stream: ${id}`, "magenta");
      delete Scheduler.jobs[id];
      Engine.launch(id, config);
    }, diff);

    Scheduler.jobs[id] = tid;
    
    // Save to DB for persistence
    DB.streams[id] = {
      status: "SCHEDULED",
      startTime: target.toISOString(),
      source: config.source,
      platform: "Scheduled",
      config: config
    };
    DB.save("STREAMS");
  },

  clear: (id) => {
    if (Scheduler.jobs[id]) clearTimeout(Scheduler.jobs[id]);
    delete Scheduler.jobs[id];
  }
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ==========================================
// 🧭 MENUS
// ==========================================

async function mainMenu() {
  while (true) {
    // Calc stats
    const active = Object.values(DB.streams).filter(s => s.status === "LIVE").length;
    const sched = Object.values(DB.streams).filter(s => s.status === "SCHEDULED").length;
    
    ui.header("PHOENIX STREAM MANAGER");
    console.log(`  Status: ${Colors.green}${active} Live${Colors.reset} | ${Colors.magenta}${sched} Scheduled${Colors.reset}\n`);
    
    console.log(`  ${Colors.cyan}1.${Colors.reset} Start Stream`);
    console.log(`  ${Colors.cyan}2.${Colors.reset} Live Dashboard`);
    console.log(`  ${Colors.cyan}3.${Colors.reset} Manage Presets`);
    console.log(`  ${Colors.cyan}4.${Colors.reset} Manage Destinations`);
    console.log(`  ${Colors.red}0.${Colors.reset} Exit\n`);

    const choice = await ui.ask("Select: ");
    
    if (choice === "1") await menuStart();
    else if (choice === "2") await menuDashboard();
    else if (choice === "3") await menuPresets();
    else if (choice === "4") await menuDests();
    else if (choice === "0") process.exit(0);
  }
}

// --- START MENU ---
async function menuStart() {
  while (true) {
    ui.header("START STREAM");
    console.log(`  ${Colors.green}1.${Colors.reset} Quick Start (URL or Local File)`);
    console.log(`  ${Colors.green}2.${Colors.reset} From Preset`);
    console.log(`  ${Colors.green}3.${Colors.reset} Schedule Stream`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Select: ");
    
    if (c === "1") await actionQuickStart();
    else if (c === "2") await actionStartPreset();
    else if (c === "3") await actionSchedule();
    else if (c === "0") return;
  }
}

async function actionQuickStart() {
  if (DB.dests.length === 0) return ui.log("Error: No destinations. Add one first.", "red");

  const id = await ui.ask("Stream ID: ");
  if (DB.streams[id]) return ui.log("Error: ID exists.", "red");

  const source = await ui.ask("Source (URL or File Path): ");
  
  // Auto-detect destination
  const destIdx = 0; // Default to first
  const config = {
    source: source,
    destIndex: destIdx,
    autoRestart: true,
    loop: true
  };

  Engine.launch(id, config);
  await ui.wait();
}

async function actionStartPreset() {
  if (DB.presets.length === 0) return ui.log("No presets saved.", "yellow");
  
  DB.presets.forEach((p, i) => console.log(`  ${i+1}. ${p.name}`));
  const idx = parseInt(await ui.ask("Preset #: ")) - 1;
  
  if (idx >= 0 && DB.presets[idx]) {
    const id = await ui.ask("Stream ID: ");
    Engine.launch(id, DB.presets[idx].config);
    await ui.wait();
  }
}

async function actionSchedule() {
  if (DB.dests.length === 0) return ui.log("Error: No destinations.", "red");
  
  const id = await ui.ask("Stream ID: ");
  const source = await ui.ask("Source (URL or File): ");
  const time = await ui.ask("Start Time (HH:MM 24h): ");
  
  const config = {
    source: source,
    destIndex: 0,
    autoRestart: true,
    loop: true
  };
  
  Scheduler.add(id, config, time);
  await ui.wait();
}

// --- DASHBOARD ---
async function menuDashboard() {
  while (true) {
    ui.header("LIVE DASHBOARD");
    
    let count = 0;
    const keys = Object.keys(DB.streams);
    
    if (keys.length === 0) {
      console.log("  No streams tracked.\n");
    } else {
      console.log(`  ${Colors.bright}ID\tSTATUS\t\tSOURCE${Colors.reset}`);
      console.log("  ───────────────────────────────────────────────────────");
      
      keys.forEach(k => {
        const s = DB.streams[k];
        let color = "gray";
        if (s.status === "LIVE") color = "green";
        if (s.status === "FAILED") color = "red";
        if (s.status === "SCHEDULED") color = "magenta";
        
        // Truncate source
        const src = s.source.length > 25 ? s.source.substring(0, 22) + "..." : s.source;
        
        console.log(`  ${k}\t${Colors[color]}${s.status}${Colors.reset}\t${src}`);
        count++;
      });
      console.log("");
    }

    console.log(`  ${Colors.red}1.${Colors.reset} Stop Stream`);
    console.log(`  ${Colors.red}2.${Colors.reset} Delete Entry`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Action: ");

    if (c === "1") {
      const id = await ui.ask("ID to stop: ");
      if (DB.streams[id]) {
        Engine.kill(DB.streams[id].pid);
        Scheduler.clear(id);
        DB.streams[id].status = "STOPPED";
        DB.save("STREAMS");
        ui.log(`Stopped ${id}`, "red");
      }
      await ui.wait();
    } else if (c === "2") {
      const id = await ui.ask("ID to delete: ");
      if (DB.streams[id]) {
        // Ensure it's stopped
        if (DB.streams[id].pid) Engine.kill(DB.streams[id].pid);
        Scheduler.clear(id);
        delete DB.streams[id];
        DB.save("STREAMS");
        ui.log(`Deleted ${id}`, "yellow");
      }
      await ui.wait();
    } else if (c === "0") return;
  }
}

// --- PRESETS ---
async function menuPresets() {
  while (true) {
    ui.header("MANAGE PRESETS");
    DB.presets.forEach((p, i) => console.log(`  ${i+1}. ${p.name} -> ${p.config.source}`));
    console.log("");
    
    console.log(`  ${Colors.green}1.${Colors.reset} Save Current Config as Preset`);
    console.log(`  ${Colors.green}2.${Colors.reset} Create New Preset`);
    console.log(`  ${Colors.red}3.${Colors.reset} Delete Preset`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Select: ");

    if (c === "1") {
      const id = await ui.ask("Stream ID to save: ");
      if (DB.streams[id] && DB.streams[id].config) {
        const name = await ui.ask("Preset Name: ");
        DB.presets.push({ name, config: DB.streams[id].config });
        DB.save("PRESETS");
        ui.log("Preset saved.", "green");
      } else ui.log("Stream not found or no config.", "red");
      await ui.wait();
    } else if (c === "2") {
      const name = await ui.ask("Name: ");
      const source = await ui.ask("Source: ");
      const dIdx = parseInt(await ui.ask(`Dest Index (0-${DB.dests.length-1}): `));
      
      DB.presets.push({
        name,
        config: { source, destIndex: dIdx, autoRestart: true, loop: true }
      });
      DB.save("PRESETS");
      ui.log("Preset created.", "green");
      await ui.wait();
    } else if (c === "3") {
      const idx = parseInt(await ui.ask("Preset #: ")) - 1;
      if (idx >= 0) {
        DB.presets.splice(idx, 1);
        DB.save("PRESETS");
        ui.log("Deleted.", "red");
      }
      await ui.wait();
    } else if (c === "0") return;
  }
}

// --- DESTINATIONS ---
async function menuDests() {
  while (true) {
    ui.header("DESTINATIONS");
    DB.dests.forEach((d, i) => console.log(`  ${i+1}. ${d.name} (${d.rtmp})`));
    console.log("");

    console.log(`  ${Colors.green}1.${Colors.reset} Add Destination`);
    console.log(`  ${Colors.red}2.${Colors.reset} Remove Destination`);
    console.log(`  ${Colors.gray}0.${Colors.reset} Back\n`);

    const c = await ui.ask("Select: ");

    if (c === "1") {
      const name = await ui.ask("Name: ");
      const rtmp = await ui.ask("RTMP URL: ");
      const key = await ui.ask("Stream Key: ");
      DB.dests.push({ name, rtmp, key });
      DB.save("DESTS");
      ui.log("Added.", "green");
      await ui.wait();
    } else if (c === "2") {
      const idx = parseInt(await ui.ask("Dest #: ")) - 1;
      if (idx >= 0) {
        DB.dests.splice(idx, 1);
        DB.save("DESTS");
        ui.log("Removed.", "red");
      }
      await ui.wait();
    } else if (c === "0") return;
  }
}

// Start
mainMenu();
