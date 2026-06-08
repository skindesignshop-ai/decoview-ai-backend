/**
 * DecoView AI — Backend para Gemini (Nano Banana 2)
 * decodesign studio pro
 */

const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: "*" }));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.1-flash-image";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function parseDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

app.post("/generate", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "Falta GEMINI_API_KEY en el servidor." });
    }

    const { room, product, prompt } = req.body || {};
    const roomImg = parseDataUrl(room);
    if (!roomImg) {
      return res.status(400).json({ error: "Falta la foto del ambiente (room)." });
    }
    const productImg = parseDataUrl(product);

    const instruction =
      "Sos un motor de edicion de imagenes de interiorismo. " +
      "Tomá la PRIMERA imagen (la foto del ambiente real) y colocá dentro, " +
      "de forma fotorrealista, el mueble que aparece en la SEGUNDA imagen. " +
      "Integralo apoyado en el piso, con la perspectiva correcta del ambiente, " +
      "escala realista, la misma iluminacion de la escena y una sombra de contacto natural. " +
      "No modifiques las paredes, ventanas ni la estructura del ambiente. " +
      "Quitá cualquier fondo del mueble (no debe quedar ningun recuadro blanco). " +
      "Devolvé solo la imagen final integrada. " +
      (prompt ? ("Indicacion adicional del cliente: " + prompt) : "");

    const parts = [{ text: instruction }];
    parts.push({ inline_data: { mime_type: roomImg.mimeType, data: roomImg.data } });
    if (productImg) {
      parts.push({ inline_data: { mime_type: productImg.mimeType, data: productImg.data } });
    }

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE"] },
    };

    const gemResp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!gemResp.ok) {
      const errText = await gemResp.text();
      console.error("Gemini error:", gemResp.status, errText);
      return res.status(502).json({ error: "Error de Gemini", detail: errText });
    }

    const data = await gemResp.json();

    const partsOut =
      (data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) ||
      [];

    let imagePart = null;
    for (const p of partsOut) {
      const inl = p.inline_data || p.inlineData;
      if (inl && inl.data) {
        imagePart = inl;
        break;
      }
    }

    if (!imagePart) {
      return res.status(502).json({ error: "Gemini no devolvio imagen.", raw: data });
    }

    const mime = imagePart.mime_type || imagePart.mimeType || "image/png";
    const dataUrl = `data:${mime};base64,${imagePart.data}`;

    return res.json({ image: dataUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error interno", detail: String(err) });
  }
});

app.get("/", (_req, res) => res.send("DecoView AI backend OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`DecoView AI backend escuchando en el puerto ${PORT}`);
});
