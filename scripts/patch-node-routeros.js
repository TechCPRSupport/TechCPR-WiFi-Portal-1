const fs = require("fs");
const path = require("path");

const channelPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "node-routeros",
  "dist",
  "Channel.js"
);

if (!fs.existsSync(channelPath)) {
  console.warn("node-routeros Channel.js was not found; compatibility patch skipped.");
  process.exit(0);
}

let source = fs.readFileSync(channelPath, "utf8");

if (source.includes("case '!empty':")) {
  console.log("node-routeros RouterOS !empty compatibility patch already present.");
  process.exit(0);
}

const marker = `            case '!done':\n                if (!this.trapped)\n                    this.emit('done', this.data);\n                this.close();\n                break;`;

const replacement = `${marker}\n            case '!empty':\n                if (!this.trapped)\n                    this.emit('done', this.data);\n                this.close();\n                break;`;

if (!source.includes(marker)) {
  console.error("Unable to locate the expected node-routeros Channel.js block.");
  process.exit(1);
}

source = source.replace(marker, replacement);
fs.writeFileSync(channelPath, source, "utf8");
console.log("Applied RouterOS 7 !empty compatibility patch to node-routeros.");
