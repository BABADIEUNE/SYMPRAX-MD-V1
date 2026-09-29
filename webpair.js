import express from "express";
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
let sockInstance = null;
let lastCode = null;
function setSock(s) { sockInstance = s; }
function setCode(c) { lastCode = c; }

const page = (inner) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head><body style="background:#111;color:#fff;text-align:center;font-family:sans-serif;padding:30px">${inner}</body></html>`;

app.get("/", (req, res) => res.send(page(`<h1>SYMPRAX MD V1</h1><h3>DEV SYMPRAX</h3>${lastCode ? `<h2 style="letter-spacing:4px">CODE: ${lastCode}</h2>` : ""}
<form action="/pair" method="POST"><input name="number" placeholder="237XXXXXXXXX" style="padding:15px;width:250px;font-size:18px" required><br><br>
<button style="padding:15px 30px;background:#25D366;color:#fff;border:none;font-size:18px;border-radius:10px">GET PAIRING CODE</button></form>
<p>WhatsApp &gt; Appareils lies &gt; Lier avec code</p>`)));

async function pair(num) {
  if (!num) throw new Error("Numero invalide");
  if (!sockInstance) throw new Error("Bot pas demarre, attends 5s");
  return await sockInstance.requestPairingCode(num);
}
app.post("/pair", async (req, res) => {
  try { const code = await pair(String(req.body.number || "").replace(/[^0-9]/g, "")); res.send(page(`<h1 style="font-size:40px;letter-spacing:5px">CODE: ${code}</h1><p>WhatsApp &gt; Appareils lies &gt; Lier avec code</p>`)); }
  catch (e) { res.send(page("Erreur: " + e.message)); }
});
app.get("/pair", async (req, res) => {
  try { res.json({ code: await pair(String(req.query.number || "").replace(/[^0-9]/g, "")) }); }
  catch (e) { res.json({ error: e.message }); }
});
app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("WEB PAIR sur le port " + PORT));
export { setSock, setCode };
