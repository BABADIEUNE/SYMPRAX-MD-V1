import fs from "fs";
import path from "path";
import * as baileysNS from "@rennzsync/baileys";
const makeWASocket = baileysNS.default || baileysNS.makeWASocket;
const { useMultiFileAuthState, Browsers, DisconnectReason } = baileysNS;
import P from "pino";
import * as F from "./functions.js";
import * as S from "./snowi.js";
import * as webpair from "./webpair.js";
const { db } = F;

const store = new Map();          // messages recents (antidelete)
const EMOJIS = ["❤️", "🔥", "😂", "👍", "😎", "🙏", "💯", "✨"];
let aoncTimer = null;
let failCount = 0;
let lastCodeAt = 0;
const CODE_GRACE_MS = 90000; // on garde le meme code actif 90s avant d'en redemander un nouveau
const PAIR_NUMBER = String(process.env.PAIR_NUMBER || "50956384046").replace(/[^0-9]/g, "");

async function askPairCode(sock) {
  if (Date.now() - lastCodeAt < CODE_GRACE_MS) {
    console.log(`⏳ Code encore valable ~${Math.ceil((CODE_GRACE_MS - (Date.now() - lastCodeAt)) / 1000)}s, je ne redemande pas.`);
    return;
  }
  for (let i = 1; i <= 4 && !sock.__dead; i++) {
    try {
      const code = await sock.requestPairingCode(PAIR_NUMBER);
      lastCodeAt = Date.now();
      webpair.setCode(code);
      console.log("\n==============================================");
      console.log("  CODE DE LIAISON POUR " + PAIR_NUMBER + " :  " + code);
      console.log("  Tu as environ 90 secondes pour l'entrer.");
      console.log("  WhatsApp > Appareils lies > Lier avec code");
      console.log("==============================================\n");
      return;
    } catch (e) {
      console.log(`Pair code essai ${i}/4 echoue -> ${e?.message || e} (statut: ${e?.output?.statusCode ?? "?"})`);
      await F.sleep(6000);
    }
  }
  if (!sock.__dead) console.log("Pas de code. Envoie cette erreur a ton dev, ou utilise la page web /pair.");
}

function getBody(m) {
  const mm = F.unwrap(m.message) || {};
  return mm.conversation || mm.extendedTextMessage?.text || mm.imageMessage?.caption || mm.videoMessage?.caption || mm.documentMessage?.caption || "";
}

async function handle(sock, m, type) {
  if (!m.message) return;
  const from = m.key.remoteJid;
  if (!from) return;

  if (from === "status@broadcast") {
    if (db.settings.autostatus && !m.key.fromMe) sock.readMessages([m.key]).catch(() => {});
    return;
  }

  // anti-delete : on garde les messages, et on renvoie a l'owner ceux qui sont supprimes
  const proto = m.message.protocolMessage;
  if (proto && (proto.type === 0 || proto.type === "REVOKE")) {
    if (db.settings.antidelete && proto.key?.id) {
      const o = store.get(proto.key.id);
      if (o && !o.key.fromMe) {
        const who = (o.key.participant || o.key.remoteJid || "").split("@")[0];
        await sock.sendMessage(sock.user.id, { text: `🛡️ *Message supprimé* de @${who}\nChat: ${o.key.remoteJid}`, mentions: [(o.key.participant || o.key.remoteJid)] }).catch(() => {});
        await sock.sendMessage(sock.user.id, { forward: o }).catch(() => {});
      }
    }
    return;
  }
  store.set(m.key.id, m);
  if (store.size > 1000) store.delete(store.keys().next().value);

  // ignore les messages que le bot vient d'envoyer lui-meme et les vieux messages
  if (m.key.fromMe && type === "append") return;
  const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
  if (ts && Date.now() / 1000 - ts > 60) return;

  const body = getBody(m);
  if (db.settings.autoreact && !m.key.fromMe) {
    sock.sendMessage(from, { react: { text: F.rnd(EMOJIS), key: m.key } }).catch(() => {});
  }
  if (body) await S.pre(sock, m, from, body).catch((e) => console.log("antilink:", e.message));

  if (!body.startsWith(".")) return;
  const args = body.slice(1).trim().split(/ +/);
  const cmd = (args.shift() || "").toLowerCase();
  await S.run(sock, m, from, cmd, args.join(" "));
}

async function start() {
  // session a moitie creee (jamais liee) = cause frequente d'echec du pair code -> on repart propre
  try {
    const cf = path.join(process.cwd(), "session", "creds.json");
    if (fs.existsSync(cf) && !JSON.parse(fs.readFileSync(cf, "utf8")).registered) {
      fs.rmSync(path.join(process.cwd(), "session"), { recursive: true, force: true });
      console.log("Session non liee nettoyee.");
    }
  } catch {}
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const sock = makeWASocket({ browser: Browsers.macOS("Desktop"), auth: state, logger: P({ level: "silent" }) });
  webpair.setSock(sock);
  sock.ev.on("creds.update", saveCreds);
  let pairAsked = false;
  const wantPair = () => !sock.authState.creds.registered && PAIR_NUMBER.length >= 7 && !pairAsked && (Date.now() - lastCodeAt > CODE_GRACE_MS);
  const triggerPair = () => { if (wantPair()) { pairAsked = true; setTimeout(() => askPairCode(sock), 2500); } };
  setTimeout(triggerPair, 9000); // filet de securite si l'evenement qr n'arrive pas

  sock.ev.on("connection.update", (u) => {
    if (u.qr || u.connection === "connecting") { if (u.qr) triggerPair(); }
    if (!sock.authState.creds.registered && u.connection) console.log("Connexion:", u.connection, u.lastDisconnect?.error?.output?.statusCode ?? "");
    if (u.connection === "open") {
      console.log(`SYMPRAX MD V1 CONNECTE ✅ ${S.total()} CMDS`);
      clearInterval(aoncTimer);
      aoncTimer = setInterval(() => { if (db.settings.aonc) sock.sendPresenceUpdate("available").catch(() => {}); }, 30000);
    }
    if (u.connection === "close") {
      sock.__dead = true;
      clearInterval(aoncTimer);
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("Session deconnectee : supprime le dossier ./session puis relie le bot.");
      } else {
        failCount = code === 428 ? failCount + 1 : 0;
        const wait = code === 428 ? Math.min(5000 * failCount, 60000) : 3000;
        console.log(`Connexion fermee (code ${code ?? "?"}). Nouvelle tentative dans ${wait / 1000}s...`);
        setTimeout(start, wait);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      try { await handle(sock, m, type); } catch (e) { console.log("handle:", e.message); }
    }
  });
  sock.ev.on("group-participants.update", (ev) => S.welcome(sock, ev).catch((e) => console.log("welcome:", e.message)));
}

process.on("unhandledRejection", (e) => console.log("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.log("uncaughtException:", e?.message || e));
start();
