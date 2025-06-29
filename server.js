const express = require("express");
const hbs = require("hbs");
const http = require("http");
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "src/pages"));
app.use(express.static("public"));
app.use(bodyParser.json({ limit: "10kb" }));

const DB_FILE = "scripts.json";
let scriptDB = {};

async function loadScripts() {
  try {
    if (await fs.access(DB_FILE).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(DB_FILE, "utf8");
      scriptDB = JSON.parse(raw);
      console.log("✅ Loaded scripts from file.");
    }
  } catch (err) {
    console.error("❌ Load error:", err);
  }
}

async function saveScripts() {
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(scriptDB, null, 2));
    console.log("✅ Scripts saved to file.");
  } catch (err) {
    console.error("❌ Save error:", err);
  }
}

loadScripts();

app.get("/", (req, res) => {
  res.render("loading");
});

app.get("/real-home", (req, res) => {
  res.render("index", { scriptCount: Object.keys(scriptDB).length });
});

app.get("/my-scripts", (req, res) => {
  res.render("my-scripts");
});

app.post("/generate", async (req, res) => {
  try {
    const { script, userId } = req.body;
    if (!script || typeof script !== "string" || script.trim().length === 0) {
      return res.status(400).json({ error: "Invalid or missing script." });
    }
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid or missing user ID." });
    }

    // Normalize script for comparison (remove extra whitespace)
    const normalizedScript = script.trim().replace(/\s+/g, " ");
    // Check for duplicate script by same user
    const existingScript = Object.entries(scriptDB).find(
      ([_, data]) => data.userId === userId && data.script.trim().replace(/\s+/g, " ") === normalizedScript
    );
    if (existingScript) {
      const [id] = existingScript;
      const url = `${req.protocol}://${req.get("host")}/script.lua?id=${id}`;
      return res.status(400).json({
        error: "This script is already protected!",
        loadstring: `loadstring(game:HttpGet("${url}"))()`,
        id
      });
    }

    const id = crypto.randomBytes(8).toString("hex");
    scriptDB[id] = { script: script.trim(), userId, createdAt: new Date().toISOString() };

    await saveScripts();
    const url = `${req.protocol}://${req.get("host")}/script.lua?id=${id}`;
    const loadstring = `loadstring(game:HttpGet("${url}"))()`;
    res.json({ loadstring, id });
  } catch (err) {
    console.error("❌ Generate error:", err);
    res.status(500).json({ error: "Server error while generating link." });
  }
});

app.get("/script.lua", (req, res) => {
  const id = req.query.id;
  if (!id || !scriptDB[id]) {
    return res.status(404).send("Invalid or expired link!");
  }

  // Check User-Agent to allow only Roblox HTTP requests
  const userAgent = req.headers["user-agent"] || "";
  const isRoblox = userAgent.includes("Roblox") || userAgent.includes("HttpGet");
  if (!isRoblox) {
    return res.status(403).send("Access denied: This endpoint is for Roblox execution only.");
  }

  res.type("text/plain").send(scriptDB[id].script);
});

app.post("/my-scripts", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Invalid or missing user ID." });
    }

    const userScripts = Object.entries(scriptDB)
      .filter(([_, script]) => script.userId === userId)
      .map(([id, script]) => ({
        id,
        script: script.script,
        createdAt: script.createdAt,
        loadstring: `loadstring(game:HttpGet("${req.protocol}://${req.get("host")}/script.lua?id=${id}"))()`
      }));

    res.json(userScripts);
  } catch (err) {
    console.error("❌ Fetch scripts error:", err);
    res.status(500).json({ error: "Server error while fetching scripts." });
  }
});

app.put("/my-scripts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { script, userId } = req.body;
    if (!id || !scriptDB[id]) {
      return res.status(404).json({ error: "Script not found." });
    }
    if (scriptDB[id].userId !== userId) {
      return res.status(403).json({ error: "Unauthorized access." });
    }
    if (!script || typeof script !== "string" || script.trim().length === 0) {
      return res.status(400).json({ error: "Invalid or missing script." });
    }

    // Check for duplicate script by same user
    const normalizedScript = script.trim().replace(/\s+/g, " ");
    const existingScript = Object.entries(scriptDB).find(
      ([otherId, data]) => otherId !== id && data.userId === userId && data.script.trim().replace(/\s+/g, " ") === normalizedScript
    );
    if (existingScript) {
      return res.status(400).json({ error: "This script is already protected by you!" });
    }

    scriptDB[id].script = script.trim();
    await saveScripts();
    res.json({ message: "Script updated successfully." });
  } catch (err) {
    console.error("❌ Update script error:", err);
    res.status(500).json({ error: "Server error while updating script." });
  }
});

app.delete("/my-scripts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!id || !scriptDB[id]) {
      return res.status(404).json({ error: "Script not found." });
    }
    if (scriptDB[id].userId !== userId) {
      return res.status(403).json({ error: "Unauthorized access." });
    }

    delete scriptDB[id];
    await saveScripts();
    res.json({ message: "Script deleted successfully." });
  } catch (err) {
    console.error("❌ Delete script error:", err);
    res.status(500).json({ error: "Server error while deleting script." });
  }
});

// Track online users in real-time using Socket.IO
let onlineUsers = 0;
io.on("connection", (socket) => {
  onlineUsers++;
  console.log(`✅ User connected. Online users: ${onlineUsers}`);
  io.emit("onlineUsers", onlineUsers);

  socket.on("disconnect", () => {
    onlineUsers--;
    console.log(`❌ User disconnected. Online users: ${onlineUsers}`);
    io.emit("onlineUsers", onlineUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});