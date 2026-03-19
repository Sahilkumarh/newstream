const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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
  fs.writeFileSync(STREAM_FILE, JSON.stringify(streams, null, 2));
}

function saveDest() {
  fs.writeFileSync(DEST_FILE, JSON.stringify(destinations, null, 2));
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
 * We force a single file format (mp4) to ensure we get Video + Audio in one link.
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
      // Force a single file format to prevent getting "video only" or "audio only" URLs
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

    // Just take the first valid URL
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
  if (choice === "5") {
    // Optional: Kill all running streams on exit
    /* 
    Object.keys(streams).forEach(id => {
       if(streams[id].status === 'LIVE') killStream(id);
    });
    */
    process.exit(0);
  }

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

  // 3. Determine Mode (Pipe vs Direct)
  let useYtDlpPipe = false;
  let inputUrl = url.trim();
  let resolvedUrl = null;

  if (hasYtdlp) {
    const pipeAnswer = await ask(
      "Use yt-dlp Pipe Mode? (Recommended for YouTube/Facebook) (y/n): "
    );
    useYtDlpPipe = pipeAnswer.trim().toLowerCase().startsWith("y");

    if (!useYtDlpPipe) {
      const resolveAnswer = await ask(
        "Resolve URL to direct link? (Avoids URL expiration issues) (y/n): "
      );
      if (resolveAnswer.trim().toLowerCase().startsWith("y")) {
        console.log("Resolving URL... (this may take a moment)");
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
  
  // If looping is requested and not piping, add loop flag
  if (shouldLoop && !useYtDlpPipe) {
    ffmpegArgs.push("-stream_loop", "-1");
  }

  // Input source
  if (useYtDlpPipe) {
    // In pipe mode, ffmpeg reads from stdin
    // We specify -f mp4 so ffmpeg knows what's coming down the pipe
    ffmpegArgs.push("-f", "mp4", "-i", "pipe:0");
  } else {
    ffmpegArgs.push("-i", finalInput);
  }

  // Output settings (Copy codecs, FLV format for RTMP)
  ffmpegArgs.push("-c", "copy", "-f", "flv", `${dest.rtmp}/${dest.key}`);

  console.log("\nStarting ffmpeg...");

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: useYtDlpPipe ? ["pipe", "inherit", "pipe"] : "pipe",
  });

  let ytdlp = null;
  if (useYtDlpPipe) {
    // yt-dlp args for piping
    // -f best: Selects best single file (prevents merge-to-stdout errors)
    // -o -: Output to stdout
    const ytdlpArgs = [
      "--no-playlist",
      "--no-warnings",
      "--user-agent",
      YTDLP_USER_AGENT,
      "-f",
      "best", 
      "-o",
      "-",
    ];

    if (cookiesFile && fs.existsSync(cookiesFile)) {
      ytdlpArgs.push("--cookies", cookiesFile);
    }
    ytdlpArgs.push(inputUrl);

    ytdlp = spawn("yt-dlp", ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"], // Ignore stdin, pipe stdout, capture stderr
    });

    // Pipe yt-dlp output directly to ffmpeg input
    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.stderr.on("data", (chunk) => {
      // Optional: Log yt-dlp errors if needed, or suppress to keep console clean
      // console.log("yt-dlp:", chunk.toString());
    });

    ytdlp.on("exit", (code) => {
      if (streams[id] && streams[id].status !== "STOPPED") {
        streams[id].status = "FAILED";
        streams[id].error = `yt-dlp exited with code ${code}`;
        saveStreams();
        console.log(`\n⚠️  Stream ${id} yt-dlp process stopped.`);
      }
    });
  }

  // 6. Manage Stream State
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

  ffmpeg.stderr.on("data", (data) => {
    const msg = data.toString();

    // Detect Success
    if (msg.includes("Press [q]")) {
      if (streams[id].status !== "LIVE") {
        streams[id].status = "LIVE";
        saveStreams();
        console.log(`\n🚀 Stream ${id} is now LIVE!\n`);
      }
    }

    // Detect Failure (Basic keywords)
    if (
      msg.includes("Connection refused") ||
      msg.includes("403 Forbidden") ||
      msg.includes("Invalid data found")
    ) {
      streams[id].status = "FAILED";
      streams[id].error = msg.slice(0, 150).replace(/\n/g, " ");
      saveStreams();
    }
  });

  ffmpeg.on("exit", (code) => {
    if (!streams[id]) return;
    if (streams[id].status !== "FAILED") {
      streams[id].status = "STOPPED";
    }
    saveStreams();
    // If ffmpeg dies, we should also kill yt-dlp if it's still running
    if (ytdlp && ytdlp.exitCode === null) {
      ytdlp.kill();
    }
  });

  console.log(`Stream "${id}" process started (PID: ${ffmpeg.pid}).`);
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
    // Kill ffmpeg
    if (s.pid) process.kill(s.pid);
  } catch (e) {
    // Process might already be dead
  }

  try {
    // Kill yt-dlp
    if (s.ytdlpPid) process.kill(s.ytdlpPid);
  } catch (e) {
    // Process might already be dead
  }

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
