/**
 * DecoView AI - Backend para Gemini (Nano Banana 2)  v2
 * decodesign studio pro
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: "*" }));

const API_KEY = process.env.GEMINI_API_KEY;

const MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
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

async function callModel(model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
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

app.post("/generate", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en el servidor." });

    const { room, product, prompt } = req.body || {};
    const roomImg = parseDataUrl(room);
    if (!roomImg) return res.status(400).json({ error: "Falta la foto del ambiente." });
    const productImg = parseDataUrl(product);

    const instruction =
      "Sos un motor de edicion de imagenes de interiorismo fotorrealista. " +
      "Toma la PRIMERA imagen (la foto real del ambiente) y agrega dentro, de forma realista, " +
      "el mueble que aparece en la SEGUNDA imagen. Recorta el mueble de su fondo (que no quede ningun recuadro ni fondo blanco), " +
      "apoyalo en el piso con la perspectiva correcta del ambiente, escala realista, la misma iluminacion de la escena y sombra de contacto natural. " +
      "No cambies las paredes, ventanas ni la estructura del ambiente. Devolve la imagen final integrada. " +
      (prompt ? ("Indicacion del cliente: " + prompt) : "");

    const parts = [{ text: instruction }];
    parts.push({ inline_data: { mime_type: roomImg.mimeType, data: roomImg.data } });
    if (productImg) parts.push({ inline_data: { mime_type: productImg.mimeType, data: productImg.data } });

    const attempts = [];
    for (const model of MODELS) {
      let r;
      try { r = await callModel(model, parts); }
      catch (e) { attempts.push({ model, error: String(e) }); continue; }

      if (r.ok && r.json) {
        const img = findImage(r.json);
        if (img) return res.json({ image: img, model });
        attempts.push({ model, status: r.status, note: "respondio sin imagen", sample: r.text.slice(0, 300) });
      } else {
        attempts.push({ model, status: r.status, sample: r.text.slice(0, 300) });
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
    const image = all.filter((n) => /image/i.test(n));
    res.json({ ok: r.ok, total: all.length, modelos_de_imagen: image, todos: all });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.send("DecoView AI backend OK (v2)"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DecoView AI backend v2 escuchando en el puerto ${PORT}`));
