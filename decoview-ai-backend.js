/**
 * ============================================================
 *  DecoView AI - Backend  v7
 *  decodesign studio pro
 * ============================================================
 *  v7: IA (2 modos) + conexion con Tiendanube (solo lectura).
 *
 *  Variables de entorno necesarias en Render:
 *    GEMINI_API_KEY          -> clave de Gemini (ya la tenes)
 *    TIENDANUBE_APP_ID       -> 33841
 *    TIENDANUBE_CLIENT_SECRET-> el client secret de tu app
 *    TIENDANUBE_STORE_ID     -> (se completa solo al instalar)
 *    TIENDANUBE_TOKEN        -> (se completa solo al instalar)
 *
 *  Endpoints:
 *    POST /generate              -> genera imagen con IA (modos exacto/inspiracion)
 *    GET  /tiendanube/callback   -> recibe la instalacion de la app
 *    GET  /productos             -> lista productos (con ?categoria= y ?q= y ?page=)
 *    GET  /categorias            -> lista categorias
 *    GET  /diag                  -> modelos de imagen disponibles
 *    GET  /tiendanube/estado     -> dice si la tienda esta conectada
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(cors({ origin: "*" }));

const API_KEY = process.env.GEMINI_API_KEY;

// ---- Tiendanube ----
const TN_APP_ID = process.env.TIENDANUBE_APP_ID;
const TN_SECRET = process.env.TIENDANUBE_CLIENT_SECRET;
// Estos dos se obtienen al instalar la app. Se pueden fijar luego como env vars.
let TN_STORE_ID = process.env.TIENDANUBE_STORE_ID || null;
let TN_TOKEN = process.env.TIENDANUBE_TOKEN || null;
const TN_API = "https://api.tiendanube.com/v1";
const TN_UA = "DecoView Visualizador (decodesign)";

// ============================================================
//  GEMINI (igual que v6)
// ============================================================
const MODELS = [
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
];
const CONFIGS = [
  null,
  { responseModalities: ["TEXT", "IMAGE"] },
  { responseModalities: ["IMAGE"] },
];

function parseDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function findImage(data) {
  const parts =
    (data && data.candidates && data.candidates[0] &&
     data.candidates[0].content && data.candidates[0].content.parts) || [];
  for (const p of parts) {
    const inl = p.inline_data || p.inlineData;
    if (inl && inl.data) {
      const mime = inl.mime_type || inl.mimeType || "image/png";
      return `data:${mime};base64,${inl.data}`;
    }
  }
  return null;
}

async function callModel(model, parts, genConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = { contents: [{ role: "user", parts }] };
  if (genConfig) body.generationConfig = genConfig;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, json, text };
}

function buildInstruction(mode, count, prompt) {
  const varios = count > 1;
  const base =
    "Sos un motor de edicion de imagenes de interiorismo fotorrealista. " +
    "Toma la PRIMERA imagen (la foto real del ambiente). ";
  let core;
  if (mode === "inspiracion") {
    core =
      "Agrega dentro " +
      (varios
        ? ("los " + count + " muebles que aparecen en las imagenes siguientes ")
        : "el mueble que aparece en la SEGUNDA imagen ") +
      "y, ademas, AMBIENTA el espacio como un disenador de interiores profesional: " +
      "podes sumar decoracion complementaria sutil y armoniosa (alfombra, planta, iluminacion, cuadros, textiles) " +
      "que combine con el estilo, para mostrar una propuesta de decoracion completa e inspiradora. ";
  } else {
    core =
      "Agrega dentro, de forma realista, " +
      (varios
        ? ("UNICAMENTE los " + count + " muebles que aparecen en las imagenes siguientes (uno por cada imagen), distribuyendolos de forma armoniosa. ")
        : "UNICAMENTE el mueble que aparece en la SEGUNDA imagen. ") +
      "REGLA IMPORTANTE: NO agregues, inventes ni sumes NINGUN otro mueble, objeto, alfombra, planta, mesa ni decoracion que no este en las imagenes provistas. " +
      "Coloca exactamente los muebles dados, ni mas ni menos. ";
  }
  const common =
    "Recorta cada mueble de su fondo (sin recuadro ni fondo blanco), apoyalos en el piso con la perspectiva correcta del ambiente, " +
    "escala realista, la misma iluminacion de la escena y sombra de contacto natural. " +
    "No cambies paredes, ventanas, piso ni estructura del ambiente. Devolve SOLO la imagen final integrada. ";
  const userPrompt = prompt ? ("Indicacion de ubicacion del cliente (respetala): " + prompt) : "";
  return base + core + common + userPrompt;
}

app.post("/generate", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });
    const body = req.body || {};
    const room = body.room;
    const mode = body.mode === "inspiracion" ? "inspiracion" : "exacto";
    let products = Array.isArray(body.products) ? body.products : [];
    if (!products.length && body.product) products = [body.product];

    const roomImg = parseDataUrl(room);
    if (!roomImg) return res.status(400).json({ error: "Falta la foto del ambiente." });
    const prodImgs = products.map(parseDataUrl).filter(Boolean);

    const instruction = buildInstruction(mode, prodImgs.length, body.prompt);
    const parts = [{ text: instruction }];
    parts.push({ inline_data: { mime_type: roomImg.mimeType, data: roomImg.data } });
    prodImgs.forEach((p) => parts.push({ inline_data: { mime_type: p.mimeType, data: p.data } }));

    const attempts = [];
    for (const model of MODELS) {
      for (const gc of CONFIGS) {
        let r;
        try { r = await callModel(model, parts, gc); }
        catch (e) { attempts.push({ model, error: String(e) }); continue; }
        if (r.ok && r.json) {
          const img = findImage(r.json);
          if (img) return res.json({ image: img, model, mode });
          attempts.push({ model, gc: gc ? gc.responseModalities.join("+") : "none", status: r.status, note: "sin imagen", sample: r.text.slice(0, 220) });
        } else {
          attempts.push({ model, gc: gc ? gc.responseModalities.join("+") : "none", status: r.status, sample: r.text.slice(0, 220) });
          if (r.status === 404) break;
        }
      }
    }
    return res.status(502).json({ error: "Ningun modelo devolvio imagen.", attempts });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error interno", detail: String(err) });
  }
});

// ============================================================
//  TIENDANUBE
// ============================================================

// Paso de instalacion: Tiendanube redirige aca con ?code=...
app.get("/tiendanube/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Falta el codigo de autorizacion.");
  if (!TN_APP_ID || !TN_SECRET) {
    return res.status(500).send("Faltan TIENDANUBE_APP_ID o TIENDANUBE_CLIENT_SECRET en el servidor.");
  }
  try {
    const r = await fetch("https://www.tiendanube.com/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TN_APP_ID,
        client_secret: TN_SECRET,
        grant_type: "authorization_code",
        code: code,
      }),
    });
    const data = await r.json();
    if (data && data.access_token && data.user_id) {
      TN_TOKEN = data.access_token;
      TN_STORE_ID = String(data.user_id);
      return res.send(
        "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>" +
        "<h2>✅ Tienda conectada</h2>" +
        "<p>DecoView ya puede leer tu catalogo de Tiendanube.</p>" +
        "<p style='color:#888'>Anota estos datos en Render para que la conexion sea permanente:</p>" +
        "<p><b>TIENDANUBE_STORE_ID</b> = " + TN_STORE_ID + "</p>" +
        "<p><b>TIENDANUBE_TOKEN</b> = " + TN_TOKEN + "</p>" +
        "<p style='color:#c00'>(Guardalos en privado y no los compartas.)</p>" +
        "</body></html>"
      );
    }
    return res.status(400).json({ error: "No se pudo autorizar", detail: data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

async function tnFetch(path) {
  if (!TN_STORE_ID || !TN_TOKEN) {
    return { error: "Tienda no conectada. Instala la app primero." };
  }
  const r = await fetch(`${TN_API}/${TN_STORE_ID}${path}`, {
    headers: {
      "Authentication": "bearer " + TN_TOKEN,
      "User-Agent": TN_UA,
      "Content-Type": "application/json",
    },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, json, text };
}

function pickName(name) {
  if (!name) return "";
  if (typeof name === "string") return name;
  return name.es || name.pt || name.en || Object.values(name)[0] || "";
}

// Lista de productos simplificada para el visualizador
app.get("/productos", async (req, res) => {
  const cat = req.query.categoria ? `&category_id=${encodeURIComponent(req.query.categoria)}` : "";
  const q = req.query.q ? `&q=${encodeURIComponent(req.query.q)}` : "";
  const page = req.query.page ? parseInt(req.query.page) : 1;
  const r = await tnFetch(`/products?per_page=30&page=${page}${cat}${q}`);
  if (r.error) return res.status(400).json(r);
  if (!r.ok) return res.status(r.status).json({ error: "Error Tiendanube", detail: r.text.slice(0, 300) });
  const list = (r.json || []).map((p) => ({
    id: p.id,
    nombre: pickName(p.name),
    precio: p.variants && p.variants[0] ? p.variants[0].price : null,
    imagen: p.images && p.images[0] ? p.images[0].src : null,
  })).filter((p) => p.imagen);
  res.json({ productos: list, page });
});

// Lista de categorias
app.get("/categorias", async (_req, res) => {
  const r = await tnFetch(`/categories?per_page=200`);
  if (r.error) return res.status(400).json(r);
  if (!r.ok) return res.status(r.status).json({ error: "Error Tiendanube", detail: r.text.slice(0, 300) });
  const list = (r.json || []).map((c) => ({ id: c.id, nombre: pickName(c.name) }));
  res.json({ categorias: list });
});

app.get("/tiendanube/estado", (_req, res) => {
  res.json({ conectada: !!(TN_STORE_ID && TN_TOKEN), store_id: TN_STORE_ID || null });
});

// ============================================================
app.get("/diag", async (_req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": API_KEY },
    });
    const data = await r.json();
    const all = (data.models || []).map((m) => m.name);
    res.json({ ok: r.ok, modelos_de_imagen: all.filter((n) => /image/i.test(n)) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.send("DecoView AI backend OK (v7) - IA + Tiendanube"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DecoView AI backend v7 escuchando en el puerto ${PORT}`));
