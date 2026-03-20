const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

// ================= CONFIGURATION =================
const STREAM_FILE = "streams.json";
const DEST_FILE = "destinations.json";
const YTDLP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Check for yt-dlp
let hasYtdlp = false;
try {
  const check = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  hasYtdlp = check.status === 0;
} catch (err) {
  hasYtdlp = false;
}

if (!hasYtdlp) {
  console.log(
    "⚠️  yt-dlp not found. YouTube/Facebook URLs will not work reliably."
  );
}

// Load Data
let streams = fs.existsSync(STREAM_FILE)
  ? JSON.parse(fs.readFileSync(STREAM_FILE))
  : {};

let destinations = fs.existsSync(DEST_FILE)
  ? JSON.parse(fs.readFileSync(DEST_FILE))
  : [];

// Save Data Helpers
function saveStreams() {
  try {
    fs.writeFileSync(STREAM_FILE, JSON.stringify(streams, null, 2));
  } catch (e) {}
}

function saveDest() {
  try {
    fs.writeFileSync(DEST_FILE, JSON.stringify(destinations, null, 2));
  } catch (e) {}
}

// Input Helper
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((res) => rl.question(q, res));
}

// ================= LOGIC =================

/**
 * Resolves the URL to a direct download link.
 */
function resolveInputUrl(url, cookiesFile = null) {
  if (!hasYtdlp) return null;

  try {
    const args = [
      "-g",
      "--no-playlist",
      "--no-warnings",
      "--user-agent",
      YTDLP_USER_AGENT,
      "-f",
      "best[ext=mp4]/best",
    ];

    if (cookiesFile) {
      args.push("--cookies", cookiesFile);
    }

    args.push(url);

    const res = spawnSync("yt-dlp", args, { encoding: "utf8" });
    if (res.status !== 0) return null;

    const out = (res.stdout || "").trim();
    if (!out) return null;

    return out.split(/\r?\n/)[0].trim();
  } catch (err) {
    return null;
  }
}

// ================= MENU =================
async function menu() {
  console.log("\n==============================");
  console.log("🎥 STREAM CONTROL PANEL");
  console.log("==============================\n");

  console.log("1. Start Stream");
  console.log("2. Stop Stream");
  console.log("3. View Dashboard");
  console.log("4. Clear Stopped/Failed");
  console.log("5. Exit\n");

  const choice = await ask("Enter choice: ");

  if (choice === "1") return start();
  if (choice === "2") return stop();
  if (choice === "3") return view();
  if (choice === "4") return cleanup();
  if (choice === "5") process.exit(0);

  console.log("Invalid choice\n");
  return menu();
}

// ================= START =================
async function start() {
  console.log("\n--- Start Stream ---\n");

  // 1. Select Destination
  let dest;
  if (destinations.length > 0) {
    destinations.forEach((d, i) => {
      console.log(`${i + 1}. ${d.name}`);
    });
    console.log(`${destinations.length + 1}. Add New\n`);

    const dChoice = await ask("Select destination: ");
    const idx = parseInt(dChoice);

    if (idx === destinations.length + 1) {
      dest = await addDestination();
    } else if (idx > 0 && idx <= destinations.length) {
      dest = destinations[idx - 1];
    } else {
      console.log("Invalid selection.");
      return menu();
    }
  } else {
    dest = await addDestination();
  }

  // 2. Get Input Details
  const id = await ask("Stream ID: ");
  if (streams[id]) {
    console.log("⚠️  Stream ID already exists\n");
    return menu();
  }

  const url = await ask("Input video URL: ");
  const cookiesFile = (await ask("Cookies file path (leave blank to skip): ")).trim();
  if (cookiesFile && !fs.existsSync(cookiesFile)) {
    console.log(`⚠️  Cookies file not found. Proceeding without cookies.`);
  }

  // 3. Determine Mode
  let useYtDlpPipe = false;
  let inputUrl = url.trim();
  let resolvedUrl = null;

  if (hasYtdlp) {
    const pipeAnswer = await ask(
      "Use yt-dlp Pipe Mode? (Recommended) (y/n): "
    );
    useYtDlpPipe = pipeAnswer.trim().toLowerCase().startsWith("y");

    if (!useYtDlpPipe) {
      const resolveAnswer = await ask(
        "Resolve URL to direct link? (y/n): "
      );
      if (resolveAnswer.trim().toLowerCase().startsWith("y")) {
        console.log("Resolving URL...");
        resolvedUrl = resolveInputUrl(inputUrl, cookiesFile || null);
        if (resolvedUrl) {
          console.log("✅ Resolved to:", resolvedUrl);
        } else {
          console.log("⚠️  Resolution failed. Using original URL.");
        }
      }
    }
  } else {
    console.log("ℹ️  Running in Direct Mode (no yt-dlp detected).");
  }

  // 4. Looping
  let shouldLoop = false;
  if (!useYtDlpPipe) {
    const loopAnswer = await ask("Loop input when it ends? (y/n): ");
    shouldLoop = loopAnswer.trim().toLowerCase().startsWith("y");
  } else {
    console.log("ℹ️  Looping is disabled in Pipe Mode.");
  }

  // 5. Construct Commands
  const ffmpegArgs = ["-re"];
  const finalInput = resolvedUrl || inputUrl;
  
  if (shouldLoop && !useYtDlpPipe) {
    ffmpegArgs.push("-stream_loop", "-1");
  }

  // INPUT
  if (useYtDlpPipe) {
    ffmpegArgs.push("-i", "pipe:0");
  } else {
    ffmpegArgs.push("-i", finalInput);
  }

  // OUTPUT
  // We use TRANSCODING. If this fails, it's usually because libx264 is missing.
  ffmpegArgs.push(
    "-c:v", "libx264", 
    "-preset", "ultrafast", 
    "-tune", "zerolatency", 
    "-c:a", "aac", 
    "-b:a", "128k", 
    "-f", "flv", 
    `${dest.rtmp}/${dest.key}`
  );

  console.log("\n[INFO] Starting ffmpeg...");
  console.log("[INFO] Watch the logs below for errors.");

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: useYtDlpPipe ? ["pipe", "inherit", "pipe"] : "pipe",
  });

  // Buffer to capture the last line of error
  let lastFfmpegError = "Unknown error";

  // ==========================================
  // SAFE PIPE LOGIC
  // ==========================================
  let ytdlp = null;
  if (useYtDlpPipe) {
    
    ffmpeg.stdin.on("error", (err) => {
      if (err.code === "EPIPE") {
        // Ignore EPIPE, it just means ffmpeg died
      } else {
        console.error("[STDIN ERROR]:", err.message);
      }
    });

    const ytdlpArgs = [
      "--no-playlist",
      "--no-warnings",
      "--user-agent",
      YTDLP_USER_AGENT,
      "-f", "best",
      "-o", "-",
    ];

    if (cookiesFile && fs.existsSync(cookiesFile)) {
      ytdlpArgs.push("--cookies", cookiesFile);
    }
    ytdlpArgs.push(inputUrl);

    ytdlp = spawn("yt-dlp", ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    ytdlp.stdout.on("data", (chunk) => {
      if (ffmpeg.killed || !ffmpeg.stdin.writable) {
        ytdlp.kill();
        return;
      }

      const ok = ffmpeg.stdin.write(chunk);
      if (!ok) {
        ytdlp.stdout.pause();
      }
    });

    ffmpeg.stdin.on("drain", () => {
      if (ytdlp.stdout && !ytdlp.stdout.destroyed) {
        ytdlp.stdout.resume();
      }
    });

    ytdlp.stdout.on("end", () => {
      if (ffmpeg.stdin.writable) {
        ffmpeg.stdin.end();
      }
    });

    ytdlp.stderr.on("data", (data) => {
        const msg = data.toString();
        if(msg.includes("ERROR:") || msg.includes("Sign in")) {
             console.log(`[YTDLP ERROR] ${msg.trim()}`);
             lastFfmpegError = `yt-dlp: ${msg.trim()}`;
        }
    });

    ytdlp.on("exit", (code) => {
      if (streams[id] && streams[id].status !== "STOPPED") {
        streams[id].status = "FAILED";
        streams[id].error = `yt-dlp exited (code ${code})`;
        saveStreams();
      }
    });
  }

  // 6. State Management
  streams[id] = {
    pid: ffmpeg.pid,
    ytdlpPid: ytdlp ? ytdlp.pid : null,
    url: inputUrl,
    platform: dest.name,
    mode: useYtDlpPipe ? "PIPE" : "DIRECT",
    started: new Date().toLocaleString(),
    status: "STARTING",
    error: "",
  };
  saveStreams();

  // 7. LOGGING & ERROR CAPTURE
  ffmpeg.stderr.on("data", (data) => {
    const msg = data.toString();
    
    // 1. Print to console immediately
    // We filter out generic frame logs to keep it readable, but show errors
    if (msg.includes("frame=")) {
       // Optional: uncomment to see every frame
       // process.stdout.write(`\r[FFmpeg] ${msg.trim().substring(0, 50)}...`);
    } else {
       console.log(`[FFmpeg] ${msg.trim()}`);
    }

    // 2. Capture the last relevant message for the error report
    if (
      msg.includes("Error") ||
      msg.includes("Invalid") ||
      msg.includes("Connection") ||
      msg.includes("403") ||
      msg.includes("404") ||
      msg.includes("Unknown encoder")
    ) {
      lastFfmpegError = msg.trim();
    }

    if (msg.includes("Press [q]")) {
      if (streams[id].status !== "LIVE") {
        streams[id].status = "LIVE";
        saveStreams();
        console.log(`\n🚀 Stream ${id} is now LIVE!\n`);
      }
    }
  });

  ffmpeg.on("exit", (code) => {
    if (!streams[id]) return;
    
    if (ytdlp && !ytdlp.killed) {
      ytdlp.kill();
    }

    if (streams[id].status !== "FAILED") {
      streams[id].status = "STOPPED";
    }
    
    // Save the captured error
    if (code !== 0) {
        streams[id].error = lastFfmpegError;
        
        // Specific Help for common errors
        if (lastFfmpegError.includes("Unknown encoder 'libx264'")) {
            console.log("\n❌ CRITICAL ERROR: Your FFmpeg installation is missing 'libx264'.");
            console.log("   You cannot use transcoding mode with this build of FFmpeg.");
            console.log("   Solution: Install a full version of ffmpeg (e.g., via apt on Linux/Termux).");
        } else if (lastFfmpegError.includes("403") || lastFfmpegError.includes("Sign in")) {
            console.log("\n❌ ERROR: YouTube is blocking the request.");
            console.log("   The video might be age-restricted or region-locked.");
            console.log("   Try providing a valid Cookies file.");
        }
    }

    saveStreams();
    console.log(`\n🛑 Stream ${id} process stopped (Code: ${code}).\n`);
    console.log(`   Reason: ${lastFfmpegError}\n`);
  });

  menu();
}

// ================= ADD DEST =================
async function addDestination() {
  console.log("\n--- Add New Platform ---\n");
  const name = await ask("Name (e.g., YouTube Main): ");
  const rtmp = await ask("RTMP URL (e.g., rtmp://a.rtmp.youtube.com/live2): ");
  const key = await ask("Stream Key: ");

  const obj = { name, rtmp, key };
  destinations.push(obj);
  saveDest();
  return obj;
}

// ================= STOP =================
async function stop() {
  console.log("\n--- Stop Stream ---\n");

  const ids = Object.keys(streams).filter(
    (id) => streams[id].status === "STARTING" || streams[id].status === "LIVE"
  );

  if (ids.length === 0) {
    console.log("No active streams running.\n");
    return menu();
  }

  ids.forEach((id, i) => {
    console.log(`${i + 1}. ${id} (${streams[id].status})`);
  });

  const choice = await ask("Select stream to stop: ");
  const id = ids[parseInt(choice) - 1];

  if (!id) {
    console.log("Invalid selection.\n");
    return menu();
  }

  killStream(id);
  console.log(`🛑 Stopped ${id}\n`);
  menu();
}

function killStream(id) {
  const s = streams[id];
  if (!s) return;

  try {
    if (s.pid) process.kill(s.pid);
  } catch (e) {}

  try {
    if (s.ytdlpPid) process.kill(s.ytdlpPid);
  } catch (e) {}

  s.status = "STOPPED";
  saveStreams();
}

// ================= DASHBOARD =================
function view() {
  console.log("\n========= DASHBOARD =========\n");

  const active = [];
  const failed = [];
  const stopped = [];

  for (let id in streams) {
    const s = streams[id];
    if (s.status === "LIVE" || s.status === "STARTING") active.push(id);
    else if (s.status === "FAILED") failed.push(id);
    else stopped.push(id);
  }

  console.log("🟢 ACTIVE STREAMS:");
  if (active.length === 0) console.log("  None");
  active.forEach((id) => {
    const s = streams[id];
    console.log(`  - ${id} | Platform: ${s.platform} | Mode: ${s.mode}`);
    console.log(`    Started: ${s.started}`);
  });

  console.log("\n🔴 FAILED STREAMS:");
  if (failed.length === 0) console.log("  None");
  failed.forEach((id) => {
    const s = streams[id];
    console.log(`  - ${id}`);
    console.log(`    Error: ${s.error}`);
  });

  console.log("\n⚫ STOPPED STREAMS:");
  if (stopped.length === 0) console.log("  None");
  stopped.forEach((id) => {
    console.log(`  - ${id}`);
    if(streams[id].error) console.log(`    Reason: ${streams[id].error}`);
  });

  console.log("\n=============================\n");
  menu();
}

// ================= CLEANUP =================
async function cleanup() {
  const confirm = await ask("Clear stopped/failed streams? (y/n): ");
  if (confirm.toLowerCase() !== "y") return menu();

  for (let id in streams) {
    if (streams[id].status !== "LIVE" && streams[id].status !== "STARTING") {
      delete streams[id];
    }
  }
  saveStreams();
  console.log("🧹 Cleaned up\n");
  menu();
}

// ================= START APP =================
menu();
