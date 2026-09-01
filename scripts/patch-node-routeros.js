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
  console.warn(
    "node-routeros Channel.js was not found; RouterOS compatibility patch skipped."
  );
  process.exit(0);
}

let source = fs.readFileSync(channelPath, "utf8");

const incorrectPatch = `            case '!done':
                if (!this.trapped)
                    this.emit('done', this.data);
                this.close();
                break;
            case '!empty':
                if (!this.trapped)
                    this.emit('done', this.data);
                this.close();
                break;`;

const correctedPatch = `            case '!done':
                if (!this.trapped)
                    this.emit('done', this.data);
                this.close();
                break;
            case '!empty':
                break;`;

const correctEmptyOnly = `            case '!empty':
                break;`;

if (source.includes(incorrectPatch)) {
  source = source.replace(incorrectPatch, correctedPatch);
  fs.writeFileSync(channelPath, source, "utf8");
  console.log(
    "Corrected node-routeros RouterOS 7 !empty handling."
  );
  process.exit(0);
}

if (source.includes(correctEmptyOnly)) {
  console.log(
    "node-routeros RouterOS 7 !empty handling is already correct."
  );
  process.exit(0);
}

const doneMarker = `            case '!done':
                if (!this.trapped)
                    this.emit('done', this.data);
                this.close();
                break;`;

if (!source.includes(doneMarker)) {
  console.error(
    "Unable to locate the expected node-routeros Channel.js !done block."
  );
  process.exit(1);
}

source = source.replace(
  doneMarker,
  `${doneMarker}
            case '!empty':
                break;`
);

fs.writeFileSync(channelPath, source, "utf8");

console.log(
  "Applied node-routeros RouterOS 7 !empty compatibility patch."
);
