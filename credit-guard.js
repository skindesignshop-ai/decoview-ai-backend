// =============================================================================
//  credit-guard.js  —  Protección de /generate para decoview-ai-backend (Node)
// -----------------------------------------------------------------------------
//  Qué hace:
//   1. Exige que el pedido venga de un usuario con teléfono verificado por
//      Firebase (SMS). Si no, lo rechaza ANTES de llamar a Gemini.
//   2. Lleva la cuenta de cuántas generaciones gratis le quedan a cada teléfono
//      (por defecto 3) en Firestore, y descuenta 1 por generación.
//   3. Si el teléfono se quedó sin créditos, rechaza el pedido (no gasta Gemini).
//
//  Cómo se usa (en tu decoview-ai-backend.js):
//      const { requireCredit, refundCredit } = require("./credit-guard");
//      app.post("/generate", requireCredit, async (req, res) => {
//          ... tu código actual que llama a Gemini ...
//      });
//
//  Requisitos:
//   - npm install firebase-admin
//   - Variable de entorno en Render: FIREBASE_SERVICE_ACCOUNT
//     (el JSON completo de la cuenta de servicio, en una sola línea)
// =============================================================================

const admin = require("firebase-admin");

// ---- Inicialización de Firebase Admin (una sola vez) ------------------------
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

// Cuántas generaciones gratis tiene cada teléfono.
const FREE_CREDITS = 3;

// -----------------------------------------------------------------------------
//  Middleware principal: verifica identidad y descuenta 1 crédito de forma
//  atómica (segura aunque lleguen dos pedidos al mismo tiempo).
// -----------------------------------------------------------------------------
async function requireCredit(req, res, next) {
  try {
    // 1) Leer el token "Bearer <idToken>" del header Authorization
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      return res
        .status(401)
        .json({ error: "No autenticado. Verificá tu teléfono para generar." });
    }

    // 2) Verificar el token con Firebase (que sea real y no esté vencido)
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(match[1]);
    } catch (e) {
      return res
        .status(401)
        .json({ error: "Sesión inválida o vencida. Volvé a verificar tu teléfono." });
    }

    const phone = decoded.phone_number;
    if (!phone) {
      return res
        .status(403)
        .json({ error: "Tu cuenta no tiene un teléfono verificado." });
    }

    // 3) Descontar 1 crédito de forma atómica. Clave = número de teléfono,
    //    así el límite es por teléfono real (no por cuenta).
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
      // 402 = "Payment Required": se quedó sin créditos gratis.
      return res
        .status(402)
        .json({ error: "Te quedaste sin generaciones gratis.", restantes: 0 });
    }

    // 4) Dejar los datos disponibles para el endpoint y avisar al frontend.
    req.usuario = { telefono: phone, creditosRestantes: result.restantes };
    res.setHeader("X-Creditos-Restantes", String(result.restantes));
    next();
  } catch (err) {
    console.error("[credit-guard] error:", err);
    res.status(500).json({ error: "Error de verificación." });
  }
}

// -----------------------------------------------------------------------------
//  (Opcional pero recomendado) Devolver el crédito si Gemini falla.
//  Úsalo en el catch de tu /generate para no cobrarle al usuario una
//  generación que nunca recibió:
//      } catch (e) {
//          await refundCredit(req);   // le devolvemos el crédito
//          res.status(500).json({ error: "No se pudo generar, intentá de nuevo." });
//      }
// -----------------------------------------------------------------------------
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
