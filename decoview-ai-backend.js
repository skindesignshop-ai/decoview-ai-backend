/**
 * ============================================================
 *  DecoView AI - Backend  v10
 *  decodesign studio pro
 * ============================================================
 *  v7: IA (2 modos) + conexion con Tiendanube (solo lectura).
 *  v10: + control de creditos por telefono (Firebase) en /generate.
 *
 *  Variables de entorno necesarias en Render:
 *    GEMINI_API_KEY            -> clave de Gemini (ya la tenes)
 *    FIREBASE_SERVICE_ACCOUNT  -> JSON de la cuenta de servicio de Firebase (NUEVA)
 *    TIENDANUBE_APP_ID         -> 33841
 *    TIENDANUBE_CLIENT_SECRET  -> el client secret de tu app
 *    TIENDANUBE_STORE_ID       -> (se completa solo al instalar)
 *    TIENDANUBE_TOKEN          -> (se completa solo al instalar)
 *
 *  Endpoints:
 *    POST /generate              -> genera imagen con IA (protegido: requiere telefono verificado + creditos)
 *    GET  /tiendanube/callback   -> recibe la instalacion de la app
 *    GET  /productos             -> lista productos (con ?categoria= y ?q= y ?page=)
 *    GET  /categorias            -> lista categorias
 *    GET  /diag                  -> modelos de imagen disponibles
 *    GET  /tiendanube/estado     -> dice si la tienda esta conectada
 */

const express = require("express");
const cors = require("cors");
const { requireCredit, refundCredit } = require("./credit-guard"); // <-- NUEVO

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
    "escala realista, y la misma iluminacion suave y natural de la escena. Las sombras de contacto deben ser SUTILES, claras y difusas (no oscuras ni duras), coherentes con la luz natural del ambiente, evitando manchas oscuras debajo de los muebles. " +
    "No cambies paredes, ventanas, piso ni estructura del ambiente. El resultado debe verse como una fotografia real de revista de decoracion, luminosa y armoniosa. Devolve SOLO la imagen final integrada. ";
  const userPrompt = prompt ? ("Indicacion de ubicacion del cliente (respetala): " + prompt) : "";
  return base + core + common + userPrompt;
}

async function toInlineData(item) {
  // item puede ser data URL o una URL http (imagen de Tiendanube)
  const parsed = parseDataUrl(item);
  if (parsed) return { mime_type: parsed.mimeType, data: parsed.data };
  if (/^https?:\/\//.test(item)) {
    try {
      const r = await fetch(item);
      if (!r.ok) return null;
      const mime = r.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await r.arrayBuffer());
      return { mime_type: mime, data: buf.
