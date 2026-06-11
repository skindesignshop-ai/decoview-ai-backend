
// =============================================================================
//  credit-guard.js  —  Proteccion de /generate para decoview-ai-backend (Node)
// =============================================================================

const admin = require("firebase-admin");

// ---- Inicializacion de Firebase Admin (una sola vez) ------------------------
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT (el JSON de la cuenta de servicio de Firebase)."
    );
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

const db = admin.firestore();

// Cuantas generaciones gratis tiene cada telefono.
const FREE_CREDITS = 3;

// Middleware: verifica identidad y descuenta 1 credito de forma atomica.
async function requireCredit(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      return res
        .status(401)
        .json({ error: "No autenticado. Verifica tu telefono para generar." });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(match[1]);
    } catch (e) {
      return res
        .status(401)
        .json({ error: "Sesion invalida o vencida. Volve a verificar tu telefono." });
    }

    const phone = decoded.phone_number;
    if (!phone) {
      return res
        .status(403)
        .json({ error: "Tu cuenta no tiene un telefono verificado." });
    }

    const ref = db.collection("creditos").doc(phone);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      let restantes = snap.exists ? snap.data().restantes : FREE_CREDITS;
      if (restantes <= 0) {
        return { ok: false, restantes: 0 };
      }
      restantes -= 1;
      tx.set(
        ref,
        {
          telefono: phone,
          restantes: restantes,
          ultimoUso: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { ok: true, restantes: restantes };
    });

    if (!result.ok) {
      return res
        .status(402)
        .json({ error: "Te quedaste sin generaciones gratis.", restantes: 0 });
    }

    req.usuario = { telefono: phone, creditosRestantes: result.restantes };
    res.setHeader("X-Creditos-Restantes", String(result.restantes));
    next();
  } catch (err) {
    console.error("[credit-guard] error:", err);
    res.status(500).json({ error: "Error de verificacion." });
  }
}

// Devuelve el credito si Gemini falla (para no cobrar una imagen no entregada).
async function refundCredit(req) {
  try {
    const phone = req.usuario && req.usuario.telefono;
    if (!phone) return;
    const ref = db.collection("creditos").doc(phone);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const restantes = (snap.exists ? snap.data().restantes : 0) + 1;
      tx.set(ref, { telefono: phone, restantes }, { merge: true });
    });
  } catch (e) {
    console.error("[credit-guard] refund error:", e);
  }
}

module.exports = { requireCredit, refundCredit, db, admin, FREE_CREDITS };
