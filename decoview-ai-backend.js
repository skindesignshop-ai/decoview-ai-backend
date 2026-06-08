/**
 * ============================================================
 *  DecoView AI - Backend para Gemini (Nano Banana)  v6
 *  decodesign studio pro
 * ============================================================
 *  v6: DOS MODOS en un solo backend.
 *      mode = "exacto"      -> pone SOLO los muebles dados (Con mis muebles)
 *      mode = "inspiracion" -> ambienta y propone decoracion (Ideas)
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(cors({ origin: "*" }));

const API_KEY = process.env.GEMINI_API_KEY;

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

  const userPrompt = prompt
    ? ("Indicacion de ubicacion del cliente (respetala): " + prompt)
    : "";

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

app.get("/", (_req, res) => res.send("DecoView AI backend OK (v6)"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DecoView AI backend v6 escuchando en el puerto ${PORT}`));
