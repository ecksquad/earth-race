const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const types = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".json": "application/json", ".mp3": "audio/mpeg" };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const full = path.join(root, p);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": types[path.extname(full)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}).listen(8732, () => console.log("no-cache server on 8732"));
