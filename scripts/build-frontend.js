// Inlines vault-model.js into a single self-contained frontend/index.html  (node scripts/build-frontend.js)
const fs = require("fs");
const t = fs.readFileSync("frontend/index.template.html", "utf8");
const m = fs.readFileSync("frontend/vault-model.js", "utf8");
fs.writeFileSync("frontend/index.html", t.replace("/*MODEL*/", () => m));
console.log("frontend/index.html built");
