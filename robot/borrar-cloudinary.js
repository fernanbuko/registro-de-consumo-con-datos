/* ---------------------------------------------------------
   Robot de borrado seguro en Cloudinary (GitHub Actions)

   Borrar un archivo de Cloudinary de verdad requiere la clave secreta de
   la cuenta, que nunca debe estar en el código del navegador (cualquiera
   podría verla y borrar o cambiar cualquier archivo de la cuenta). Por
   eso la app nunca borra nada directo: cuando se quita una foto o se
   elimina la cuenta, deja una "solicitud" guardada en
   usuarios/{uid}/cloudinariaPendientes, y este robot —que sí corre con
   esa clave secreta de forma segura en GitHub Actions— la procesa.

   No manda notificaciones ni hace nada más: su único trabajo es este.
----------------------------------------------------------*/

const admin = require("firebase-admin");

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("Falta el secreto FIREBASE_SERVICE_ACCOUNT_JSON.");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log(`✅ Llave de servicio leída correctamente para el proyecto: ${serviceAccount.project_id}`);

const CLOUDINARY_CLOUD_NAME = "zcuh5bjn";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
// Debe ser el mismo valor que CLOUDINARY_APP_NOMBRE en index.html — es la
// carpeta raíz, dentro de la cuenta de Cloudinary, donde viven TODOS los
// usuarios de esta app (cada uno en su propia subcarpeta "{uid}_{nombre}").
const CLOUDINARY_APP_NOMBRE = "registro-consumo-electrico";
const cloudinaryBorrarListo = !!(CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
if (!cloudinaryBorrarListo) {
  console.log("ℹ️ CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET no configurados todavía — las solicitudes de borrado quedan pendientes sin procesar.");
}

// Saca el "public_id" y el tipo de recurso (image/video/raw) de una URL
// como https://res.cloudinary.com/<cuenta>/image/upload/v169.../carpeta/archivo.jpg
// — son los datos que pide la API de Cloudinary para borrar un archivo.
function datosCloudinaryDesdeUrl(url) {
  const m = String(url || "").match(/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  if (!m) return null;
  return { resourceType: m[1], publicId: decodeURIComponent(m[2]) };
}

function encabezadoCloudinary() {
  return { Authorization: `Basic ${Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64")}` };
}

async function borrarDeCloudinary(publicIds, resourceType) {
  const params = new URLSearchParams();
  publicIds.forEach(id => params.append("public_ids[]", id));
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/${resourceType}/upload?${params}`,
    { method: "DELETE", headers: encabezadoCloudinary() }
  );
  if (!res.ok) throw new Error(`Cloudinary respondió ${res.status}`);
  return res.json();
}

// Busca (con la API de búsqueda de Cloudinary, filtrando por asset_folder
// EXACTO — sin recursividad) y borra por public_id todo lo que esté
// asignado directamente a esa carpeta puntual (sin bajar a subcarpetas).
// Como esta app sube los archivos con "asset_folder" (carpetas dinámicas
// de Cloudinary, donde el nombre de la carpeta es un dato aparte del
// public_id, no necesariamente un prefijo de texto), no alcanza con
// "borrar por prefijo" como en apps más simples: primero se BUSCA qué
// archivos están de verdad ahí y recién entonces se borran, por su
// public_id exacto — así, si por lo que sea la búsqueda no encuentra nada,
// simplemente no se borra nada (nunca borra "a ciegas" por texto).
async function borrarArchivosDeUnaCarpeta(carpeta) {
  const porTipo = {};
  let cursor;
  do {
    const body = { expression: `asset_folder:"${carpeta}"`, max_results: 500 };
    if (cursor) body.next_cursor = cursor;
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/search`, {
      method: "POST",
      headers: { ...encabezadoCloudinary(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Cloudinary (búsqueda de carpeta) respondió ${res.status}`);
    const data = await res.json();
    for (const recurso of data.resources || []) {
      if (!porTipo[recurso.resource_type]) porTipo[recurso.resource_type] = [];
      porTipo[recurso.resource_type].push(recurso.public_id);
    }
    cursor = data.next_cursor;
  } while (cursor);

  let totalBorrados = 0;
  for (const [resourceType, ids] of Object.entries(porTipo)) {
    for (let i = 0; i < ids.length; i += 100) {
      await borrarDeCloudinary(ids.slice(i, i + 100), resourceType);
      totalBorrados += Math.min(100, ids.length - i);
    }
  }
  return totalBorrados;
}

// Lista las subcarpetas DIRECTAS (no recursivo) de una carpeta de
// Cloudinary. 404 significa que la carpeta ya no existe (o nunca existió)
// — se trata como "sin subcarpetas", no como error.
async function listarSubcarpetas(carpeta) {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/folders/${carpeta.split("/").map(encodeURIComponent).join("/")}`, {
    headers: encabezadoCloudinary(),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Cloudinary (listar subcarpetas) respondió ${res.status}`);
  const data = await res.json();
  return (data.folders || []).map(f => f.path);
}

// Borra la carpeta (el "contenedor" en sí, ya sin archivos adentro) de
// Cloudinary. Las carpetas dinámicas de Cloudinary son una entidad aparte
// de los archivos: aunque ya no quede ningún archivo adentro, la carpeta
// vacía se queda dando vueltas en la Media Library hasta que se borra
// explícitamente. 404 = ya no existe, no es un error.
async function borrarCarpetaVacia(carpeta) {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/folders/${carpeta.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
    headers: encabezadoCloudinary(),
  });
  if (!res.ok && res.status !== 404) {
    console.error(`No se pudo borrar la carpeta vacía "${carpeta}" de Cloudinary: ${res.status}`);
  }
}

// Borra TODO lo que haya adentro de una carpeta, bajando también por sus
// subcarpetas (año/mes/facturas) — primero borra los archivos de cada
// nivel (más profundo primero), y recién con todo vacío borra las
// carpetas mismas, así no queda ninguna carpeta vacía dando vueltas.
async function borrarCarpetaDeCloudinary(carpeta) {
  const subcarpetas = await listarSubcarpetas(carpeta);
  let totalBorrados = await borrarArchivosDeUnaCarpeta(carpeta);
  for (const sub of subcarpetas) {
    totalBorrados += await borrarCarpetaDeCloudinary(sub);
  }
  await borrarCarpetaVacia(carpeta);
  return totalBorrados;
}

// Se usa SOLO al eliminar la cuenta por completo: un mismo usuario puede
// tener varios "perfiles" (varias propiedades/medidores), cada uno en su
// propia carpeta de Cloudinary (registro-consumo-electrico/{uid}_{nombre
// del perfil}) — como el nombre de cada perfil varía, no hay una única
// carpeta fija que borrar. En vez de adivinar los nombres, se listan de
// verdad las carpetas que existen directo bajo la raíz de la app y se
// borra cada una cuyo nombre empiece con "{uid}_" (nunca se borra nada
// que no calce exacto con ese prefijo del propio usuario).
async function borrarCarpetasDeCuenta(uid) {
  const prefijo = `${uid}_`;
  const carpetas = await listarSubcarpetas(CLOUDINARY_APP_NOMBRE);
  let totalBorrados = 0;
  for (const carpeta of carpetas) {
    const nombreCarpeta = carpeta.slice(CLOUDINARY_APP_NOMBRE.length + 1);
    if (nombreCarpeta.startsWith(prefijo)) {
      totalBorrados += await borrarCarpetaDeCloudinary(carpeta);
    }
  }
  return totalBorrados;
}

// Revisa la cola de un usuario (usuarios/{uid}/cloudinariaPendientes) y
// procesa cada solicitud: si trae "url", borra ESE archivo; si trae
// "borrarCuenta", borra TODAS las carpetas de ese usuario (solo pasa al
// eliminar la cuenta por completo). Si no hay clave de Cloudinary
// configurada todavía, deja las solicitudes pendientes — no se pierden,
// solo esperan.
async function procesarPendientesDeUsuario(usuarioRef) {
  if (!cloudinaryBorrarListo) return;
  let snap;
  try {
    snap = await usuarioRef.collection("cloudinariaPendientes").get();
  } catch (e) {
    return; // la colección puede no existir todavía para este usuario, no es un error
  }
  if (snap.empty) return;

  const porTipo = {};
  const borrarCuentaDocs = [];
  for (const doc of snap.docs) {
    const { url, borrarCuenta } = doc.data();
    if (borrarCuenta) {
      borrarCuentaDocs.push(doc.ref);
      continue;
    }
    const datos = datosCloudinaryDesdeUrl(url);
    if (!datos) {
      // URL rara/no reconocida: no se puede borrar sola, se descarta la
      // solicitud para no quedar reintentando para siempre.
      await doc.ref.delete().catch(() => {});
      continue;
    }
    if (!porTipo[datos.resourceType]) porTipo[datos.resourceType] = [];
    porTipo[datos.resourceType].push({ ref: doc.ref, publicId: datos.publicId });
  }

  for (const [resourceType, items] of Object.entries(porTipo)) {
    try {
      await borrarDeCloudinary(items.map(it => it.publicId), resourceType);
      await Promise.all(items.map(it => it.ref.delete()));
      console.log(`   🗑 [${usuarioRef.id}] ${items.length} archivo(s) borrados de Cloudinary (${resourceType}).`);
    } catch (e) {
      console.error(`   ❌ [${usuarioRef.id}] Error borrando de Cloudinary (${resourceType}):`, e.message);
    }
  }

  for (const ref of borrarCuentaDocs) {
    try {
      const cuantos = await borrarCarpetasDeCuenta(usuarioRef.id);
      await ref.delete();
      console.log(`   🗑 [${usuarioRef.id}] Cuenta eliminada: todas sus carpetas borradas de Cloudinary (${cuantos} archivo(s)).`);
    } catch (e) {
      console.error(`   ❌ [${usuarioRef.id}] Error borrando las carpetas de la cuenta de Cloudinary:`, e.message);
    }
  }
}

async function main() {
  if (!cloudinaryBorrarListo) return;
  const usuarios = await db.collection("usuarios").listDocuments();
  console.log(`Revisando solicitudes de borrado de Cloudinary en ${usuarios.length} cuenta(s)...`);
  for (const usuarioRef of usuarios) {
    await procesarPendientesDeUsuario(usuarioRef);
  }
  console.log("Listo.");
}

main().catch(e => {
  console.error("Error general del robot:", e);
  process.exit(1);
});
